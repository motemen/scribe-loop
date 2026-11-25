#!/usr/bin/env node
// Usage:
//   scribe-loop start                        Start the server in the background (if it is not running)
//   scribe-loop status                       Show the server status
//   scribe-loop stop                         Stop the server
//   scribe-loop restart                      Restart the server
//   scribe-loop serve                        Run the server in the foreground (for debugging)
//   scribe-loop mcp [--no-channel]           Run the MCP server (stdio)
//   scribe-loop push <file.html> [--title T] [--reply-to <feedback-id>]
//                                            Push a document ("-" reads from stdin)
//   scribe-loop revise <document-id> <file.html> [--feedback <feedback-id>] [--title T]
//                                            Revise a document as a new revision
//   scribe-loop docs                         List documents
//   scribe-loop feedback [--all|--status S]  List feedback (pending by default)
//   scribe-loop show <feedback-id> [--out <dir>]
//                                            Show feedback (--out also writes the images)
//   scribe-loop done <feedback-id> [--note N]
//                                            Mark feedback as done
//   scribe-loop wait [--pending] [--timeout SECONDS]
//                                            Wait for new feedback, print its ID and exit
//
// Flags for every command:
//   --host <addr>        Address to listen on (default 127.0.0.1; use 0.0.0.0 to open it from the device)
//   --port <port>        Port to listen on (default 8470)
//   --data-dir <dir>     Where data is stored (default $XDG_DATA_HOME/scribe-loop)
//   --public-url <url>   The server URL as seen from the device (default: guessed from the LAN IP)
//   --chrome <path>      Chrome / Chromium used to render page images
//   --url <url>          Use a server running on another machine (no server is started)
//
// Commands that use the server start it in the background with the same flags if it is not running.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { config, SERVER_OPTIONS, deviceUnreachable, DEVICE_HINT } from "../src/config.mjs";
import { Client, describeFeedback } from "../src/client.mjs";
import { ensureServer, stopServer, probe, logFile } from "../src/daemon.mjs";

function usage() {
  // このファイルの先頭のコメントをそのまま表示する
  const lines = fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1);
  const text = [];
  for (const l of lines) {
    if (!l.startsWith("//")) break;
    text.push(l.replace(/^\/\/ ?/, ""));
  }
  console.error(text.join("\n").trimEnd());
  process.exit(2);
}

const [command, ...rest] = process.argv.slice(2);
let values, positionals;
try {
  ({ values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      ...SERVER_OPTIONS,
      title: { type: "string" },
      "reply-to": { type: "string" },
      feedback: { type: "string" },
      all: { type: "boolean" },
      status: { type: "string" },
      out: { type: "string" },
      note: { type: "string" },
      "no-channel": { type: "boolean" },
      pending: { type: "boolean" },
      timeout: { type: "string" },
    },
  }));
} catch (err) {
  console.error(err.message);
  usage();
}
const cfg = config(values);

let hinted = false;

// サーバーにつながらなかったときだけ、起動してからやり直す
async function ensure() {
  const { status, started } = await ensureServer(cfg);
  if (started) console.error(`scribe-loop: started the server at ${status.publicUrl || cfg.serverUrl} (pid ${status.pid})`);
  if (started && deviceUnreachable(status)) {
    console.error(`scribe-loop: ${DEVICE_HINT}`);
    hinted = true;
  }
}

function printStatus(status) {
  console.log(`running\tpid ${status.pid}\tversion ${status.version}\tsince ${status.startedAt}`);
  console.log(`listen\t${status.host}:${status.port}`);
  if (deviceUnreachable(status)) console.log(`device\t(unreachable) ${DEVICE_HINT}`);
  else if (status.publicUrl) console.log(`device\t${status.publicUrl}/`);
  console.log(`data\t${status.dataDir}`);
  console.log(`log\t${logFile(cfg)}`);
}

