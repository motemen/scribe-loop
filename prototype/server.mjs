// 実機検証用のプロトタイプのサーバー。依存なし（Node の標準モジュールだけ）。
// - public/ の静的ファイルを配信する
// - 端末からのログ（POST /api/log）を日ごとの JSONL に追記する
// - 手書きの操作（POST /api/ops）を文書ごとの JSONL に、opId で重複を除いて追記する
// - 文書の現在のストローク（GET /api/doc）と SVG（GET /render）を返す
//
// 認証はない。LAN の中だけで使うこと。既定では 127.0.0.1 で待ち受けるので、
// 端末から使うときは SCRIBE_LOOP_HOST に LAN 側の IP（または 0.0.0.0）を指定する。

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HOST = process.env.SCRIBE_LOOP_HOST || "127.0.0.1";
const PORT = Number(process.env.SCRIBE_LOOP_PORT || 8470);
const DATA_DIR =
  process.env.SCRIBE_LOOP_DATA_DIR ||
  path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "scribe-loop", "prototype");
// 証明書と鍵を渡すと、HTTP に加えて HTTPS でも待ち受ける。
// pointerrawupdate などは secure context（HTTPS）でしか使えないため。
const TLS_CERT = process.env.SCRIBE_LOOP_TLS_CERT || "";
const TLS_KEY = process.env.SCRIBE_LOOP_TLS_KEY || "";
const TLS_PORT = Number(process.env.SCRIBE_LOOP_TLS_PORT || 8471);
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

const LOG_DIR = path.join(DATA_DIR, "logs");
const DOC_DIR = path.join(DATA_DIR, "docs");
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(DOC_DIR, { recursive: true });

const DOC_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function send(res, status, body, type = "application/json; charset=utf-8") {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(data);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(Object.assign(new Error("invalid json"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---- 文書ごとの操作ログ ----

const docCache = new Map(); // doc -> { seen: Set<opId>, ops: [] }

function docFile(doc) {
  return path.join(DOC_DIR, `${doc}.jsonl`);
}

function loadDoc(doc) {
  let entry = docCache.get(doc);
  if (entry) return entry;
  entry = { seen: new Set(), ops: [] };
  if (fs.existsSync(docFile(doc))) {
    for (const line of fs.readFileSync(docFile(doc), "utf8").split("\n")) {
      if (!line) continue;
      try {
        const op = JSON.parse(line);
        entry.seen.add(op.opId);
        entry.ops.push(op);
      } catch {
        // 壊れた行（書き込み途中で落ちたなど）は読み飛ばす
      }
    }
  }
  docCache.set(doc, entry);
  return entry;
}

function applyOps(ops) {
  const strokes = new Map();
  for (const op of ops) {
    if (op.kind === "add" && op.stroke && op.stroke.id) strokes.set(op.stroke.id, op.stroke);
    else if (op.kind === "del" && Array.isArray(op.ids)) for (const id of op.ids) strokes.delete(id);
    else if (op.kind === "clear") strokes.clear();
  }
  return [...strokes.values()];
}

function renderSvg(strokes) {
  let width = 800;
  let height = 600;
  for (const s of strokes) {
    if (s.surfaceWidth) width = Math.max(width, s.surfaceWidth);
    for (const p of s.points || []) height = Math.max(height, p[1] + 20);
  }
  const paths = strokes
    .filter((s) => (s.points || []).length)
    .map((s) => {
      const d = s.points.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
      return `<path d="${d}" fill="none" stroke="#000" stroke-width="${s.width || 2.5}" stroke-linecap="round" stroke-linejoin="round"/>`;
    })
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(width)}" height="${Math.ceil(height)}" viewBox="0 0 ${Math.ceil(width)} ${Math.ceil(height)}">
<rect width="100%" height="100%" fill="#fff"/>
${paths}
</svg>`;
}

// ---- ハンドラ ----

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;

  if (pathname === "/api/health") return send(res, 200, { ok: true });

  if (pathname === "/api/log" && req.method === "POST") {
    const body = await readBody(req, 512 * 1024);
    const events = Array.isArray(body.events) ? body.events : [];
    const meta = {
      at: new Date().toISOString(),
      client: String(body.client || "").slice(0, 64),
      ua: String(req.headers["user-agent"] || "").slice(0, 300),
    };
    const lines = events.map((e) => JSON.stringify({ ...meta, ...e })).join("\n");
    if (lines) fs.appendFileSync(path.join(LOG_DIR, `${today()}.jsonl`), lines + "\n");
    return send(res, 200, { ok: true, count: events.length });
  }

  if (pathname === "/api/ops" && req.method === "POST") {
    const body = await readBody(req, 4 * 1024 * 1024);
    const doc = String(body.doc || "");
    if (!DOC_ID.test(doc)) return send(res, 400, { error: "invalid doc" });
    const entry = loadDoc(doc);
    const acked = [];
    const fresh = [];
    for (const op of Array.isArray(body.ops) ? body.ops : []) {
      if (!op || typeof op.opId !== "string" || !op.opId) continue;
      acked.push(op.opId);
      if (entry.seen.has(op.opId)) continue; // 再送は受け取ったことにして捨てる
      const stored = { ...op, client: String(body.client || "").slice(0, 64), receivedAt: new Date().toISOString() };
      entry.seen.add(op.opId);
      entry.ops.push(stored);
      fresh.push(JSON.stringify(stored));
    }
    if (fresh.length) fs.appendFileSync(docFile(doc), fresh.join("\n") + "\n");
    return send(res, 200, { acked });
  }

  if (pathname === "/api/doc" && req.method === "GET") {
    const doc = url.searchParams.get("doc") || "";
    if (!DOC_ID.test(doc)) return send(res, 400, { error: "invalid doc" });
    return send(res, 200, { doc, strokes: applyOps(loadDoc(doc).ops) });
  }

  if (pathname === "/render" && req.method === "GET") {
    const doc = url.searchParams.get("doc") || "";
    if (!DOC_ID.test(doc)) return send(res, 400, { error: "invalid doc" });
    return send(res, 200, renderSvg(applyOps(loadDoc(doc).ops)), "image/svg+xml");
  }

  if (req.method === "GET" || req.method === "HEAD") {
    const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, { error: "not found" });
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, { error: "not found" });
      res.writeHead(200, {
        "content-type": TYPES[path.extname(file)] || "application/octet-stream",
        "cache-control": "no-cache",
      });
      res.end(req.method === "HEAD" ? undefined : data);
    });
    return;
  }

  send(res, 404, { error: "not found" });
}

function onRequest(req, res) {
  handle(req, res).catch((err) => {
    if (!res.headersSent) send(res, err.status || 500, { error: err.message });
    if (!err.status) console.error(err);
  });
}

http.createServer(onRequest).listen(PORT, HOST, () => {
  console.log(`scribe-loop prototype: http://${HOST}:${PORT}/ (data: ${DATA_DIR})`);
});

if (TLS_CERT && TLS_KEY) {
  https
    .createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, onRequest)
    .listen(TLS_PORT, HOST, () => {
      console.log(`scribe-loop prototype: https://${HOST}:${TLS_PORT}/`);
    });
}
