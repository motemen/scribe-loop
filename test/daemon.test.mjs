import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config, deviceUnreachable, guessLanAddress } from "../src/config.mjs";
import { ensureServer, stopServer, probe } from "../src/daemon.mjs";

test("ensureServer starts a detached server once with the same flags, and stopServer stops it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-loop-daemon-"));
  const port = String(20000 + Math.floor(Math.random() * 20000));
  const cfg = config({ host: "127.0.0.1", port, "data-dir": path.join(dir, "data") }, { HOME: dir });
  assert.equal(cfg.serverUrl, `http://127.0.0.1:${port}`);
  assert.equal(await probe(cfg.serverUrl), null);
  try {
    const results = await Promise.all([ensureServer(cfg), ensureServer(cfg), ensureServer(cfg)]);
    assert.equal(new Set(results.map((r) => r.status.pid)).size, 1, "concurrent starts converge on one server");
    assert.equal(results[0].status.dataDir, path.join(dir, "data"), "flags are passed to the spawned server");
    assert.equal((await ensureServer(cfg)).started, false);
    assert.ok(fs.existsSync(path.join(dir, ".local", "state", "scribe-loop", "server.log")));
  } finally {
    await stopServer(cfg);
  }
  assert.equal(await probe(cfg.serverUrl), null);
});

test("defaults: listen only on this machine", () => {
  const cfg = config({}, { HOME: "/home/x" });
  assert.equal(cfg.host, "127.0.0.1");
  assert.equal(cfg.serverUrl, "http://127.0.0.1:8470");
  assert.equal(cfg.dataDir, "/home/x/.local/share/scribe-loop");
  assert.equal(cfg.autostart, true);
});

test("--host 0.0.0.0 calls locally and guesses the LAN address for device URLs", () => {
  const cfg = config({ host: "0.0.0.0" }, { HOME: "/home/x" });
  assert.equal(cfg.serverUrl, "http://127.0.0.1:8470");
  assert.ok(cfg.serveArgs.includes("0.0.0.0"));
});

test("deviceUnreachable is true only for a loopback server without a public URL", () => {
  assert.equal(deviceUnreachable({ host: "127.0.0.1", publicUrl: "http://127.0.0.1:8470" }), true);
  assert.equal(deviceUnreachable({ host: "127.0.0.1", publicUrl: "https://scribe.example.com" }), false);
  assert.equal(deviceUnreachable({ host: "0.0.0.0", publicUrl: "http://192.168.1.2:8470" }), false);
});

test("--url points at another machine and disables autostart", () => {
  assert.equal(config({ url: "http://192.0.2.1:8470" }).autostart, false);
});

test("guessLanAddress skips docker, tailscale and loopback", () => {
  const ifaces = {
    lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
    docker0: [{ family: "IPv4", address: "172.17.0.1", internal: false }],
    tailscale0: [{ family: "IPv4", address: "100.64.0.1", internal: false }],
    enp1s0: [{ family: "IPv4", address: "192.168.1.20", internal: false }],
  };
  assert.equal(guessLanAddress(ifaces), "192.168.1.20");
});
