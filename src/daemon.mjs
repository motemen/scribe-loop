// コマンドを実行したときに、サーバーが立っていなければ裏で起動する（k1LoW/mo と同じ方式）。
//
// 1. サーバーの /api/status に問い合わせ、scribe-loop のサーバーが応答すればそれを使う。
// 2. 応答がなければ、自分自身を `serve` で起動し、親から切り離す（detached）。出力はログファイルへ。
// 3. /api/status が起動したプロセスの pid を返すまで待つ。同時に起動して負けたときは、勝ったほうを使う。

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "scribe-loop.mjs");
const MAX_LOG = 10 * 1024 * 1024;

export function logFile(cfg) {
  return path.join(cfg.stateDir, "server.log");
}

// scribe-loop のサーバーなら status を、そうでなければ null を返す
export async function probe(url, timeoutMs = 1000) {
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/api/status`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const status = await res.json();
    return status && status.app === "scribe-loop" ? status : null;
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnServer(cfg) {
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  const log = logFile(cfg);
  try {
    if (fs.statSync(log).size > MAX_LOG) fs.renameSync(log, `${log}.1`);
  } catch {
    // ログがまだない
  }
  const fd = fs.openSync(log, "a");
  const child = spawn(process.execPath, [BIN, "serve", ...(cfg.serveArgs || [])], {
    detached: true, // 別のセッションにして、コマンドが終わっても残す
    stdio: ["ignore", fd, fd],
    env: cfg.env || process.env,
  });
  child.unref();
  fs.closeSync(fd);
  return child.pid;
}

// サーバーが立っていなければ起動する。{ status, started } を返す。
export async function ensureServer(cfg, { timeoutMs = 10000 } = {}) {
  const running = await probe(cfg.serverUrl, 500);
  if (running) return { status: running, started: false };
  if (!cfg.autostart) throw new Error(`scribe-loop のサーバーに届きません: ${cfg.serverUrl}`);

  const pid = spawnServer(cfg);
  const deadline = Date.now() + timeoutMs;
  let deadSince = 0;
  while (Date.now() < deadline) {
    const status = await probe(cfg.serverUrl, 500);
    // 別のプロセスが先に起動していたら（同時に起動して負けた）、そちらを使う
    if (status) return { status, started: status.pid === pid };
    if (!deadSince && !alive(pid)) deadSince = Date.now();
    if (deadSince && Date.now() - deadSince > 1000) break;
    await sleep(100);
  }
  throw new Error(`サーバーを起動できませんでした（ポートが使われているかもしれません）。ログ: ${logFile(cfg)}`);
}

export async function stopServer(cfg, { timeoutMs = 5000 } = {}) {
  const status = await probe(cfg.serverUrl, 1000);
  if (!status) return null;
  await fetch(`${cfg.serverUrl.replace(/\/$/, "")}/api/shutdown`, { method: "POST" }).catch(() => {});
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await probe(cfg.serverUrl, 300))) return status;
    await sleep(100);
  }
  throw new Error(`サーバー（pid ${status.pid}）が止まりませんでした`);
}
