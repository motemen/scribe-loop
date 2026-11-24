// scribe-loop のサーバー。依存なし（合成画像だけは任意で playwright-core を使う）。
// 認証はない。LAN の中だけで使うこと。

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Store, isId } from "./store.mjs";
import { wrapDocument, FRAME_CSP } from "./frame.mjs";
import { renderPages, inkSvg, strokesHeight, closeRenderer } from "./render.mjs";
import os from "node:os";
import { config } from "./config.mjs";

const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version || "0.0.0";
const STARTED_AT = new Date().toISOString();

// 同じマシンからのリクエストか（サーバーを止める API は、同じマシンからだけ受け付ける）
function isLocal(req) {
  const addr = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  if (addr === "127.0.0.1" || addr === "::1") return true;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.address === addr) return true;
  }
  return false;
}

const PUBLIC_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "public");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
};

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function send(res, status, body, type = "application/json; charset=utf-8", headers = {}) {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...headers });
  res.end(data);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(httpError(413, "body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(httpError(400, "invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res, rel) {
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, { error: "not found" });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: "not found" });
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(req.method === "HEAD" ? undefined : data);
  });
}

export function createHandler(store, { publicUrl, cfg = {}, onShutdown = () => {} } = {}) {
  // 新しいフィードバックを待っているリクエスト（ロングポーリング）
  const waiters = new Set();
  function notifyWaiters() {
    for (const w of waiters) w();
    waiters.clear();
  }

  function documentUrl(id) {
    return publicUrl ? `${publicUrl.replace(/\/$/, "")}/d/${id}` : `/d/${id}`;
  }

  function requireDoc(id) {
    if (!isId(id) || !store.getDocument(id)) throw httpError(404, "document not found");
    return id;
  }

  function requireFeedback(fid) {
    const fb = isId(fid) && store.findFeedback(fid);
    if (!fb) throw httpError(404, "feedback not found");
    return fb;
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const method = req.method;

    // ---- Kindle 向けのページ ----
    if (method === "GET" && url.pathname === "/") return serveStatic(req, res, "index.html");
    if (method === "GET" && parts[0] === "d" && parts.length === 2) {
      requireDoc(parts[1]);
      return serveStatic(req, res, "reader.html");
    }
    if (method === "GET" && parts[0] === "d" && parts[2] === "frame" && parts.length === 3) {
      const id = requireDoc(parts[1]);
      return send(res, 200, wrapDocument(store.source(id, url.searchParams.get("rev"))), "text/html; charset=utf-8", {
        "content-security-policy": FRAME_CSP,
        "cache-control": "no-cache",
      });
    }

    if (parts[0] !== "api") {
      if (method === "GET" || method === "HEAD") return serveStatic(req, res, parts.join("/"));
      throw httpError(404, "not found");
    }

    // ---- API ----
    const [, resource, id, sub, subId] = parts;

    if (resource === "status" && method === "GET") {
      return send(res, 200, {
        app: "scribe-loop",
        version: VERSION,
        pid: process.pid,
        startedAt: STARTED_AT,
        dataDir: cfg.dataDir,
        host: cfg.host,
        port: cfg.port,
        publicUrl: cfg.publicUrl || null,
      });
    }
    if (resource === "shutdown" && method === "POST") {
      if (!isLocal(req)) throw httpError(403, "shutdown is only allowed from the same machine");
      send(res, 200, { ok: true, pid: process.pid });
      setTimeout(onShutdown, 50);
      return;
    }

    if (resource === "documents") {
      if (!id) {
        if (method === "GET") return send(res, 200, { documents: store.listDocuments() });
        if (method === "POST") {
          const body = await readBody(req, 20 * 1024 * 1024);
          const meta = store.createDocument({
            title: body.title,
            html: body.html,
            parentId: body.parentId || null,
            inReplyTo: body.inReplyTo || null,
          });
          return send(res, 201, { ...meta, url: documentUrl(meta.id) });
        }
      }
      requireDoc(id);
      if (!sub && method === "GET") return send(res, 200, { ...store.summary(id), url: documentUrl(id) });
      if (sub === "source" && method === "GET") return send(res, 200, store.source(id, url.searchParams.get("rev")), "text/html; charset=utf-8");
      if (sub === "settings" && method === "POST") {
        const body = await readBody(req, 16 * 1024);
        const meta = store.setReviseOnSend(id, body.reviseOnSend);
        return send(res, 200, { reviseOnSend: meta.reviseOnSend });
      }
      if (sub === "revisions" && method === "POST") {
        const body = await readBody(req, 20 * 1024 * 1024);
        const meta = store.reviseDocument(id, { html: body.html, title: body.title, feedbackId: body.feedbackId || null });
        return send(res, 200, { ...meta, url: documentUrl(id) });
      }
      if (sub === "read" && method === "POST") {
        store.markRead(id);
        return send(res, 200, { ok: true });
      }
      if (sub === "ink" && method === "GET") return send(res, 200, { strokes: store.strokes(id, url.searchParams.get("rev")) });
      if (sub === "ink" && method === "POST") {
        const body = await readBody(req, 8 * 1024 * 1024);
        const acked = store.appendOps(id, Array.isArray(body.ops) ? body.ops : [], body.client);
        return send(res, 200, { acked });
      }
      if (sub === "feedback" && method === "POST") {
        const body = await readBody(req, 2 * 1024 * 1024);
        const result = store.createFeedback(id, {
          clientRequestId: typeof body.clientRequestId === "string" ? body.clientRequestId.slice(0, 100) : null,
          strokeIds: Array.isArray(body.strokeIds) ? body.strokeIds.map(String) : [],
          surface: body.surface && typeof body.surface === "object" ? body.surface : null,
          client: body.client,
          revision: Number(body.revision) || null,
        });
        if (result.stale) return send(res, 409, { error: "document was revised", revision: result.stale });
        if (result.missing) return send(res, 409, { error: "strokes not received yet", missing: result.missing });
        const fb = result.feedback;
        notifyWaiters();
        return send(res, 201, { id: fb.id, status: fb.status, createdAt: fb.createdAt });
      }
    }

    if (resource === "feedback") {
      // after（ISO 時刻）より新しいフィードバックが届くまで、最大 timeout 秒待つ
      if (id === "wait" && method === "GET") {
        const after = url.searchParams.get("after") || "";
        const timeout = Math.min(120, Math.max(1, Number(url.searchParams.get("timeout")) || 30));
        const fresh = () => store.listFeedback().filter((f) => f.createdAt > after);
        let list = fresh();
        if (!list.length) {
          await new Promise((resolve) => {
            const timer = setTimeout(() => {
              waiters.delete(done);
              resolve();
            }, timeout * 1000);
            const done = () => {
              clearTimeout(timer);
              resolve();
            };
            waiters.add(done);
            req.on("close", () => {
              waiters.delete(done);
              clearTimeout(timer);
              resolve();
            });
          });
          list = fresh();
        }
        return send(res, 200, { feedback: list, now: new Date().toISOString() });
      }
      if (!id && method === "GET") {
        const status = url.searchParams.get("status") || undefined;
        return send(res, 200, { feedback: store.listFeedback({ status }) });
      }
      const fb = requireFeedback(id);
      const doc = store.getDocument(fb.documentId);
      if (!sub && method === "GET") {
        return send(res, 200, { ...fb, document: { ...doc.meta, url: documentUrl(doc.meta.id) } });
      }
      if (!sub && method === "POST") {
        const body = await readBody(req, 64 * 1024);
        const updated = store.updateFeedback(fb.id, { status: body.status, note: body.note });
        return send(res, 200, { id: updated.id, status: updated.status, note: updated.note });
      }
      if (sub === "ink.svg" && method === "GET") {
        const width = (fb.surface && fb.surface.width) || 930;
        return send(res, 200, inkSvg(fb.strokes, width, strokesHeight(fb.strokes) + 40), "image/svg+xml");
      }
      if (sub === "pages" && method === "GET") {
        const outDir = store.feedbackDir(fb.id);
        const pages = await renderPages({ html: store.source(fb.documentId, fb.revision), strokes: fb.strokes, surface: fb.surface, outDir, chrome: cfg.chrome });
        if (!subId) return send(res, 200, { available: !!pages, pages: pages || [] });
        const entry = (pages || []).find((p) => p.file === subId);
        if (!entry) throw httpError(404, "page not found");
        return send(res, 200, fs.readFileSync(path.join(outDir, entry.file)), "image/png");
      }
    }

    throw httpError(404, "not found");
  }

  return (req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) send(res, err.status || 500, { error: err.message });
      if (!err.status) console.error(err);
    });
  };
}

export function startServer(cfg = config()) {
  const store = new Store(cfg.dataDir);
  const servers = [];
  const shutdown = () => {
    console.log("scribe-loop: shutting down");
    for (const s of servers) s.close();
    closeRenderer().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  const handler = createHandler(store, { publicUrl: cfg.publicUrl, cfg, onShutdown: shutdown });
  const label = `http://${cfg.host.includes(":") ? `[${cfg.host}]` : cfg.host}:${cfg.port}/`;
  const listen = (server, port, label) => {
    server.on("error", (err) => {
      // ポートが使われているなど。裏で起動したときは、呼んだ側がログを見て知らせる
      console.error(`scribe-loop: cannot listen on ${label}: ${err.message}`);
      process.exit(1);
    });
    server.listen(port, cfg.host, () => console.log(`scribe-loop: ${label} (pid ${process.pid}, data: ${cfg.dataDir})`));
    servers.push(server);
  };
  listen(http.createServer(handler), cfg.port, cfg.publicUrl ? `${label} (Kindle: ${cfg.publicUrl}/)` : label);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
