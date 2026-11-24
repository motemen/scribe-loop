# scribe-loop

English | [日本語](README.ja.md)

Read documents written by an AI agent on a handwriting device, write on them with a pen, and send the handwriting back to the agent. It runs in the device's built-in web browser, so it needs no app and no jailbreak. It is developed and tested on the Kindle Scribe.

```
agent ──(push HTML via MCP / CLI)──▶ server ◀──(browser)── handwriting device
  ▲                                     │                  read, write, "Send"
  └──(fetch when asked, or on notification)──┘
```

- Requirements: [docs/requirements.md](docs/requirements.md) (Japanese)
- Design: [docs/design.md](docs/design.md) (Japanese)
- Prior work and findings on the device: [docs/research.md](docs/research.md) (Japanese)

## Usage

1. The agent pushes a document (HTML).
2. Open the document list in the device's browser, read a document, and write on it with the pen. Handwriting is saved automatically.
3. When you are done, press Send (送る).
4. Go back to the agent's session and ask it to read the feedback. The agent receives the source document, the position of each stroke with the text under it, and page images with the handwriting drawn over the document, and responds in the conversation.
5. To have the document itself changed, ask the agent to revise it; to get an answer you can read on the device, ask it to reply on the device.

Instead of asking in step 4, the session can be notified when you press Send (see "Notifying the session of Send" below).

### On the device

The UI labels are in Japanese.

- ペン (pen) / 消しゴム (eraser): a finger also draws. The Kindle Scribe's browser reports the pen and fingers as the same kind of input, so they cannot be told apart. A palm that touches the screen while you are writing is ignored.
- 指 (hand): dragging scrolls the page, with the pen or a finger. Switch back to the pen to write.
- 戻す (undo): removes the last stroke you drew.
- 前 / 次 (previous / next): scrolls by one screen. One page of blank paper follows each document.
- 送る (Send, top right): sends the current handwriting to the agent. When offline, it is sent once the device reconnects.
- ☐ 書き換え (revise): when checked, the agent revises the document to reflect your handwriting instead of responding in the conversation.
- 新しい版 / 前の版 (new / previous revision): 新しい版 appears when the document has been revised. A new revision starts without handwriting; 前の版 shows the previous revision with its handwriting.

## Server

Requires Node.js 20 or later. The server has no package dependencies. There is no authentication, and by default it listens on all interfaces (`0.0.0.0`), so use it only on a trusted LAN.

You do not need to start the server beforehand. When a `scribe-loop` command (such as `push` or `mcp`) gets no response from the server, it starts the server in the background with the same flags and then continues.

Run it with `npx`. In the examples below, read `scribe-loop` as `npx @motemen/scribe-loop` (or install it with `npm install -g @motemen/scribe-loop`).

```sh
scribe-loop start           # start in the background (other commands also start it)
scribe-loop status          # status, the URL to open on the device, data and log locations
scribe-loop stop
scribe-loop restart         # e.g. after updating
scribe-loop serve           # run in the foreground (for debugging)
```

On the device, open the URL shown by `scribe-loop status` (`http://<the server's LAN IP>:8470/`) and bookmark it.

The server is not registered as a system service, so it stops when the machine restarts. After a restart, run any command once or open a Claude Code session to bring it back (when the session starts the MCP server, the MCP server starts the server).

### Flags

All settings are command-line flags. Every command accepts them and passes them on to the server it starts.

| Flag | Default | Description |
| --- | --- | --- |
| `--host` | `0.0.0.0` | Address to listen on |
| `--port` | `8470` | Port to listen on |
| `--data-dir` | `$XDG_DATA_HOME/scribe-loop` | Where documents, handwriting, and feedback are stored |
| `--public-url` | guessed from the LAN IP | The server URL as seen from the device, used in document URLs returned to the agent |
| `--chrome` | searched in common locations | Chrome / Chromium used to render page images |
| `--url` | (none) | Use a server running on another machine. The command does not start a server in this case |

The server log is written to `$XDG_STATE_HOME/scribe-loop/server.log`.

Page images with the handwriting drawn over the document are rendered only when `playwright-core` (an optional dependency, normally installed along with the package) and Chrome / Chromium are available. Otherwise the agent gets an SVG of the strokes and the text under each stroke.

## Using it from an agent

There are an MCP server (stdio) and a CLI. Both call the server given by the flags (by default, port 8470 on the same machine) and start it if it does not respond.

### MCP

Register it with Claude Code as follows. Add flags after `mcp` (for example, `mcp --port 8480`).

```sh
claude mcp add -s user scribe-loop -- npx -y @motemen/scribe-loop mcp
```

| Tool | Description |
| --- | --- |
| `scribe_push_document` | Push a document (HTML). Passing a feedback ID as `in_reply_to` makes it a reply to that feedback |
| `scribe_revise_document` | Revise a document as a new revision. The previous revision and its handwriting are kept |
| `scribe_list_feedback` | List pending feedback |
| `scribe_get_feedback` | Get a piece of feedback (the source document, each stroke's position and the text under it, page images) |
| `scribe_update_feedback` | Change the status of a piece of feedback |
| `scribe_list_documents` | List documents |

### Notifying the session of Send

The MCP server supports Claude Code [channels](https://code.claude.com/docs/en/channels.md) (research preview), a mechanism for an MCP server to send events into an open session. In a session started with channels enabled, pressing Send on the device delivers an event, and the agent reads the feedback and responds in the conversation.

```sh
claude --dangerously-load-development-channels server:scribe-loop
```

- A confirmation screen appears at startup; choose that you are using it for local development. During the preview, custom channels are not on the allowlist.
- Events arrive only while the session is open. If the session is busy, the events are read together after the current work finishes.
- To turn notifications off, pass `--no-channel` to the MCP server.

In sessions without channels (started without the flag, blocked by organization policy, and so on), the agent waits by running `scribe-loop wait` in the background. The command prints the ID of new feedback and exits when it arrives, and Claude Code then prompts the agent to continue. The MCP server includes how to run this command in its instructions to the agent, so you do not need to tell the agent.

### CLI

```sh
scribe-loop push doc.html [--title TITLE] [--reply-to <feedback ID>]
scribe-loop revise <document ID> doc.html [--feedback <feedback ID>]
scribe-loop docs
scribe-loop feedback [--all]
scribe-loop show <feedback ID> [--out <dir>]   # --out also writes the images
scribe-loop done <feedback ID>
scribe-loop wait [--pending] [--timeout SECONDS]   # wait for new feedback
```

## Development

```sh
npm install
npm test
```

To use a local checkout, run `npx /path/to/scribe-loop` (or `node /path/to/scribe-loop/bin/scribe-loop.mjs`) instead of `npx @motemen/scribe-loop`. To try exactly what would be published, run the tarball made by `npm pack` with `npx ./motemen-scribe-loop-0.1.0.tgz`.
