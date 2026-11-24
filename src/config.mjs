import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function xdg(name, fallback, env) {
  return env[name] || path.join(os.homedir(), fallback);
}

export function configPath(env = process.env) {
  return env.SCRIBE_LOOP_CONFIG || path.join(xdg("XDG_CONFIG_HOME", ".config", env), "scribe-loop", "env");
}

// KEY=VALUE を 1 行に 1 つ書いた設定ファイル（systemd の EnvironmentFile と同じ形）を読む。
// 環境変数のほうが優先する。
export function loadConfigFile(file) {
  const out = {};
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

function isSpecificHost(host) {
  return !["0.0.0.0", "::", "127.0.0.1", "::1", "localhost"].includes(host);
}

export function config(env = process.env) {
  const e = { ...loadConfigFile(configPath(env)), ...env };
  const host = e.SCRIBE_LOOP_HOST || "127.0.0.1";
  const port = Number(e.SCRIBE_LOOP_PORT || 8470);
  // 0.0.0.0 などで待ち受けるときも、同じマシンからは 127.0.0.1 で呼べる
  const localHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return {
    host,
    port,
    tlsCert: e.SCRIBE_LOOP_TLS_CERT || "",
    tlsKey: e.SCRIBE_LOOP_TLS_KEY || "",
    tlsPort: Number(e.SCRIBE_LOOP_TLS_PORT || 8471),
    dataDir: e.SCRIBE_LOOP_DATA_DIR || path.join(xdg("XDG_DATA_HOME", ".local/share", e), "scribe-loop"),
    stateDir: path.join(xdg("XDG_STATE_HOME", ".local/state", e), "scribe-loop"),
    // 資料の URL をエージェントに返すときの、Kindle から見たサーバーの URL（例: http://192.0.2.10:8470）
    // 具体的な IP で待ち受けるなら、そこから決める
    publicUrl: e.SCRIBE_LOOP_PUBLIC_URL || (isSpecificHost(host) ? `http://${host.includes(":") ? `[${host}]` : host}:${port}` : ""),
    // CLI と MCP サーバーが呼ぶサーバーの URL。指定がなければ、この設定で待ち受けるサーバー
    serverUrl: e.SCRIBE_LOOP_URL || `http://${localHost.includes(":") ? `[${localHost}]` : localHost}:${port}`,
    // SCRIBE_LOOP_URL で別のマシンのサーバーを指しているときは、自分では起動しない
    autostart: e.SCRIBE_LOOP_AUTOSTART ? e.SCRIBE_LOOP_AUTOSTART !== "0" : !e.SCRIBE_LOOP_URL,
    chrome: e.SCRIBE_LOOP_CHROME || "",
    // 裏で起動するサーバーに、同じ設定を引き継ぐための環境変数
    env,
  };
}
