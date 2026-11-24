import os from "node:os";
import path from "node:path";

export function config(env = process.env) {
  return {
    host: env.SCRIBE_LOOP_HOST || "127.0.0.1",
    port: Number(env.SCRIBE_LOOP_PORT || 8470),
    tlsCert: env.SCRIBE_LOOP_TLS_CERT || "",
    tlsKey: env.SCRIBE_LOOP_TLS_KEY || "",
    tlsPort: Number(env.SCRIBE_LOOP_TLS_PORT || 8471),
    dataDir:
      env.SCRIBE_LOOP_DATA_DIR ||
      path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "scribe-loop"),
    // 資料の URL をエージェントに返すときの、Kindle から見たサーバーの URL（例: http://192.0.2.10:8470）
    publicUrl: env.SCRIBE_LOOP_PUBLIC_URL || "",
    // CLI と MCP サーバーが呼ぶサーバーの URL
    serverUrl: env.SCRIBE_LOOP_URL || `http://${env.SCRIBE_LOOP_HOST || "127.0.0.1"}:${env.SCRIBE_LOOP_PORT || 8470}`,
  };
}
