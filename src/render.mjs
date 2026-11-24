// 資料と手書きを重ねた画像を作る。
// playwright-core と Chrome（または Chromium）があるときだけ動く。なければ null を返す。
//
// Chrome の実行ファイルは --chrome で指定できる。指定がなければよくある場所を探す。

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

async function getBrowser(chrome) {
  if (browserPromise) return browserPromise;
  browserPromise = (async () => {
    let chromium;
    try {
      ({ chromium } = await import("playwright-core"));
    } catch {
      return null;
    }
    const executablePath = chrome || CANDIDATES.find((p) => fs.existsSync(p));
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

// 端末とサーバーではフォントなどが違い、資料の組版が少しずれる。
// 端末で記録した各ブロック要素の位置（deviceLayout）と、サーバーでの同じ要素の位置（serverRects）を
// 使って、線をその線が乗っている要素に合わせて平行移動する。
//   deviceLayout: [[index, left, top, width, height], ...]
//   serverRects:  { [index]: [left, top, width, height] }
export function alignStrokes(strokes, deviceLayout, serverRects, deviceContentHeight, serverContentHeight) {
  if (!Array.isArray(deviceLayout) || !deviceLayout.length) return strokes;
  const pairs = deviceLayout
    .filter((d) => serverRects[d[0]])
    .map((d) => ({ dl: d[1], dt: d[2], dw: d[3], dh: d[4], s: serverRects[d[0]] }));
  return strokes.map((stroke) => {
    const pts = stroke.points || [];
    if (!pts.length) return stroke;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    let dx = 0;
    let dy = 0;
    if (deviceContentHeight && cy > deviceContentHeight) {
      // 資料の後ろの白紙: 資料の終わりに合わせる
      if (serverContentHeight) dy = serverContentHeight - deviceContentHeight;
    } else {
      // 線の中心を縦に含む要素のうち、横にも含むもの、その中で一番小さいもの
      const vertical = pairs.filter((p) => cy >= p.dt && cy <= p.dt + p.dh);
      const both = vertical.filter((p) => cx >= p.dl && cx <= p.dl + p.dw);
      const pool = both.length ? both : vertical;
      pool.sort((a, b) => a.dh * (both.length ? a.dw : 1) - b.dh * (both.length ? b.dw : 1));
      const hit = pool[0];
      if (hit) {
        const [sl, st, sw, sh] = hit.s;
        dy = st + ((cy - hit.dt) * sh) / Math.max(1, hit.dh) - cy;
        if (both.length) dx = sl + ((cx - hit.dl) * sw) / Math.max(1, hit.dw) - cx;
      } else {
        // どの要素にも乗っていない（要素のあいだ）: 直前の要素の下端に合わせる
        let above = null;
        for (const p of pairs) if (p.dt + p.dh <= cy && (!above || p.dt + p.dh > above.dt + above.dh)) above = p;
        if (above) dy = above.s[1] + above.s[3] - (above.dt + above.dh);
      }
    }
    if (!dx && !dy) return stroke;
    return { ...stroke, points: pts.map((p) => [p[0] + dx, p[1] + dy, ...p.slice(2)]) };
  });
}

// ページごとの PNG を outDir に書き、ファイル名の配列を返す。作れなければ null。
export async function renderPages({ html, strokes, surface, outDir, chrome }) {
  const width = Math.round((surface && surface.width) || 930);
  const pageHeight = Math.round((surface && surface.pageHeight) || 1132);
  const manifest = path.join(outDir, "pages.json");
  if (fs.existsSync(manifest)) return JSON.parse(fs.readFileSync(manifest, "utf8"));
  const browser = await getBrowser(chrome);
  if (!browser) return null;
  const page = await browser.newPage({ viewport: { width, height: pageHeight } });
  try {
    await page.setContent(wrapDocument(html), { waitUntil: "load" });
    const contentHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const layout = (surface && surface.layout) || [];
    const serverRects = await page.evaluate((indexes) => {
      const all = document.body.getElementsByTagName("*");
      const out = {};
      for (const i of indexes) {
        const el = all[i];
        if (!el) continue;
        const r = el.getBoundingClientRect();
        out[i] = [r.left, r.top + window.scrollY, r.width, r.height];
      }
      return out;
    }, layout.map((d) => d[0]));
    strokes = alignStrokes(strokes, layout, serverRects, surface && surface.contentHeight, contentHeight);
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
