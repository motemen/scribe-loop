# scribe-loop

AI エージェントが作った資料を Kindle Scribe の標準ブラウザで読み、ペンで直接書き込んで、エージェントに返すための環境です。Jailbreak は使いません。

いまは、Kindle Scribe の標準ブラウザで手書きが実用になるかを確かめる段階です。

- 要件: [docs/requirements.md](docs/requirements.md)
- 先行事例の調査: [docs/research.md](docs/research.md)
- 実機での検証の手順: [docs/verification.md](docs/verification.md)

## 検証用プロトタイプ

依存のない Node.js（20 以上）のサーバーと、静的なページだけでできています。認証はありません。LAN の中だけで使ってください。

```sh
SCRIBE_LOOP_HOST=<サーバーの LAN 側の IP> node prototype/server.mjs
```

Kindle Scribe のブラウザで `http://<サーバーの LAN 側の IP>:8470/` を開きます。

| 環境変数 | 既定 | 内容 |
| --- | --- | --- |
| `SCRIBE_LOOP_HOST` | `127.0.0.1` | 待ち受ける IP。端末から使うには LAN 側の IP（または `0.0.0.0`）にする |
| `SCRIBE_LOOP_PORT` | `8470` | 待ち受けるポート |
| `SCRIBE_LOOP_DATA_DIR` | `$XDG_DATA_HOME/scribe-loop/prototype` | ログと書き込みの置き場所 |
| `SCRIBE_LOOP_TLS_CERT` / `SCRIBE_LOOP_TLS_KEY` | （なし） | 証明書と鍵の PEM ファイル。両方あると HTTPS でも待ち受ける |
| `SCRIBE_LOOP_TLS_PORT` | `8471` | HTTPS で待ち受けるポート |

### HTTPS

`pointerrawupdate` などは secure context（HTTPS）でしか使えません。HTTPS にするには、次のどちらかを使います。

- サーバーに証明書を渡す。自己署名の証明書でもかまいません（端末のブラウザで警告を一度越える必要があります）。

  ```sh
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=scribe-loop" \
    -addext "subjectAltName=IP:<サーバーの LAN 側の IP>" \
    -keyout key.pem -out cert.pem
  SCRIBE_LOOP_TLS_CERT=cert.pem SCRIBE_LOOP_TLS_KEY=key.pem SCRIBE_LOOP_HOST=... node prototype/server.mjs
  ```

- Caddy などのリバースプロキシで TLS を終端し、HTTP のポートに転送する。

データの置き場所:

- `logs/YYYY-MM-DD.jsonl`: 端末の環境、入力イベントの統計、ページの一生（スリープ・通信切断）、評価
- `docs/<文書>.jsonl`: 書き込みの操作（追加・削除・全消去）。`/render?doc=<文書>` で SVG として見られる

### 常駐させる（systemd の user unit の例）

```ini
# ~/.config/systemd/user/scribe-loop-prototype.service
[Unit]
Description=scribe-loop prototype
After=network-online.target

[Service]
EnvironmentFile=%h/.config/scribe-loop/env
ExecStart=/path/to/node /path/to/scribe-loop/prototype/server.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

`~/.config/scribe-loop/env` に `SCRIBE_LOOP_HOST=...` を書き、`systemctl --user enable --now scribe-loop-prototype` で起動します。
