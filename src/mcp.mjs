// stdio の MCP サーバー（JSON-RPC 2.0、1 行に 1 メッセージ）。SDK に依存しない最小限の実装。

import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, describeFeedback, AGENT_GUIDE } from "./client.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "scribe-loop.mjs");

const quote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

// 同じサーバーを使う `scribe-loop wait` のコマンドライン
function waitCommand(cfg) {
  const flags = cfg.autostart ? cfg.serveArgs : ["--url", cfg.serverUrl];
  return [process.execPath, BIN, "wait", ...flags].map(quote).join(" ");
}

function waitInstructions(cfg) {
  return `

Waiting for the user to send feedback (for example, after pushing a document for them to read): if this session does not receive channel events (<channel source="scribe-loop" ...>), run the following command in the background. It exits when new feedback arrives and prints its ID; then read it with scribe_get_feedback.
  ${waitCommand(cfg)}
Sessions that receive channel events do not need this command.`;
}

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_IMAGES = 6;

const TOOLS = [
  {
    name: "scribe_push_document",
    description:
      "Push a document (HTML) for the user to read and annotate by hand on their handwriting device. When the user asks you to send an answer or a revised version back to the device in response to feedback, pass that feedback's ID as in_reply_to (the feedback is then marked done).\n\n" +
      AGENT_GUIDE,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Document title" },
        html: { type: "string", description: "Document HTML (a full document or the body contents)" },
        in_reply_to: { type: "string", description: "ID of the feedback this document answers (optional)" },
      },
      required: ["html"],
    },
  },
  {
    name: "scribe_revise_document",
    description:
      "Revise a pushed document in place as a new revision (the device switches to the new revision of the same document). The previous revision and its handwriting are kept; the new revision starts without handwriting. When revising in response to feedback, pass feedback_id (the feedback is then marked done). Use this when the user asks you in the session to revise the document, or when the feedback requests a revision.",
    inputSchema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        html: { type: "string", description: "HTML of the new revision (the whole document)" },
        title: { type: "string", description: "Only when changing the title" },
        feedback_id: { type: "string", description: "ID of the feedback reflected in this revision (optional)" },
      },
      required: ["document_id", "html"],
    },
  },
  {
    name: "scribe_list_feedback",
    description: "List feedback the user sent from the handwriting device. Returns only pending feedback by default.",
    inputSchema: {
      type: "object",
      properties: { status: { type: "string", enum: ["pending", "processing", "done", "all"], description: "Defaults to pending" } },
    },
  },
  {
    name: "scribe_get_feedback",
    description:
      "Get a piece of feedback: the source HTML of the document, the position of each stroke and the text under it, and page images with the handwriting drawn over the document (when available). Marks the feedback as processing.",
    inputSchema: {
      type: "object",
      properties: { feedback_id: { type: "string" } },
      required: ["feedback_id"],
    },
  },
  {
    name: "scribe_update_feedback",
    description: "Change the status of a piece of feedback. Mark it done after you have responded to it in the conversation.",
    inputSchema: {
      type: "object",
      properties: {
        feedback_id: { type: "string" },
        status: { type: "string", enum: ["pending", "processing", "done"] },
        note: { type: "string", description: "Note (optional)" },
      },
      required: ["feedback_id", "status"],
    },
  },
  {
    name: "scribe_list_documents",
    description: "List pushed documents, newest first.",
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
      return [
        text(
          `Pushed: ${meta.title} (${meta.id})\nIt appears in the document list on the device. ${meta.url}\n` +
            `To wait for the user's handwritten feedback in a session that does not receive channel events, run this in the background: ${waitCommand(cfgRef)}`,
        ),
      ];
    }
    case "scribe_revise_document": {
      const meta = await client.reviseDocument(args.document_id, { html: args.html, title: args.title, feedbackId: args.feedback_id });
      return [text(`Revised: ${meta.title} (${meta.id}), revision ${meta.revision}. If the document is open on the device, the user can switch to the new revision there. ${meta.url}`)];
    }
    case "scribe_list_feedback": {
      const status = args.status === "all" ? undefined : args.status || "pending";
      const list = await client.listFeedback(status);
      return [text(list.length ? list : `No ${status || ""} feedback.`)];
    }
    case "scribe_get_feedback": {
      const fb = await client.getFeedback(args.feedback_id);
      const source = await client.source(fb.documentId, fb.revision);
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
          content.push(text(`Page ${p.page} (handwriting drawn over the document)`));
          const png = await client.page(fb.id, p.file);
          content.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
        }
        const rest = pages.pages.filter((p) => p.hasInk).length - withInk.length;
        if (rest > 0) content.push(text(`${rest} more page(s) have handwriting (images omitted).`));
      } else {
        content.push(text("Could not render the handwriting over the document (the server has no playwright-core or Chrome). Attaching an SVG of the strokes only."));
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

When Claude Code runs with channels enabled (for example, claude --dangerously-load-development-channels server:scribe-loop), a <channel source="scribe-loop" feedback_id="..."> event arrives when the user presses Send on the device.
When an event arrives, read the feedback with scribe_get_feedback and respond to the handwriting in the conversation (send a document back to the device only when the user asks). If you are in the middle of other work, handle it at a good stopping point.`;

// 新しいフィードバックを待ち、届いたら Claude Code のセッションに channel のイベントとして送る
async function watchFeedback(client, notify) {
  let after = new Date().toISOString();
  try {
    const pending = await client.listFeedback("pending");
    if (pending.length) {
      notify(
        `There is pending handwritten feedback (${pending.length}):\n` +
          pending.map((f) => `- ${f.id} on "${f.documentTitle}" (${f.newStrokes} strokes)`).join("\n"),
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
        const revise = f.mode === "revise";
        notify(
          `The user sent handwriting on "${f.documentTitle}" (feedback ${f.id}, ${f.newStrokes} strokes). ` +
            (revise
              ? "The document is in revise mode: read it with scribe_get_feedback and revise the document with scribe_revise_document to reflect the handwriting."
              : "Read it with scribe_get_feedback."),
          { kind: "feedback", mode: revise ? "revise" : "respond", feedback_id: f.id, document_id: f.documentId },
        );
        if (f.createdAt > after) after = f.createdAt;
      }
    } catch {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

let cfgRef = null;

export function runMcp(cfg, { channel = true, ensure = null } = {}) {
  cfgRef = cfg;
  // ツールの呼び出しでは、サーバーが止まっていれば起動する。
  // 待ち受け（watchFeedback）では起動しない（scribe-loop stop で止めたサーバーを勝手に起こさないため）
  const client = new Client(cfg.serverUrl, { ensure });
  const watchClient = new Client(cfg.serverUrl);
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
        watchFeedback(watchClient, notify);
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
          instructions: AGENT_GUIDE + (channel ? CHANNEL_INSTRUCTIONS : "") + waitInstructions(cfg),
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
          result = { content: [text(`Error: ${err.message}`)], isError: true };
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
