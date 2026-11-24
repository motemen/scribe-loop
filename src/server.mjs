// scribe-loop のサーバー。依存なし（合成画像だけは任意で playwright-core を使う）。
// 認証はない。LAN の中だけで使うこと。

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { Store, isId } from "./store.mjs";
import { wrapDocument, FRAME_CSP } from "./frame.mjs";
import { renderPages, inkSvg, strokesHeight } from "./render.mjs";
import { config } from "./config.mjs";

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

export function createHandler(store, { publicUrl } = {}) {
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
      return send(res, 200, wrapDocument(store.source(id)), "text/html; charset=utf-8", {
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

    if (resource === "health") return send(res, 200, { ok: true });

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
      if (sub === "source" && method === "GET") return send(res, 200, store.source(id), "text/html; charset=utf-8");
      if (sub === "read" && method === "POST") {
        store.markRead(id);
        return send(res, 200, { ok: true });
      }
      if (sub === "ink" && method === "GET") return send(res, 200, { strokes: store.strokes(id) });
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
        });
        if (result.missing) return send(res, 409, { error: "strokes not received yet", missing: result.missing });
        const fb = result.feedback;
        return send(res, 201, { id: fb.id, status: fb.status, createdAt: fb.createdAt });
      }
    }

    if (resource === "feedback") {
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
        const pages = await renderPages({ html: store.source(fb.documentId), strokes: fb.strokes, surface: fb.surface, outDir });
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
  const handler = createHandler(store, { publicUrl: cfg.publicUrl });
  http.createServer(handler).listen(cfg.port, cfg.host, () => {
    console.log(`scribe-loop: http://${cfg.host}:${cfg.port}/ (data: ${cfg.dataDir})`);
  });
  if (cfg.tlsCert && cfg.tlsKey) {
    https
      .createServer({ cert: fs.readFileSync(cfg.tlsCert), key: fs.readFileSync(cfg.tlsKey) }, handler)
      .listen(cfg.tlsPort, cfg.host, () => {
        console.log(`scribe-loop: https://${cfg.host}:${cfg.tlsPort}/`);
      });
  }
}
