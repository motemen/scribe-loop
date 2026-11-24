// 資料・書き込み・フィードバックをファイルに保存する。
//
// <dataDir>/documents/<id>/meta.json      資料の情報
// <dataDir>/documents/<id>/source.html    エージェントが登録した HTML
// <dataDir>/documents/<id>/ink.jsonl      書き込みの操作（追加・削除・全消去）
// <dataDir>/documents/<id>/feedback/<fid>.json  フィードバック
// <dataDir>/documents/<id>/source.r<n>.html, ink.r<n>.jsonl  書き換える前の版（n は版の番号）
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
    meta.revision = meta.revision || 1;
    meta.reviseOnSend = !!meta.reviseOnSend;
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
    const entry = { meta, ops, seen, feedback, archived: new Map() };
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
      revision: 1,
      revisedAt: null,
      reviseOnSend: false,
    };
    writeJsonAtomic(path.join(dir, "meta.json"), meta);
    this.docs.set(id, { meta, ops: [], seen: new Set(), feedback: new Map(), archived: new Map() });
    if (inReplyTo) this.updateFeedback(inReplyTo, { status: "done", replyDocumentId: id });
    return meta;
  }

  getDocument(id) {
    return this.docs.get(id) || null;
  }

  // rev を省くか、今の版なら今の資料。古い版なら残してあるもの。
  source(id, rev) {
    const entry = this.docs.get(id);
    const current = !rev || Number(rev) === entry.meta.revision;
    const name = current ? "source.html" : `source.r${Number(rev)}.html`;
    const file = path.join(this.#dir(id), name);
    if (!fs.existsSync(file)) throw Object.assign(new Error("revision not found"), { status: 404 });
    return fs.readFileSync(file, "utf8");
  }

  #writeMeta(id) {
    writeJsonAtomic(path.join(this.#dir(id), "meta.json"), this.docs.get(id).meta);
  }

  setReviseOnSend(id, value) {
    const entry = this.docs.get(id);
    entry.meta.reviseOnSend = !!value;
    this.#writeMeta(id);
    return entry.meta;
  }

  // 資料を書き換える。今の版の資料と書き込みは source.r<n>.html / ink.r<n>.jsonl として残し、
  // 新しい版は書き込みなしで始める。
  reviseDocument(id, { html, title, feedbackId }) {
    if (typeof html !== "string" || !html.trim()) throw Object.assign(new Error("html is required"), { status: 400 });
    const entry = this.docs.get(id);
    if (feedbackId) {
      const fb = this.findFeedback(feedbackId);
      if (!fb || fb.documentId !== id) throw Object.assign(new Error("feedback does not belong to this document"), { status: 400 });
    }
    const dir = this.#dir(id);
    const rev = entry.meta.revision;
    fs.renameSync(path.join(dir, "source.html"), path.join(dir, `source.r${rev}.html`));
    if (fs.existsSync(path.join(dir, "ink.jsonl"))) fs.renameSync(path.join(dir, "ink.jsonl"), path.join(dir, `ink.r${rev}.jsonl`));
    fs.writeFileSync(path.join(dir, "source.html"), html);
    entry.archived.set(rev, { ops: entry.ops, seen: entry.seen });
    entry.ops = [];
    entry.seen = new Set();
    entry.meta.revision = rev + 1;
    entry.meta.revisedAt = new Date().toISOString();
    if (title && String(title).trim()) entry.meta.title = String(title).trim();
    entry.meta.readAt = null;
    this.#writeMeta(id);
    if (feedbackId) this.updateFeedback(feedbackId, { status: "done", revisedTo: entry.meta.revision });
    return entry.meta;
  }

  #archived(id, rev) {
    const entry = this.docs.get(id);
    let a = entry.archived.get(rev);
    if (a) return a;
    a = { ops: [], seen: new Set() };
    const file = path.join(this.#dir(id), `ink.r${rev}.jsonl`);
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const op = JSON.parse(line);
          a.seen.add(op.opId);
          a.ops.push(op);
        } catch {
          // 読み飛ばす
        }
      }
    }
    entry.archived.set(rev, a);
    return a;
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
      feedback: fbs.map((f) => ({
        id: f.id,
        createdAt: f.createdAt,
        status: f.status,
        mode: f.mode || "respond",
        revision: f.revision || 1,
        replyDocumentId: f.replyDocumentId || null,
        revisedTo: f.revisedTo || null,
      })),
      replies,
    };
  }

  listDocuments() {
    return [...this.docs.keys()].map((id) => this.summary(id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // ---- 書き込み ----

  strokes(id, rev) {
    const entry = this.docs.get(id);
    if (!rev || Number(rev) === entry.meta.revision) return applyOps(entry.ops);
    return applyOps(this.#archived(id, Number(rev)).ops);
  }

  // 操作は、その操作が書かれた版（op.revision、なければ今の版）の書き込みに加える。
  // 書き換えの前に端末で書かれ、あとから届いた操作も失わない。
  appendOps(id, ops, client) {
    const entry = this.docs.get(id);
    const acked = [];
    const fresh = new Map(); // file -> lines
    for (const op of ops) {
      if (!op || typeof op.opId !== "string" || !op.opId || op.opId.length > 100) continue;
      const rev = Number(op.revision) || entry.meta.revision;
      if (rev > entry.meta.revision || rev < 1) continue;
      acked.push(op.opId);
      const target = rev === entry.meta.revision ? entry : this.#archived(id, rev);
      if (target.seen.has(op.opId)) continue; // 再送
      if (!["add", "del", "clear"].includes(op.kind)) continue;
      const stored = { ...op, revision: rev, client: String(client || "").slice(0, 64), receivedAt: new Date().toISOString() };
      target.seen.add(op.opId);
      target.ops.push(stored);
      const file = rev === entry.meta.revision ? "ink.jsonl" : `ink.r${rev}.jsonl`;
      if (!fresh.has(file)) fresh.set(file, []);
      fresh.get(file).push(JSON.stringify(stored));
    }
    for (const [file, lines] of fresh) fs.appendFileSync(path.join(this.#dir(id), file), lines.join("\n") + "\n");
    return acked;
  }

  // ---- フィードバック ----

  // clientRequestId で重複を除く。strokeIds は端末がその時点で持っていた線で、
  // サーバーにまだ届いていないものがあれば missing を返す（端末は送り切ってから再試行する）。
  createFeedback(id, { clientRequestId, strokeIds, surface, client, revision }) {
    const entry = this.docs.get(id);
    for (const fb of entry.feedback.values()) {
      if (clientRequestId && fb.clientRequestId === clientRequestId) return { feedback: fb };
    }
    // 端末が古い版を見ているあいだに書き換えられた
    if (revision && Number(revision) !== entry.meta.revision) return { stale: entry.meta.revision };
    const strokes = this.strokes(id);
    const have = new Set(strokes.map((s) => s.id));
    const missing = (strokeIds || []).filter((s) => !have.has(s));
    if (missing.length) return { missing };
    const previous = [...entry.feedback.values()]
      .filter((f) => (f.revision || 1) === entry.meta.revision)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const before = new Set(previous ? previous.strokes.map((s) => s.id) : []);
    const fb = {
      id: newId("f"),
      documentId: id,
      createdAt: new Date().toISOString(),
      revision: entry.meta.revision,
      // 送られたときに資料が書き換えモードなら、エージェントに書き換えを頼む
      mode: entry.meta.reviseOnSend ? "revise" : "respond",
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
          mode: fb.mode || "respond",
          revision: fb.revision || 1,
          strokes: fb.strokes.length,
          newStrokes: fb.newStrokeIds.length,
          replyDocumentId: fb.replyDocumentId,
        });
      }
    }
    return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  updateFeedback(fid, { status, note, replyDocumentId, revisedTo }) {
    const fb = this.findFeedback(fid);
    if (!fb) return null;
    if (status) {
      if (!["pending", "processing", "done"].includes(status)) throw Object.assign(new Error("invalid status"), { status: 400 });
      fb.status = status;
      fb.statusAt = new Date().toISOString();
    }
    if (note !== undefined) fb.note = note == null ? null : String(note).slice(0, 2000);
    if (replyDocumentId) fb.replyDocumentId = replyDocumentId;
    if (revisedTo) fb.revisedTo = revisedTo;
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
