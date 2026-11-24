// stdio の MCP サーバー（JSON-RPC 2.0、1 行に 1 メッセージ）。SDK に依存しない最小限の実装。

import readline from "node:readline";
import { Client, describeFeedback, AGENT_GUIDE } from "./client.mjs";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_IMAGES = 6;

const TOOLS = [
  {
    name: "scribe_push_document",
    description:
      "Kindle Scribe で読む資料（HTML）を登録する。フィードバックへの回答や改訂版なら in_reply_to にそのフィードバックの ID を渡す（そのフィードバックは処理済みになる）。\n\n" +
      AGENT_GUIDE,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "資料の題名" },
        html: { type: "string", description: "資料の HTML（文書全体か、body の中身）" },
        in_reply_to: { type: "string", description: "返信する対象のフィードバックの ID（任意）" },
      },
      required: ["html"],
    },
  },
  {
    name: "scribe_list_feedback",
    description: "人が Kindle Scribe から送ったフィードバックの一覧。既定では未処理（pending）だけを返す。",
    inputSchema: {
      type: "object",
      properties: { status: { type: "string", enum: ["pending", "processing", "done", "all"], description: "既定は pending" } },
    },
  },
  {
    name: "scribe_get_feedback",
    description:
      "フィードバックの中身を取得する。元の資料の HTML、線ごとの位置とその下の文字、資料と手書きを重ねたページの画像（作れる場合）を返す。取得すると状態を processing にする。",
    inputSchema: {
      type: "object",
      properties: { feedback_id: { type: "string" } },
      required: ["feedback_id"],
    },
  },
  {
    name: "scribe_update_feedback",
    description: "フィードバックの状態を変える。返信の資料を登録せずに処理済みにするときなどに使う。",
    inputSchema: {
      type: "object",
      properties: {
        feedback_id: { type: "string" },
        status: { type: "string", enum: ["pending", "processing", "done"] },
        note: { type: "string", description: "メモ（任意）" },
      },
      required: ["feedback_id", "status"],
    },
  },
  {
    name: "scribe_list_documents",
    description: "登録されている資料の一覧（新しい順）。",
    inputSchema: { type: "object", properties: {} },
  },
];

function text(value) {
  return { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) };
}

async function callTool(client, name, args) {
  switch (name) {
    case "scribe_push_document": {
      const meta = await client.pushDocument({ title: args.title, html: args.html, inReplyTo: args.in_reply_to });
      return [text(`登録しました: ${meta.title}（${meta.id}）\nKindle Scribe の一覧に出ます。${meta.url}`)];
    }
    case "scribe_list_feedback": {
      const status = args.status === "all" ? undefined : args.status || "pending";
      const list = await client.listFeedback(status);
      return [text(list.length ? list : `${status || ""} のフィードバックはありません。`)];
    }
    case "scribe_get_feedback": {
      const fb = await client.getFeedback(args.feedback_id);
      const source = await client.source(fb.documentId);
      if (fb.status === "pending") await client.updateFeedback(fb.id, { status: "processing" });
      const content = [text(describeFeedback(fb, source))];
      let pages = { available: false, pages: [] };
      try {
        pages = await client.pages(fb.id);
      } catch {
        // 画像が作れなくても続ける
      }
      const withInk = pages.pages.filter((p) => p.hasInk).slice(0, MAX_IMAGES);
      if (pages.available) {
        for (const p of withInk) {
          content.push(text(`ページ ${p.page}（資料と手書きを重ねた画像）`));
          const png = await client.page(fb.id, p.file);
          content.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
        }
        const rest = pages.pages.filter((p) => p.hasInk).length - withInk.length;
        if (rest > 0) content.push(text(`ほかに書き込みのあるページが ${rest} ページあります（画像は省略）。`));
      } else {
        content.push(text("資料と手書きを重ねた画像は作れませんでした（サーバーに playwright-core と Chrome がない）。手書きの線だけの SVG を付けます。"));
        content.push(text(await client.inkSvg(fb.id)));
      }
      return content;
    }
    case "scribe_update_feedback": {
      const r = await client.updateFeedback(args.feedback_id, { status: args.status, note: args.note });
      return [text(r)];
    }
    case "scribe_list_documents":
      return [text(await client.listDocuments())];
    default:
      throw Object.assign(new Error(`unknown tool: ${name}`), { code: -32602 });
  }
}

export function runMcp(serverUrl) {
  const client = new Client(serverUrl);
  const rl = readline.createInterface({ input: process.stdin });
  const write = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    const { id, method, params } = msg;
    if (id === undefined) return; // 通知には返事をしない
    try {
      let result;
      if (method === "initialize") {
        const requested = params && params.protocolVersion;
        result = {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "scribe-loop", version: "0.1.0" },
          instructions: AGENT_GUIDE,
        };
      } else if (method === "ping") {
        result = {};
      } else if (method === "tools/list") {
        result = { tools: TOOLS };
      } else if (method === "tools/call") {
        try {
          result = { content: await callTool(client, params.name, params.arguments || {}) };
        } catch (err) {
          if (err.code === -32602) throw err;
          result = { content: [text(`エラー: ${err.message}`)], isError: true };
        }
      } else {
        throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
      }
      write({ jsonrpc: "2.0", id, result });
    } catch (err) {
      write({ jsonrpc: "2.0", id, error: { code: err.code || -32603, message: err.message } });
    }
  });
}
