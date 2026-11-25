import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.mjs";

function tmpStore() {
  return new Store(fs.mkdtempSync(path.join(os.tmpdir(), "scribe-loop-test-")));
}

const stroke = (id) => ({ id, points: [[0, 0, 0], [10, 10, 5]] });

test("ink ops are idempotent by opId", () => {
  const store = tmpStore();
  const doc = store.createDocument({ html: "<h1>T</h1>" });
  assert.equal(doc.title, "T");
  const ops = [{ opId: "a", kind: "add", stroke: stroke("s1") }, { opId: "b", kind: "add", stroke: stroke("s2") }];
  assert.deepEqual(store.appendOps(doc.id, ops), ["a", "b"]);
  assert.deepEqual(store.appendOps(doc.id, ops), ["a", "b"]);
  store.appendOps(doc.id, [{ opId: "c", kind: "del", ids: ["s1"] }]);
  assert.deepEqual(store.strokes(doc.id).map((s) => s.id), ["s2"]);
});

test("feedback waits for strokes, dedups requests, and tracks new strokes", () => {
  const store = tmpStore();
  const doc = store.createDocument({ title: "x", html: "<p>x</p>" });
  store.appendOps(doc.id, [{ opId: "a", kind: "add", stroke: stroke("s1") }]);
  assert.deepEqual(store.createFeedback(doc.id, { clientRequestId: "r1", strokeIds: ["s1", "s2"] }).missing, ["s2"]);
  store.appendOps(doc.id, [{ opId: "b", kind: "add", stroke: stroke("s2") }]);
  const first = store.createFeedback(doc.id, { clientRequestId: "r1", strokeIds: ["s1", "s2"] }).feedback;
  assert.equal(store.createFeedback(doc.id, { clientRequestId: "r1", strokeIds: [] }).feedback.id, first.id);
  assert.deepEqual(first.newStrokeIds, ["s1", "s2"]);
  store.appendOps(doc.id, [{ opId: "c", kind: "add", stroke: stroke("s3") }]);
  const second = store.createFeedback(doc.id, { clientRequestId: "r2", strokeIds: ["s3"] }).feedback;
  assert.deepEqual(second.newStrokeIds, ["s3"]);
  assert.equal(second.strokes.length, 3);
});

test("a reply marks the feedback done and links to the document", () => {
  const store = tmpStore();
  const doc = store.createDocument({ title: "x", html: "<p>x</p>" });
  const fb = store.createFeedback(doc.id, { clientRequestId: "r", strokeIds: [] }).feedback;
  const reply = store.createDocument({ title: "re", html: "<p>re</p>", inReplyTo: fb.id });
  assert.equal(reply.parentId, doc.id);
  assert.equal(store.findFeedback(fb.id).status, "done");
  assert.equal(store.findFeedback(fb.id).replyDocumentId, reply.id);
  assert.deepEqual(store.summary(doc.id).replies, [reply.id]);
});

test("data survives a restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-loop-test-"));
  const a = new Store(dir);
  const doc = a.createDocument({ title: "x", html: "<p>x</p>" });
  a.appendOps(doc.id, [{ opId: "a", kind: "add", stroke: stroke("s1") }]);
  a.createFeedback(doc.id, { clientRequestId: "r", strokeIds: ["s1"] });
  const b = new Store(dir);
  assert.equal(b.strokes(doc.id).length, 1);
  assert.equal(b.listFeedback().length, 1);
  assert.deepEqual(b.appendOps(doc.id, [{ opId: "a", kind: "add", stroke: stroke("s1") }]), ["a"]);
  assert.equal(b.strokes(doc.id).length, 1);
});

test("revising keeps the old revision and its ink, and starts the new one blank", () => {
  const store = tmpStore();
  const doc = store.createDocument({ title: "x", html: "<p>v1</p>" });
  store.setReviseOnSend(doc.id, true);
  store.appendOps(doc.id, [{ opId: "a", kind: "add", stroke: stroke("s1"), revision: 1 }]);
  const fb = store.createFeedback(doc.id, { clientRequestId: "r", strokeIds: ["s1"], revision: 1 }).feedback;
  assert.equal(fb.mode, "revise");
  const meta = store.reviseDocument(doc.id, { html: "<p>v2</p>", feedbackId: fb.id });
  assert.equal(meta.revision, 2);
  assert.equal(store.findFeedback(fb.id).status, "done");
  assert.equal(store.source(doc.id), "<p>v2</p>");
  assert.equal(store.source(doc.id, 1), "<p>v1</p>");
  assert.equal(store.strokes(doc.id).length, 0);
  assert.equal(store.strokes(doc.id, 1).length, 1);
  // 書き換えの前に端末で書かれ、あとから届いた操作は古い版に入る
  store.appendOps(doc.id, [{ opId: "b", kind: "add", stroke: stroke("s2"), revision: 1 }]);
  assert.equal(store.strokes(doc.id, 1).length, 2);
  assert.equal(store.strokes(doc.id).length, 0);
  // 古い版を見たまま送ったものは受け付けない
  assert.equal(store.createFeedback(doc.id, { clientRequestId: "r2", strokeIds: [], revision: 1 }).stale, 2);
});

test("deleting a document moves it to the trash with its feedback", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-loop-test-"));
  const store = new Store(dir);
  const doc = store.createDocument({ html: "<h1>T</h1>" });
  store.appendOps(doc.id, [{ opId: "a", kind: "add", stroke: stroke("s1") }]);
  const { feedback } = store.createFeedback(doc.id, { strokeIds: ["s1"] });
  assert.equal(store.deleteDocument(doc.id), true);
  assert.equal(store.listDocuments().length, 0);
  assert.equal(store.findFeedback(feedback.id), null);
  assert.ok(fs.existsSync(path.join(dir, "trash", doc.id, "meta.json")));
  assert.equal(new Store(dir).listDocuments().length, 0);
  assert.equal(store.deleteDocument(doc.id), false);
});
