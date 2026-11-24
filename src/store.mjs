// 資料・書き込み・フィードバックをファイルに保存する。
//
// <dataDir>/documents/<id>/meta.json      資料の情報
// <dataDir>/documents/<id>/source.html    エージェントが登録した HTML
// <dataDir>/documents/<id>/ink.jsonl      書き込みの操作（追加・削除・全消去）
// <dataDir>/documents/<id>/feedback/<fid>.json  フィードバック
//
// 1 プロセスから使う前提で、メモリにも持つ。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ID = /^[a-z0-9][a-z0-9-]{0,80}$/;

export function isId(value) {
  return typeof value === "string" && ID.test(value);
}

export function newId(prefix) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${prefix}${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export function applyOps(ops) {
  const strokes = new Map();
  for (const op of ops) {
    if (op.kind === "add" && op.stroke && op.stroke.id) strokes.set(op.stroke.id, op.stroke);
    else if (op.kind === "del" && Array.isArray(op.ids)) for (const id of op.ids) strokes.delete(id);
    else if (op.kind === "clear") strokes.clear();
  }
  return [...strokes.values()];
}

export class Store {
  constructor(dataDir) {
    this.root = path.join(dataDir, "documents");
    fs.mkdirSync(this.root, { recursive: true });
    this.docs = new Map(); // id -> { meta, ops, seen, feedback: Map }
    for (const id of fs.readdirSync(this.root)) {
      if (isId(id) && fs.existsSync(path.join(this.root, id, "meta.json"))) this.#load(id);
    }
  }

  #dir(id) {
    return path.join(this.root, id);
  }

  #load(id) {
    const dir = this.#dir(id);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
    const ops = [];
    const seen = new Set();
    const inkFile = path.join(dir, "ink.jsonl");
    if (fs.existsSync(inkFile)) {
      for (const line of fs.readFileSync(inkFile, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const op = JSON.parse(line);
          seen.add(op.opId);
          ops.push(op);
        } catch {
          // 書き込み途中で落ちた行は読み飛ばす
        }
      }
    }
    const feedback = new Map();
    const fbDir = path.join(dir, "feedback");
    if (fs.existsSync(fbDir)) {
      for (const name of fs.readdirSync(fbDir)) {
        if (!name.endsWith(".json")) continue;
        const fb = JSON.parse(fs.readFileSync(path.join(fbDir, name), "utf8"));
        feedback.set(fb.id, fb);
      }
    }
    const entry = { meta, ops, seen, feedback };
    this.docs.set(id, entry);
    return entry;
  }

  // ---- 資料 ----

  createDocument({ title, html, parentId = null, inReplyTo = null }) {
    if (typeof html !== "string" || !html.trim()) throw Object.assign(new Error("html is required"), { status: 400 });
    if (parentId && !this.docs.has(parentId)) throw Object.assign(new Error("unknown parent document"), { status: 400 });
    if (inReplyTo) {
      const fb = this.findFeedback(inReplyTo);
      if (!fb) throw Object.assign(new Error("unknown feedback"), { status: 400 });
      parentId = parentId || fb.documentId;
    }
    const id = newId("d");
    const dir = this.#dir(id);
    fs.mkdirSync(path.join(dir, "feedback"), { recursive: true });
    fs.writeFileSync(path.join(dir, "source.html"), html);
    const meta = {
      id,
      title: String(title || "").trim() || guessTitle(html) || "無題",
      createdAt: new Date().toISOString(),
      parentId,
      inReplyTo,
      readAt: null,
    };
    writeJsonAtomic(path.join(dir, "meta.json"), meta);
    this.docs.set(id, { meta, ops: [], seen: new Set(), feedback: new Map() });
    if (inReplyTo) this.updateFeedback(inReplyTo, { status: "done", replyDocumentId: id });
    return meta;
  }

  getDocument(id) {
    return this.docs.get(id) || null;
  }

  source(id) {
    return fs.readFileSync(path.join(this.#dir(id), "source.html"), "utf8");
  }

  markRead(id) {
    const entry = this.docs.get(id);
    if (!entry || entry.meta.readAt) return;
    entry.meta.readAt = new Date().toISOString();
    writeJsonAtomic(path.join(this.#dir(id), "meta.json"), entry.meta);
  }

  summary(id) {
    const entry = this.docs.get(id);
    const fbs = [...entry.feedback.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const replies = [...this.docs.values()].filter((d) => d.meta.parentId === id).map((d) => d.meta.id);
    return {
      ...entry.meta,
      strokes: applyOps(entry.ops).length,
      feedback: fbs.map((f) => ({ id: f.id, createdAt: f.createdAt, status: f.status, replyDocumentId: f.replyDocumentId || null })),
      replies,
    };
  }

  listDocuments() {
    return [...this.docs.keys()].map((id) => this.summary(id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // ---- 書き込み ----

  strokes(id) {
    return applyOps(this.docs.get(id).ops);
  }

  appendOps(id, ops, client) {
    const entry = this.docs.get(id);
    const acked = [];
    const fresh = [];
    for (const op of ops) {
      if (!op || typeof op.opId !== "string" || !op.opId || op.opId.length > 100) continue;
      acked.push(op.opId);
      if (entry.seen.has(op.opId)) continue; // 再送
      if (!["add", "del", "clear"].includes(op.kind)) continue;
      const stored = { ...op, client: String(client || "").slice(0, 64), receivedAt: new Date().toISOString() };
      entry.seen.add(op.opId);
      entry.ops.push(stored);
      fresh.push(JSON.stringify(stored));
    }
    if (fresh.length) fs.appendFileSync(path.join(this.#dir(id), "ink.jsonl"), fresh.join("\n") + "\n");
    return acked;
  }

  // ---- フィードバック ----

  // clientRequestId で重複を除く。strokeIds は端末がその時点で持っていた線で、
  // サーバーにまだ届いていないものがあれば missing を返す（端末は送り切ってから再試行する）。
  createFeedback(id, { clientRequestId, strokeIds, surface, client }) {
    const entry = this.docs.get(id);
    for (const fb of entry.feedback.values()) {
      if (clientRequestId && fb.clientRequestId === clientRequestId) return { feedback: fb };
    }
    const strokes = this.strokes(id);
    const have = new Set(strokes.map((s) => s.id));
    const missing = (strokeIds || []).filter((s) => !have.has(s));
    if (missing.length) return { missing };
    const previous = [...entry.feedback.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const before = new Set(previous ? previous.strokes.map((s) => s.id) : []);
    const fb = {
      id: newId("f"),
      documentId: id,
      createdAt: new Date().toISOString(),
      status: "pending",
      statusAt: null,
      note: null,
      replyDocumentId: null,
      clientRequestId: clientRequestId || null,
      client: String(client || "").slice(0, 64),
      surface: surface || null,
      newStrokeIds: strokes.filter((s) => !before.has(s.id)).map((s) => s.id),
      strokes,
    };
    entry.feedback.set(fb.id, fb);
    writeJsonAtomic(path.join(this.#dir(id), "feedback", `${fb.id}.json`), fb);
    return { feedback: fb };
  }

  findFeedback(fid) {
    for (const entry of this.docs.values()) {
      const fb = entry.feedback.get(fid);
      if (fb) return fb;
    }
    return null;
  }

  listFeedback({ status } = {}) {
    const all = [];
    for (const entry of this.docs.values()) {
      for (const fb of entry.feedback.values()) {
        if (status && fb.status !== status) continue;
        all.push({
          id: fb.id,
          documentId: fb.documentId,
          documentTitle: entry.meta.title,
          createdAt: fb.createdAt,
          status: fb.status,
          strokes: fb.strokes.length,
          newStrokes: fb.newStrokeIds.length,
          replyDocumentId: fb.replyDocumentId,
        });
      }
    }
    return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  updateFeedback(fid, { status, note, replyDocumentId }) {
    const fb = this.findFeedback(fid);
    if (!fb) return null;
    if (status) {
      if (!["pending", "processing", "done"].includes(status)) throw Object.assign(new Error("invalid status"), { status: 400 });
      fb.status = status;
      fb.statusAt = new Date().toISOString();
    }
    if (note !== undefined) fb.note = note == null ? null : String(note).slice(0, 2000);
    if (replyDocumentId) fb.replyDocumentId = replyDocumentId;
    writeJsonAtomic(path.join(this.#dir(fb.documentId), "feedback", `${fb.id}.json`), fb);
    return fb;
  }

  feedbackDir(fid) {
    const fb = this.findFeedback(fid);
    return fb ? path.join(this.#dir(fb.documentId), "feedback", fb.id) : null;
  }
}

function guessTitle(html) {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html) || /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (!m) return "";
  return m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
}
