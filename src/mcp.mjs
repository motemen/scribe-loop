// stdio の MCP サーバー（JSON-RPC 2.0、1 行に 1 メッセージ）。SDK に依存しない最小限の実装。

import readline from "node:readline";
import { Client, describeFeedback, AGENT_GUIDE } from "./client.mjs";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_IMAGES = 6;

const TOOLS = [
  {
    name: "scribe_push_document",
    description:
      "Kindle Scribe で読む資料（HTML）を登録する。人に頼まれてフィードバックへの回答や改訂版を Kindle に返すときは、in_reply_to にそのフィードバックの ID を渡す（そのフィードバックは処理済みになる）。\n\n" +
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
    description: "フィードバックの状態を変える。会話だけで対応し終えたら done にする。",
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

const CHANNEL_INSTRUCTIONS = `

Claude Code を channels つきで起動している場合（claude --dangerously-load-development-channels server:scribe-loop など）、人が Kindle Scribe で「送る」を押すと <channel source="scribe-loop" feedback_id="..."> のイベントが届く。
イベントが届いたら、scribe_get_feedback でそのフィードバックを読み、書き込みの内容をセッションの会話で受け止めて応答する（Kindle への資料の返信は、人が頼んだときだけ）。セッションで別の作業をしている途中なら、区切りのよいところで対応する。`;

// 新しいフィードバックを待ち、届いたら Claude Code のセッションに channel のイベントとして送る
async function watchFeedback(client, notify) {
  let after = new Date().toISOString();
  try {
    const pending = await client.listFeedback("pending");
    if (pending.length) {
      notify(
        `Kindle Scribe から未処理のフィードバックが ${pending.length} 件あります:\n` +
          pending.map((f) => `- ${f.id}「${f.documentTitle}」（線 ${f.newStrokes} 本）`).join("\n"),
        { kind: "pending", count: String(pending.length) },
      );
    }
  } catch {
    // サーバーが動いていなければ、下のループで待つ
  }
  for (;;) {
    try {
      const { feedback } = await client.waitFeedback(after, 60);
      for (const f of feedback) {
        notify(
          `Kindle Scribe で「${f.documentTitle}」への書き込みが送られました（フィードバック ${f.id}、線 ${f.newStrokes} 本）。scribe_get_feedback で読んでください。`,
          { kind: "feedback", feedback_id: f.id, document_id: f.documentId },
        );
        if (f.createdAt > after) after = f.createdAt;
      }
    } catch {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

export function runMcp(serverUrl, { channel = true } = {}) {
  const client = new Client(serverUrl);
  const rl = readline.createInterface({ input: process.stdin });
  const write = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
  let watching = false;
  const notify = (content, meta) => write({ jsonrpc: "2.0", method: "notifications/claude/channel", params: { content, meta } });

  // クライアントが標準入力を閉じたら終わる（フィードバックの待ち受けが残らないように）
  rl.on("close", () => process.exit(0));

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
    if (id === undefined) {
      // 通知には返事をしない。初期化が済んだら、フィードバックを待ち始める
      if (method === "notifications/initialized" && channel && !watching) {
        watching = true;
        watchFeedback(client, notify);
      }
      return;
    }
    try {
      let result;
      if (method === "initialize") {
        const requested = params && params.protocolVersion;
        result = {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: channel ? { tools: {}, experimental: { "claude/channel": {} } } : { tools: {} },
          serverInfo: { name: "scribe-loop", version: "0.1.0" },
          instructions: AGENT_GUIDE + (channel ? CHANNEL_INSTRUCTIONS : ""),
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
