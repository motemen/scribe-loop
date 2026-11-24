import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../src/config.mjs";
import { ensureServer, stopServer, probe } from "../src/daemon.mjs";

test("ensureServer starts a detached server once, and stopServer stops it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-loop-daemon-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  fs.writeFileSync(path.join(dir, "env"), `SCRIBE_LOOP_PORT=${port}\nSCRIBE_LOOP_DATA_DIR=${dir}/data\n`);
  const cfg = config({ SCRIBE_LOOP_CONFIG: path.join(dir, "env"), XDG_STATE_HOME: path.join(dir, "state"), HOME: dir });
  assert.equal(cfg.serverUrl, `http://127.0.0.1:${port}`);
  assert.equal(await probe(cfg.serverUrl), null);
  try {
    const results = await Promise.all([ensureServer(cfg), ensureServer(cfg), ensureServer(cfg)]);
    const pids = new Set(results.map((r) => r.status.pid));
    assert.equal(pids.size, 1, "concurrent starts converge on one server");
    const again = await ensureServer(cfg);
    assert.equal(again.started, false);
    assert.ok(fs.existsSync(path.join(dir, "state", "scribe-loop", "server.log")));
  } finally {
    await stopServer(cfg);
  }
  assert.equal(await probe(cfg.serverUrl), null);
});

test("a remote SCRIBE_LOOP_URL disables autostart", () => {
  const cfg = config({ SCRIBE_LOOP_CONFIG: "/nonexistent", SCRIBE_LOOP_URL: "http://192.0.2.1:8470" });
  assert.equal(cfg.autostart, false);
});
