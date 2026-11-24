import { test } from "node:test";
import assert from "node:assert/strict";
import { alignStrokes } from "../src/render.mjs";

const stroke = (id, pts) => ({ id, points: pts.map(([x, y]) => [x, y, 0]) });

test("strokes follow the element they sit on", () => {
  // 端末では段落が y=100 から高さ 50、サーバーでは y=80 から高さ 40
  const layout = [[3, 10, 100, 500, 50]];
  const server = { 3: [10, 80, 500, 40] };
  const [s] = alignStrokes([stroke("a", [[20, 120], [60, 130]])], layout, server, 1000, 980);
  // 中心 (40, 125) は段落の上から 50% → サーバーでは 80 + 20 = 100、つまり 25 上へ
  assert.deepEqual(s.points.map((p) => [p[0], p[1]]), [[20, 95], [60, 105]]);
});

test("margin strokes move vertically only, blank-page strokes follow the end of the document", () => {
  const layout = [[3, 10, 100, 500, 50]];
  const server = { 3: [10, 80, 500, 40] };
  const [margin, blank] = alignStrokes(
    [stroke("m", [[700, 120], [720, 130]]), stroke("b", [[100, 1100], [120, 1110]])],
    layout,
    server,
    1000,
    950,
  );
  assert.deepEqual(margin.points.map((p) => p[0]), [700, 720]);
  assert.deepEqual(margin.points.map((p) => p[1]), [95, 105]);
  assert.deepEqual(blank.points.map((p) => p[1]), [1050, 1060]);
});

test("without layout, strokes are unchanged", () => {
  const strokes = [stroke("a", [[1, 2]])];
  assert.equal(alignStrokes(strokes, [], {}, 0, 0), strokes);
});
