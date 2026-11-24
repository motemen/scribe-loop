# 先行事例の調査

要件定義の「10. 調査済みの参考資料」に挙げた4つの OSS のコードを読んだ結果です（2026年11月時点の各リポジトリの main）。どれもビルドや実行はしていません。

| | 方式 | Jailbreak | AI 連携 |
| --- | --- | --- | --- |
| [Hermes Notebook](https://github.com/lEWFkRAD/hermes-agents-guide-to-the-galaxy) | 標準ブラウザ + Node のサーバー | 不要 | あり |
| [Ignite](https://github.com/markrai/ignite) | ネイティブ（Rust）+ 同期サーバー + Web 版 | 必要 | なし |
| [Grimoire](https://github.com/grimoire-notes/grimoire-scribe) | ネイティブ（Rust、FBInk） | 必要 | なし |
| [Kindle Scribe MCP](https://github.com/starkshtlm/kindle-scribe-mcp) | PDF をメールで送り、書き込み済み PDF をメールで受け取る | 不要 | あり（MCP） |

標準ブラウザでの手書きを実装しているのは Hermes Notebook だけです。

## 入力イベント

- **Hermes**（`public/live.js`）
  - Pointer → MSPointer → Touch → Mouse の順に、使えるイベントを使う。
  - `getCoalescedEvents` があれば間の点も取り込み、`setPointerCapture` で線が画面の端から出ても追う。
  - 筆圧は使わない。
  - ペンと指を `pointerType` で区別せず、ペン・手（スクロール）・消しゴムのモードをボタンで切り替える。
  - 消しゴムは当たったストロークを丸ごと消す。
  - ボタンは pointerup で反応させる。古いブラウザではペンで書いた直後に click が届かないことがあるため。
- **Ignite の Web 版**（Kindle 以外のブラウザ向け）
  - `pointerType` が pen なら描画し、touch はスクロールや拡大縮小に回す。
  - 消しゴムはペンの反対側で、`buttons & 32` で判定する。
  - 筆圧は `pressure` で取る。一度も筆圧が来なかったペンは固定幅にする。
- **ネイティブの2つ**
  - 入力デバイス（evdev）を直接読み、ほかのプロセスに渡らないよう占有する（`EVIOCGRAB`）。
  - 筆圧・傾き・消しゴム端（`BTN_TOOL_RUBBER`）を扱う。
  - パームリジェクションは「ペンが近づいている間、指の入力はすべて捨てる」。

## 描画と電子ペーパー向けの工夫

- **Hermes**
  - SVG の path で描き、2次曲線で滑らかにする。
  - アニメーションを使わず、`touch-action: none` を指定する。
- **ネイティブの2つ**
  - 書いている間だけ、ドライバのペン用モードと高速な更新（DU 波形の部分更新）を直接呼ぶ。
  - Grimoire の実測（`docs/INK-PERFORMANCE.md`）では、通常の更新だと描画が最大 302ms 待たされ、ペン用モードなら 1ms 以下で始まる。
  - 書き終えてから、灰色を正しく出せる更新で描き直す。画面の切り替え時には、全画面の更新で残像を消す。
  - **これらはブラウザからは使えない。** ブラウザでの遅延は、ブラウザと端末の描画経路で決まる。

## 保存と同期

- **Hermes**
  - 0〜1 に正規化した座標を使う。
  - 操作（追加・削除）を localStorage に貯めて、XHR でサーバーに送る。
  - 同期は5秒ごと。画面が隠れている間は30秒ごとに減らす。
  - 資料は10秒ごとに取りに行き、内容が変わったときだけ描き直す（電子ペーパーの書き換えを減らすため）。
- **Ignite**
  - ストロークを1本書き終えるたびに、IndexedDB の送信待ちキューに書く。
  - 操作に ID を付けて同じものを再送し、サーバーが重複を除く（冪等）。
  - 衝突したら自動ではマージせず、そこで止まる。

## AI との連携

- **Hermes**
  - 資料は HTML で、スクリプトを除去してから、スクリプトの動かない iframe で表示する。
  - ストロークごとに、その下の要素を `elementFromPoint` で調べ、セレクタと本文の抜粋を記録する。
  - 送るときは、手書き部分を切り出した画像を vision モデルで文字起こしし、その結果と書き込みの対象・ページの内容をエージェントに渡す。
- **Kindle Scribe MCP**
  - 書き込み済みの PDF を画像にして、そのまま LLM に渡す。文字起こしはしない。
  - 原文を「事実」、手書きを「変更指示」として渡す。
  - 見出しに番号を振らせて、手書きの参照（「2.3 参照」など）がどこを指すか一意に決まるようにする。
  - 取り消し線は削除、矢印は挿入、と記号の意味をツールの説明で LLM に伝える。
  - 処理が終わったら ack で処理済みにする。

## 実機で分かったこと

- 初代 Kindle Scribe（ファームウェア最新、2026年11月）の標準ブラウザの UA は `Silk/80.4.14 like Chrome/80.0.3987.119`（Android 9）。
- PointerEvent と `getCoalescedEvents` は使える。Service Worker は使えない。
- **ペンも `pointerType: "touch"` で届く**（`Touch.force` は null、`radiusX` は 25 で一定）。Hermes Notebook がペンと手をボタンで切り替えているのは、このためと考えられる。
- ペン・指・手のひらは、どれも `pointerType: "touch"`、`pressure` 0.5、`width`/`height` 50、`buttons` 1、傾き 0 で届き、区別できない。筆圧も取れない。
- 手のひらを置いても、同時に届く接触は 1 つだけ（`touches.length` は常に 1）。手のひらを置いたままペンで書くと `pointercancel` が来る。ペンを浮かせたとき（ホバー）のイベントは来ない。
- 1 回の `pointermove` にまとまる点の数は、ペンで 30〜45、指で 10〜15、手のひらで 4〜5 と違う。ペンのほうがサンプリングが細かいためと思われるが、重なりもあるので判別には使っていない。
- `getCoalescedEvents` で 1 秒あたり約 285 点を取りこぼしなく取れる。ただしイベントは 1 回に 13〜15 点ずつ、約 50ms おきにしか届かないので、描画の更新は 1 秒に約 20 回になる。体感は「遅いけどなめらか」。
- `pointerrawupdate` はない。自己署名の証明書の HTTPS でも `isSecureContext` は true になるが、`window.onpointerrawupdate` はなく、イベントも届かない。
- HTTPS では Service Worker が使える（HTTP では使えない）。
- スリープすると JavaScript のタイマーが止まり、復帰後に送信を再開できる。

## このプロジェクトへの示唆

- ブラウザでは、ネイティブのような低遅延の工夫はできない。実機で、遅延が許容できるかを最初に確かめる。
- 入力は Pointer Events を基本にし、`pointerType`・`pressure`・`buttons` が実機で何を返すかを確かめてから、パームリジェクションと消しゴムの方式を決める。
- 書き込みは、端末にすぐ保存し、ID 付きの操作として冪等に送る（Hermes と Ignite の方式）。
- AI には、元の資料・資料と手書きを重ねた画像・ストロークとその下の要素を渡し、解釈はエージェントの vision に任せる（Kindle Scribe MCP と Hermes の方式）。
