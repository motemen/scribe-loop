// 資料と手書きを重ねた画像を作る。
// playwright-core と Chrome（または Chromium）があるときだけ動く。なければ null を返す。
//
// SCRIBE_LOOP_CHROME に Chrome の実行ファイルを指定できる。指定がなければよくある場所を探す。

import fs from "node:fs";
import path from "node:path";
import { wrapDocument } from "./frame.mjs";

const CANDIDATES = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

let browserPromise = null;

async function getBrowser() {
  if (browserPromise) return browserPromise;
  browserPromise = (async () => {
    let chromium;
    try {
      ({ chromium } = await import("playwright-core"));
    } catch {
      return null;
    }
    const executablePath = process.env.SCRIBE_LOOP_CHROME || CANDIDATES.find((p) => fs.existsSync(p));
    if (!executablePath) return null;
    return chromium.launch({ executablePath });
  })().catch((err) => {
    console.error("render: cannot launch browser:", err.message);
    browserPromise = null;
    return null;
  });
  return browserPromise;
}

export function inkSvg(strokes, width, height) {
  const paths = strokes
    .filter((s) => (s.points || []).length)
    .map((s) => {
      const pts = s.points;
      let d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
      if (pts.length === 1) d += " l0.1 0";
      return `<path data-stroke="${s.id}" d="${d}" fill="none" stroke="#000" stroke-width="${s.width || 2.5}" stroke-linecap="round" stroke-linejoin="round"/>`;
    })
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(width)}" height="${Math.ceil(height)}" viewBox="0 0 ${Math.ceil(width)} ${Math.ceil(height)}">\n${paths}\n</svg>`;
}

export function strokesHeight(strokes) {
  let h = 0;
  for (const s of strokes) for (const p of s.points || []) h = Math.max(h, p[1]);
  return h;
}

// ページごとの PNG を outDir に書き、ファイル名の配列を返す。作れなければ null。
export async function renderPages({ html, strokes, surface, outDir }) {
  const width = Math.round((surface && surface.width) || 930);
  const pageHeight = Math.round((surface && surface.pageHeight) || 1132);
  const manifest = path.join(outDir, "pages.json");
  if (fs.existsSync(manifest)) return JSON.parse(fs.readFileSync(manifest, "utf8"));
  const browser = await getBrowser();
  if (!browser) return null;
  const page = await browser.newPage({ viewport: { width, height: pageHeight } });
  try {
    await page.setContent(wrapDocument(html), { waitUntil: "load" });
    const contentHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const total = Math.max(contentHeight + pageHeight, strokesHeight(strokes) + 40);
    const pages = Math.ceil(total / pageHeight);
    const fullHeight = pages * pageHeight;
    const svg = inkSvg(strokes, width, fullHeight);
    await page.evaluate(
      ({ svg, fullHeight }) => {
        document.body.style.overflow = "visible";
        document.documentElement.style.minHeight = fullHeight + "px";
        document.body.style.minHeight = fullHeight + "px";
        const layer = document.createElement("div");
        layer.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;z-index:2147483647";
        layer.innerHTML = svg;
        document.body.appendChild(layer);
      },
      { svg, fullHeight },
    );
    fs.mkdirSync(outDir, { recursive: true });
    const files = [];
    for (let i = 0; i < pages; i += 1) {
      const top = i * pageHeight;
      const hasInk = strokes.some((s) => (s.points || []).some((p) => p[1] >= top && p[1] < top + pageHeight));
      const name = `page-${i + 1}.png`;
      await page.screenshot({
        path: path.join(outDir, name),
        clip: { x: 0, y: top, width, height: pageHeight },
        fullPage: true,
      });
      files.push({ page: i + 1, file: name, hasInk });
    }
    fs.writeFileSync(manifest, JSON.stringify(files));
    return files;
  } finally {
    await page.close();
  }
}

export async function closeRenderer() {
  const b = await browserPromise;
  if (b) await b.close();
}