async function main() {
  const client = new Client(cfg.serverUrl, { ensure: cfg.autostart ? ensure : null });
  switch (command) {
    case "start": {
      await ensure();
      printStatus(await probe(cfg.serverUrl));
      return;
    }
    case "status": {
      const status = await probe(cfg.serverUrl);
      if (!status) {
        console.log(`stopped\t${cfg.serverUrl}`);
        process.exitCode = 1;
        return;
      }
      printStatus(status);
      return;
    }
    case "stop": {
      const status = await stopServer(cfg);
      console.error(status ? `scribe-loop: stopped the server (pid ${status.pid})` : "scribe-loop: the server is not running");
      return;
    }
    case "restart": {
      await stopServer(cfg);
      await ensure();
      printStatus(await probe(cfg.serverUrl));
      return;
    }
    case "serve": {
      const { startServer } = await import("../src/server.mjs");
      startServer(cfg);
      return;
    }
    case "mcp": {
      const { runMcp } = await import("../src/mcp.mjs");
      // MCP は起動したらサーバーも用意しておく（Kindle からすぐ開けるように）
      if (cfg.autostart) await ensureServer(cfg).catch((err) => console.error(`scribe-loop: ${err.message}`));
      runMcp(cfg, { channel: !values["no-channel"], ensure: cfg.autostart ? () => ensureServer(cfg) : null });
      return;
    }
    case "push": {
      if (positionals.length !== 1) usage();
      const html = fs.readFileSync(positionals[0] === "-" ? 0 : positionals[0], "utf8");
      const meta = await client.pushDocument({ title: values.title, html, inReplyTo: values["reply-to"] });
      console.log(`${meta.id}\t${meta.title}\t${meta.url}`);
      if (!hinted && deviceUnreachable(await probe(cfg.serverUrl))) console.error(`scribe-loop: ${DEVICE_HINT}`);
      return;
    }
    case "revise": {
      if (positionals.length !== 2) usage();
      const html = fs.readFileSync(positionals[1] === "-" ? 0 : positionals[1], "utf8");
      const meta = await client.reviseDocument(positionals[0], { html, title: values.title, feedbackId: values.feedback });
      console.log(`${meta.id}\trev=${meta.revision}\t${meta.title}\t${meta.url}`);
      return;
    }
    case "docs": {
      for (const d of await client.listDocuments()) {
        const fb = d.feedback.length ? d.feedback[d.feedback.length - 1].status : "-";
        console.log([d.id, d.readAt ? "read" : "unread", `rev=${d.revision || 1}`, `ink=${d.strokes}`, `feedback=${fb}`, d.title].join("\t"));
      }
      return;
    }
    case "feedback": {
      const status = values.all ? undefined : values.status || "pending";
      for (const f of await client.listFeedback(status)) {
        console.log([f.id, f.status, f.mode, f.createdAt, `strokes=${f.strokes}`, `new=${f.newStrokes}`, f.documentTitle].join("\t"));
      }
      return;
    }
    case "show": {
      if (positionals.length !== 1) usage();
      const fb = await client.getFeedback(positionals[0]);
      const source = await client.source(fb.documentId, fb.revision);
      if (!values.out) {
        console.log(describeFeedback(fb, source));
        return;
      }
      // エージェントが読むためのファイルを書き出す
      fs.mkdirSync(values.out, { recursive: true });
      fs.writeFileSync(path.join(values.out, "feedback.md"), describeFeedback(fb));
      fs.writeFileSync(path.join(values.out, "feedback.json"), JSON.stringify(fb, null, 2));
      fs.writeFileSync(path.join(values.out, "source.html"), source);
      fs.writeFileSync(path.join(values.out, "ink.svg"), await client.inkSvg(fb.id));
      const pages = await client.pages(fb.id).catch(() => ({ available: false, pages: [] }));
      for (const p of pages.pages) fs.writeFileSync(path.join(values.out, p.file), await client.page(fb.id, p.file));
      if (fb.status === "pending") await client.updateFeedback(fb.id, { status: "processing" });
      console.log(values.out);
      for (const name of fs.readdirSync(values.out).sort()) console.log(`  ${name}`);
      return;
    }
    case "wait": {
      // channels が使えないセッションで、人が「送る」を押すのを待つ。
      // 届いたフィードバックを出力して終わる（--timeout 秒を過ぎたら終了コード 1）。
      const deadline = values.timeout ? Date.now() + Number(values.timeout) * 1000 : Infinity;
      const print = (list) => {
        for (const f of list) {
          console.log([f.id, f.mode, f.documentTitle].join("\t"));
        }
        console.log("Read it with scribe_get_feedback (or scribe-loop show <ID>).");
      };
      if (values.pending) {
        const pending = await client.listFeedback("pending");
        if (pending.length) return print(pending);
      }
      let after = new Date().toISOString();
      while (Date.now() < deadline) {
        const left = Math.ceil((deadline - Date.now()) / 1000);
        const { feedback } = await client.waitFeedback(after, Math.max(1, Math.min(60, left)));
        if (feedback.length) return print(feedback);
      }
      console.error("scribe-loop: timed out");
      process.exitCode = 1;
      return;
    }
    case "done": {
      if (positionals.length !== 1) usage();
      console.log(JSON.stringify(await client.updateFeedback(positionals[0], { status: "done", note: values.note })));
      return;
    }
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
