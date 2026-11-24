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
4. エージェントのセッションに戻り、「Scribe のフィードバックを読んで」と頼む。エージェントは、元の資料、線ごとの位置とその下にある文字、資料と手書きを重ねた画像を受け取り、セッションの会話で応答する。
5. 資料そのものを直してほしいときは「書き換えて」、Kindle で読める形で答えがほしいときは「Scribe に返事して」と頼む。

手順 4 で頼む代わりに、「送る」と同時にセッションへ知らせることもできます（後述の「「送る」をセッションに知らせる」）。

### Kindle Scribe の画面

- 「ペン」「消しゴム」: 指でなぞっても線になる。初代 Scribe のブラウザは、ペンと指を同じ種類の入力として渡すため区別できない。書いている最中に別の場所へ触れた手のひらは無視する。
- 「戻す」: 自分が最後に書いた線を消す。
- 「前」「次」: ページを送る。資料の後ろには、自由に書ける白紙が 1 ページ付く。
- 「送る」（右上）: その時点の書き込みをエージェントに送る。オフラインのときは、つながってから送る。
- 「☐ 書き換え」: チェックを入れてから送ると、エージェントは会話で応答する代わりに、書き込みを反映して資料を書き換える。
- 「新しい版」「前の版」: 資料が書き換えられると「新しい版」が出る。新しい版は書き込みのない状態で始まり、前の版とその書き込みは「前の版」から見返せる。

## サーバー

Node.js 20 以上で動きます。サーバー自体は外部のパッケージに依存しません。認証はなく、既定ですべてのインターフェース（`0.0.0.0`）で待ち受けるので、信頼できる LAN の中だけで使ってください。

サーバーを先に起動しておく必要はありません。`scribe-loop` のコマンド（`push` や `mcp` など）は、サーバーが応答しなければ、自分と同じフラグを付けてサーバーを裏で起動し、それから処理を続けます。

```sh
npm install                 # 任意: 合成画像を作るための playwright-core
npm link                    # scribe-loop コマンドを使えるようにする（任意）

scribe-loop start           # 裏で起動する（ほかのコマンドでも自動で起動する）
scribe-loop status          # 状態、Kindle で開く URL、データとログの場所
scribe-loop stop
scribe-loop restart         # 更新したあとなど
scribe-loop serve           # 手前で動かす（デバッグ用）
```

Kindle Scribe のブラウザでは、`scribe-loop status` が表示する URL（`http://<サーバーの LAN 側の IP>:8470/`）を開き、ブックマークします。

サーバーは常駐するサービスとして登録されていないので、マシンを再起動すると止まります。再起動のあとは、何かコマンドを一度実行するか、Claude Code のセッションを開けば立ち上がります（セッションが MCP サーバーを起動するときに、MCP サーバーがサーバーも起動するため）。

### フラグ

設定はすべてコマンドラインのフラグで渡します。フラグはどのコマンドにも付けられ、裏で起動するサーバーにもそのまま渡ります。

| フラグ | 既定 | 内容 |
| --- | --- | --- |
| `--host` | `0.0.0.0` | 待ち受けるアドレス |
| `--port` | `8470` | 待ち受けるポート |
| `--data-dir` | `$XDG_DATA_HOME/scribe-loop` | 資料・書き込み・フィードバックの置き場所 |
| `--public-url` | LAN 側の IP から推測 | エージェントに資料の URL を返すときの、Kindle から見たサーバーの URL |
| `--chrome` | よくある場所を探す | 合成画像を作るときに使う Chrome / Chromium |
| `--url` | （なし） | 別のマシンで動いているサーバーを使う。このときは自分では起動しない |

ログは `$XDG_STATE_HOME/scribe-loop/server.log` に書きます。

資料と手書きを重ねた画像は、`playwright-core`（`npm install` で入る任意の依存）と Chrome / Chromium があるときだけ作ります。ないときは、手書きの線だけの SVG と、線の下にある文字をエージェントに渡します。

## エージェントから使う

MCP サーバー（stdio）と CLI があります。どちらも、フラグで指定したサーバー（既定は同じマシンの 8470 番）を呼び、応答がなければ起動します。

### MCP

Claude Code では、次のように登録します。フラグを付けるときは `mcp` の後ろに続けます（例: `mcp --port 8480`）。

```sh
claude mcp add -s user scribe-loop -- node /path/to/scribe-loop/bin/scribe-loop.mjs mcp
```

| ツール | 内容 |
| --- | --- |
| `scribe_push_document` | 資料（HTML）を登録する。`in_reply_to` にフィードバックの ID を渡すと、その返信になる |
| `scribe_revise_document` | 資料を新しい版に書き換える。前の版と書き込みは残る |
| `scribe_list_feedback` | 未処理のフィードバックの一覧 |
| `scribe_get_feedback` | フィードバックの中身（元の資料、線ごとの位置とその下の文字、合成画像） |
| `scribe_update_feedback` | フィードバックの状態を変える |
| `scribe_list_documents` | 資料の一覧 |

### 「送る」をセッションに知らせる

MCP サーバーは、Claude Code の [channels](https://code.claude.com/docs/en/channels.md)（研究プレビュー）に対応しています。channels は、MCP サーバーから開いているセッションへイベントを送る仕組みです。channels を有効にして起動したセッションでは、Kindle で「送る」を押すとイベントが届き、エージェントはフィードバックを読んで会話で応答します。

```sh
claude --dangerously-load-development-channels server:scribe-loop
```

- 起動すると確認の画面が出るので、ローカルでの開発用であることを選びます。プレビューのあいだ、独自に作った channel は許可リストに載っていないためです。
- イベントが届くのは、そのセッションを開いているあいだだけです。セッションが作業中なら、届いたイベントはその作業が終わってからまとめて読まれます。
- 知らせる必要がなければ、MCP サーバーに `--no-channel` を付けます。

channels を使えないセッション（有効にせずに起動した、組織のポリシーで止められている、など）では、エージェントが `scribe-loop wait` をバックグラウンドで実行して待ちます。このコマンドは新しいフィードバックが届くと ID を出力して終わるので、Claude Code はその時点でエージェントに続きを促します。MCP サーバーはエージェントへの説明にこのコマンドの実行方法を含めているので、人が指示する必要はありません。

### CLI

```sh
scribe-loop push doc.html [--title 題名] [--reply-to <フィードバックの ID>]
scribe-loop revise <資料の ID> doc.html [--feedback <フィードバックの ID>]
scribe-loop docs
scribe-loop feedback [--all]
scribe-loop show <フィードバックの ID> [--out <ディレクトリ>]   # --out で画像なども書き出す
scribe-loop done <フィードバックの ID>
scribe-loop wait [--pending] [--timeout 秒]   # 新しいフィードバックが届くまで待つ
```

## 開発

```sh
npm test
```
