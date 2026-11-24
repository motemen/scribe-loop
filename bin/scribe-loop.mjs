#!/usr/bin/env node
// scribe-loop のコマンド。
//
//   scribe-loop start                        サーバーを裏で起動する（立っていなければ）
//   scribe-loop status                       サーバーの状態
//   scribe-loop stop                         サーバーを止める
//   scribe-loop restart                      サーバーを起動し直す
//   scribe-loop serve                        サーバーを手前で動かす（デバッグや systemd 用）
//   scribe-loop mcp                          MCP サーバー（stdio）を起動する
//   scribe-loop push <file.html> [--title T] [--reply-to <feedback-id>]
//   scribe-loop revise <document-id> <file.html> [--feedback <feedback-id>]
//   scribe-loop docs                         資料の一覧
//   scribe-loop feedback [--all|--status S]  フィードバックの一覧（既定は未処理）
//   scribe-loop show <feedback-id> [--out <dir>]
//   scribe-loop done <feedback-id> [--note N]
//
// サーバーを使うコマンドは、サーバーが立っていなければ裏で起動する（serve 以外は起動を気にしなくてよい）。
// 設定は ~/.config/scribe-loop/env（KEY=VALUE）と環境変数から読む。
// SCRIBE_LOOP_URL で別のマシンのサーバーを指したときは、起動はしない。

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { config } from "../src/config.mjs";
import { Client, describeFeedback } from "../src/client.mjs";
import { ensureServer, stopServer, probe, logFile } from "../src/daemon.mjs";

const [command, ...rest] = process.argv.slice(2);
const cfg = config();

function usage() {
  const text = fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//   ")).map((l) => l.slice(3));
  console.error("usage:\n" + text.join("\n"));
  process.exit(2);
}

// サーバーにつながらなかったときだけ、起動してからやり直す
async function ensure() {
  const { status, started } = await ensureServer(cfg);
  if (started) console.error(`scribe-loop: サーバーを起動しました ${status.http || cfg.serverUrl}（pid ${status.pid}）`);
}

function printStatus(status) {
  console.log(`running\tpid ${status.pid}\tversion ${status.version}\tsince ${status.startedAt}`);
  if (status.http) console.log(`http\t${status.http}`);
  if (status.https) console.log(`https\t${status.https}`);
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
      console.error(status ? `scribe-loop: サーバー（pid ${status.pid}）を止めました` : "scribe-loop: サーバーは動いていません");
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
      runMcp(cfg, { channel: process.env.SCRIBE_LOOP_CHANNEL !== "0", ensure: cfg.autostart ? () => ensureServer(cfg) : null });
      return;
    }
    case "push": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { title: { type: "string" }, "reply-to": { type: "string" } } });
      if (positionals.length !== 1) usage();
      const html = fs.readFileSync(positionals[0] === "-" ? 0 : positionals[0], "utf8");
      const meta = await client.pushDocument({ title: values.title, html, inReplyTo: values["reply-to"] });
      console.log(`${meta.id}\t${meta.title}\t${meta.url}`);
      return;
    }
    case "revise": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { feedback: { type: "string" }, title: { type: "string" } } });
      if (positionals.length !== 2) usage();
      const html = fs.readFileSync(positionals[1] === "-" ? 0 : positionals[1], "utf8");
      const meta = await client.reviseDocument(positionals[0], { html, title: values.title, feedbackId: values.feedback });
      console.log(`${meta.id}\trev=${meta.revision}\t${meta.title}\t${meta.url}`);
      return;
    }
    case "docs": {
      for (const d of await client.listDocuments()) {
        const fb = d.feedback.length ? d.feedback[d.feedback.length - 1].status : "-";
        console.log([d.id, d.readAt ? "read" : "unread", `ink=${d.strokes}`, `feedback=${fb}`, d.title].join("\t"));
      }
      return;
    }
    case "feedback": {
      const { values } = parseArgs({ args: rest, options: { all: { type: "boolean" }, status: { type: "string" } } });
      const status = values.all ? undefined : values.status || "pending";
      for (const f of await client.listFeedback(status)) {
        console.log([f.id, f.status, f.mode, f.createdAt, `strokes=${f.strokes}`, `new=${f.newStrokes}`, f.documentTitle].join("\t"));
      }
      return;
    }
    case "show": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { out: { type: "string" } } });
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
    case "done": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { note: { type: "string" } } });
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
