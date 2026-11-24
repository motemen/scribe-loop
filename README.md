# scribe-loop

AI エージェントが作った資料を Kindle Scribe の標準ブラウザで読み、ペンで直接書き込んで、エージェントに返すための環境です。Jailbreak は使いません。

```
エージェント ──(MCP / CLI で HTML を登録)──▶ サーバー ◀──(ブラウザ)── Kindle Scribe
     ▲                                          │            読む・書き込む・「送る」
     └──(「読んで」と頼まれたら、または通知で取りに行く)──┘
```

- 要件: [docs/requirements.md](docs/requirements.md)
- 設計: [docs/design.md](docs/design.md)
- 先行事例と実機での調査: [docs/research.md](docs/research.md)

## 使い方

1. エージェントが資料（HTML）を登録する。
2. Kindle Scribe のブラウザで一覧を開き、資料を読んで、ペンで書き込む。書き込みは自動で保存される。
3. 書き終えたら「送る」を押す。
4. エージェントのセッションに戻り、「Scribe のフィードバックを読んで」と頼む（channels を使えば自動で届く）。エージェントは元の資料・手書きの位置とその下の文字・資料と手書きを重ねた画像を受け取り、セッションの会話で応答する。
5. 必要なら「改訂版を Scribe に送って」などと頼む。返信の資料は Kindle の一覧で元の資料の下に出る。

Kindle Scribe の画面:

- **ペン / 消しゴム**: 指でもペンでも線になる（初代 Scribe のブラウザはペンと指を区別できない）。書いている最中に手のひらが触れても無視する。
- **戻す**: 自分が最後に書いた線を消す。
- **前 / 次**: ページを送る。資料の後ろに白紙が 1 ページ付く。
- **送る**: その時点の書き込みをエージェントに送る。オフラインなら、つながってから送る。

## サーバー

Node.js 20 以上。サーバー自体は依存なしで動きます。認証はないので、LAN の中だけで使ってください。

```sh
npm install                # 任意: 合成画像を作るための playwright-core
SCRIBE_LOOP_HOST=<サーバーの LAN 側の IP> node bin/scribe-loop.mjs serve
```

Kindle Scribe のブラウザで `http://<サーバーの LAN 側の IP>:8470/` を開き、ブックマークします。

| 環境変数 | 既定 | 内容 |
| --- | --- | --- |
| `SCRIBE_LOOP_HOST` | `127.0.0.1` | 待ち受ける IP。端末から使うには LAN 側の IP（または `0.0.0.0`）にする |
| `SCRIBE_LOOP_PORT` | `8470` | HTTP のポート |
| `SCRIBE_LOOP_TLS_CERT` / `SCRIBE_LOOP_TLS_KEY` | （なし） | 証明書と鍵の PEM。両方あると HTTPS でも待ち受ける |
| `SCRIBE_LOOP_TLS_PORT` | `8471` | HTTPS のポート |
| `SCRIBE_LOOP_DATA_DIR` | `$XDG_DATA_HOME/scribe-loop` | 資料・書き込み・フィードバックの置き場所 |
| `SCRIBE_LOOP_PUBLIC_URL` | （なし） | エージェントに資料の URL を返すときの、Kindle から見たサーバーの URL |
| `SCRIBE_LOOP_CHROME` | よくある場所を探す | 合成画像を作るときに使う Chrome / Chromium |

資料と手書きを重ねた画像は、`playwright-core`（`npm install` で入る任意の依存）と Chrome / Chromium があるときだけ作ります。ないときは、手書きの線だけの SVG と、線の下にある文字をエージェントに渡します。

HTTPS は必須ではありません（初代 Scribe では、HTTPS にしても描画は速くなりませんでした）。使う場合は、自己署名の証明書をサーバーに渡すか、Caddy などのリバースプロキシで TLS を終端して HTTP のポートに転送します。

### 常駐させる（systemd の user unit の例）

```ini
# ~/.config/systemd/user/scribe-loop.service
[Unit]
Description=scribe-loop
After=network-online.target

[Service]
EnvironmentFile=%h/.config/scribe-loop/env
ExecStart=/path/to/node /path/to/scribe-loop/bin/scribe-loop.mjs serve
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

## エージェントから使う

MCP サーバー（stdio）と CLI があります。どちらも `SCRIBE_LOOP_URL`（既定 `http://127.0.0.1:8470`）のサーバーを呼びます。

### MCP

Claude Code の場合:

```sh
claude mcp add scribe-loop -e SCRIBE_LOOP_URL=http://<サーバー>:8470 -- node /path/to/scribe-loop/bin/scribe-loop.mjs mcp
```

| ツール | 内容 |
| --- | --- |
| `scribe_push_document` | 資料（HTML）を登録する。`in_reply_to` にフィードバックの ID を渡すと、その返信になる |
| `scribe_list_feedback` | 未処理のフィードバックの一覧 |
| `scribe_get_feedback` | フィードバックの中身（元の資料、線ごとの位置と下の文字、合成画像） |
| `scribe_update_feedback` | フィードバックの状態を変える |
| `scribe_list_documents` | 資料の一覧 |

### 「送る」を Claude Code に通知する（channels）

MCP サーバーは Claude Code の [channels](https://code.claude.com/docs/en/channels.md)（研究プレビュー）に対応しています。channels を有効にして起動したセッションでは、Kindle で「送る」を押すとイベントが届き、エージェントがフィードバックを読んで、セッションの会話で応答します（Kindle に資料を返すのは、頼んだときだけです）。

```sh
claude --dangerously-load-development-channels server:scribe-loop
```

- 起動時に確認の画面が出るので、ローカルでの開発用であることを選びます（独自の channel は、プレビューのあいだ許可リストに載っていないため）。
- イベントが届くのは、そのセッションが開いているあいだだけです。作業中に届いたものは、区切りのよいところでまとめて処理されます。
- 通知を止めるには、MCP サーバーの環境変数に `SCRIBE_LOOP_CHANNEL=0` を設定します。

### CLI

```sh
scribe-loop push doc.html [--title 題名] [--reply-to <フィードバックの ID>]
scribe-loop docs
scribe-loop feedback [--all]
scribe-loop show <フィードバックの ID> [--out <ディレクトリ>]   # --out で画像なども書き出す
scribe-loop done <フィードバックの ID>
```

## 検証用のプロトタイプ

`prototype/` は、Kindle Scribe の標準ブラウザで手書きが実用になるかを確かめたときのページです（[docs/verification.md](docs/verification.md)）。`node prototype/server.mjs` で動きます（環境変数は上と同じ）。

## 開発

```sh
npm test
```
