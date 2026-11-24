#!/usr/bin/env node
// scribe-loop のコマンド。
//
//   scribe-loop start                        サーバーを裏で起動する（立っていなければ）
//   scribe-loop status                       サーバーの状態
//   scribe-loop stop                         サーバーを止める
//   scribe-loop restart                      サーバーを起動し直す
//   scribe-loop serve                        サーバーを手前で動かす（デバッグ用）
//   scribe-loop mcp [--no-channel]           MCP サーバー（stdio）を起動する
//   scribe-loop push <file.html> [--title T] [--reply-to <feedback-id>]
//   scribe-loop revise <document-id> <file.html> [--feedback <feedback-id>] [--title T]
//   scribe-loop docs                         資料の一覧
//   scribe-loop feedback [--all|--status S]  フィードバックの一覧（既定は未処理）
//   scribe-loop show <feedback-id> [--out <dir>]
//   scribe-loop done <feedback-id> [--note N]
//
// どのコマンドにも付けられるフラグ:
//   --host <addr>        待ち受けるアドレス（既定 0.0.0.0）
//   --port <port>        待ち受けるポート（既定 8470）
//   --data-dir <dir>     データの置き場所（既定 $XDG_DATA_HOME/scribe-loop）
//   --public-url <url>   Kindle から見たサーバーの URL（既定は LAN 側の IP から推測）
//   --chrome <path>      合成画像を作るときに使う Chrome / Chromium
//   --url <url>          別のマシンで動いているサーバーを使う（このときは自分では起動しない）
//
// サーバーを使うコマンドは、サーバーが立っていなければ、同じフラグで裏で起動する。

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { config, SERVER_OPTIONS } from "../src/config.mjs";
import { Client, describeFeedback } from "../src/client.mjs";
import { ensureServer, stopServer, probe, logFile } from "../src/daemon.mjs";

function usage() {
  const text = fs
    .readFileSync(new URL(import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.startsWith("//   "))
    .map((l) => l.slice(3));
  console.error("usage:\n" + text.join("\n"));
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
    },
  }));
} catch (err) {
  console.error(err.message);
  usage();
}
const cfg = config(values);

// サーバーにつながらなかったときだけ、起動してからやり直す
async function ensure() {
  const { status, started } = await ensureServer(cfg);
  if (started) console.error(`scribe-loop: サーバーを起動しました ${status.publicUrl || cfg.serverUrl}（pid ${status.pid}）`);
}

function printStatus(status) {
  console.log(`running\tpid ${status.pid}\tversion ${status.version}\tsince ${status.startedAt}`);
  console.log(`listen\t${status.host}:${status.port}`);
  if (status.publicUrl) console.log(`kindle\t${status.publicUrl}/`);
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
      runMcp(cfg, { channel: !values["no-channel"], ensure: cfg.autostart ? () => ensureServer(cfg) : null });
      return;
    }
    case "push": {
      if (positionals.length !== 1) usage();
      const html = fs.readFileSync(positionals[0] === "-" ? 0 : positionals[0], "utf8");
      const meta = await client.pushDocument({ title: values.title, html, inReplyTo: values["reply-to"] });
      console.log(`${meta.id}\t${meta.title}\t${meta.url}`);
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
