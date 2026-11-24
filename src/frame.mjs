// エージェントの HTML を、Kindle で読み書きしやすい形に包む。
// 既定のスタイルを先頭に差し込むので、資料側の CSS で上書きできる。

export const FRAME_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "media-src data:",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

export const BASE_CSS = `
html { background: #fff; }
body {
  margin: 0;
  /* 右に書き込み用の広い余白を取る */
  padding: 28px 33% 48px 36px;
  color: #000;
  background: #fff;
  font-family: "Noto Serif JP", "Hiragino Mincho ProN", serif;
  font-size: 20px;
  line-height: 1.8;
  -webkit-text-size-adjust: 100%;
  -webkit-user-select: none;
  user-select: none;
  overflow: hidden;
}
h1 { font-size: 30px; line-height: 1.4; }
h2 { font-size: 24px; margin-top: 40px; }
h3 { font-size: 21px; }
img, svg, video { max-width: 100%; height: auto; }
table { border-collapse: collapse; }
th, td { border: 1px solid #000; padding: 4px 10px; }
pre { font-size: 16px; line-height: 1.5; border: 1px solid #000; padding: 10px; white-space: pre-wrap; word-break: break-all; }
code { font-size: 0.9em; }
a { color: #000; }
* { animation: none !important; transition: none !important; }
`;

export function wrapDocument(html) {
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><style>${BASE_CSS}</style>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + head);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${head}</head>`);
  return `<!doctype html><html lang="ja"><head>${head}</head><body>${html}</body></html>`;
}
