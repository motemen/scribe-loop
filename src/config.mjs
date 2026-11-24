import os from "node:os";
import path from "node:path";

// コマンドラインのフラグ（すべてのコマンドで共通）。設定ファイルや環境変数は使わない。
export const SERVER_OPTIONS = {
  host: { type: "string" },
  port: { type: "string" },
  "data-dir": { type: "string" },
  "public-url": { type: "string" },
  chrome: { type: "string" },
  url: { type: "string" },
};

function xdg(name, fallback, env) {
  return env[name] || path.join(env.HOME || os.homedir(), fallback);
}

// 0.0.0.0 で待ち受けるとき、端末から見えそうな LAN 側の IPv4 を探す（資料の URL に使う）
export function guessLanAddress(interfaces = os.networkInterfaces()) {
  const skip = /^(lo|docker|br-|veth|virbr|tailscale|tun|tap|wg|zt|utun|cni|flannel|cali)/;
  const candidates = [];
  for (const [name, list] of Object.entries(interfaces)) {
    if (skip.test(name)) continue;
    for (const i of list || []) {
      if (i.family !== "IPv4" && i.family !== 4) continue;
      if (i.internal) continue;
      candidates.push(i.address);
    }
  }
  const isPrivate = (a) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
  return candidates.find(isPrivate) || candidates[0] || "";
}

const bracket = (h) => (h.includes(":") ? `[${h}]` : h);

export function isLoopback(host) {
  return host === "localhost" || host === "::1" || /^127\./.test(host || "");
}

// サーバーの status から、端末から開けない設定（このマシンからしか届かない）かどうかを判断する
export function deviceUnreachable(status) {
  if (!status || !isLoopback(status.host)) return false;
  try {
    return !status.publicUrl || isLoopback(new URL(status.publicUrl).hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return true;
  }
}

export const DEVICE_HINT =
  "The server listens only on this machine, so the handwriting device cannot open it. " +
  "To open it from the device, restart the server with --host 0.0.0.0 (for example, add the flag to the MCP server's command line).";

export function config(opts = {}, env = process.env) {
  const host = opts.host || "127.0.0.1";
  const port = Number(opts.port || 8470);
  const wildcard = host === "0.0.0.0" || host === "::";
  const local = wildcard ? "127.0.0.1" : host;
  const lan = wildcard ? guessLanAddress() : host;
  return {
    host,
    port,
    dataDir: opts["data-dir"] || path.join(xdg("XDG_DATA_HOME", ".local/share", env), "scribe-loop"),
    stateDir: path.join(xdg("XDG_STATE_HOME", ".local/state", env), "scribe-loop"),
    // 資料の URL をエージェントに返すときの、Kindle から見たサーバーの URL
    publicUrl: opts["public-url"] || (lan ? `http://${bracket(lan)}:${port}` : ""),
    chrome: opts.chrome || "",
    // CLI と MCP サーバーが呼ぶサーバー。--url で別のマシンを指したときは、自分では起動しない
    serverUrl: opts.url || `http://${bracket(local)}:${port}`,
    autostart: !opts.url,
    // 裏で起動するサーバーに渡すフラグ
    serveArgs: [
      "--host", host,
      "--port", String(port),
      ...(opts["data-dir"] ? ["--data-dir", opts["data-dir"]] : []),
      ...(opts["public-url"] ? ["--public-url", opts["public-url"]] : []),
      ...(opts.chrome ? ["--chrome", opts.chrome] : []),
    ],
    env,
  };
}
