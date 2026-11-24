// 書き込みの画面。ES5 で書く。
// 確かめたいこと:
// - どの入力イベントが届くか（pointerType、pressure、buttons、getCoalescedEvents）
// - Canvas と SVG のどちらが遅延が小さく感じられるか
// - 手のひら（touch）と消しゴム端がどう届くか
// - スクロールとページ送りで、残像や読みやすさがどう違うか
// - スリープ・通信切断・再読み込みのあとに書き込みが残るか
(function () {
  "use strict";

  // ---- パラメータ ----

  var params = {};
  location.search.replace(/^\?/, "").split("&").forEach(function (pair) {
    if (!pair) return;
    var kv = pair.split("=");
    params[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || "");
  });
  var DOC = /^[a-z0-9][a-z0-9-]{0,63}$/.test(params.doc || "") ? params.doc : "scratch";
  var CONTENT = params.content === "text" ? "text" : "blank";
  var LAYOUT = params.layout === "scroll" ? "scroll" : "paged";
  var RENDER = params.render === "svg" ? "svg" : "canvas";
  var BLANK_PAGES = 3;
  var BASE_WIDTH = 2.5;
  var SVG_NS = "http://www.w3.org/2000/svg";

  var toolbar = document.getElementById("toolbar");
  var viewport = document.getElementById("viewport");
  var surface = document.getElementById("surface");
  var text = document.getElementById("text");
  var statusEl = document.getElementById("status");

  if (CONTENT === "text") text.style.display = "";
  if (LAYOUT === "scroll") viewport.className = "scroll";

  // ---- 状態 ----

  var LOCAL_KEY = "sl.doc." + DOC;
  var OUTBOX_KEY = "sl.outbox." + DOC;
  var strokes = []; // {id, points: [[x, y, pressure, t]], width, pointerType, createdAt, surfaceWidth}
  var outbox = [];
  var tool = "pen"; // pen | eraser | hand
  var current = null; // 書いている途中のストローク
  var currentStats = null;
  var gesture = null; // 進行中の操作 {kind: draw|erase|pan|palm, pointerId, ...}
  var penDown = false;
  var page = 0;
  var pageHeight = 0;
  var ink = null; // canvas か svg 要素
  var ctx = null;
  var scale = 1;
  var currentPath = null;
  var erasedIds = [];

  function readJson(key, fallback) {
    try {
      var v = JSON.parse(SL.storage.get(key) || "null");
      return v == null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function saveLocal() {
    var ok = SL.storage.set(LOCAL_KEY, JSON.stringify(strokes));
    var ok2 = SL.storage.set(OUTBOX_KEY, JSON.stringify(outbox));
    if (!ok || !ok2) SL.log("local-save-failed", { strokes: strokes.length, outbox: outbox.length });
  }

  function setStatus() {
    var msg = (tool === "pen" ? "ペン" : tool === "eraser" ? "消しゴム" : "手") +
      " / " + RENDER +
      (LAYOUT === "paged" ? " / " + (page + 1) + "/" + pageCount() + "頁" : "") +
      " / 線 " + strokes.length +
      " / " + (outbox.length ? "未送信 " + outbox.length : "送信済み");
    statusEl.textContent = msg;
  }

  // ---- 大きさ ----

  function pageCount() {
    return Math.max(1, Math.ceil(surface.offsetHeight / Math.max(1, pageHeight)));
  }

  function layout() {
    var vh = window.innerHeight - toolbar.offsetHeight;
    viewport.style.height = vh + "px";
    pageHeight = vh;
    var contentHeight = CONTENT === "text" ? text.offsetHeight : vh * BLANK_PAGES;
    var h = contentHeight;
    if (LAYOUT === "paged") h = Math.ceil(contentHeight / vh) * vh;
    surface.style.height = h + "px";
    var w = viewport.clientWidth;
    if (RENDER === "canvas") {
      // 大きすぎる canvas は作れないことがあるので、画素数に上限を設ける
      var dpr = window.devicePixelRatio || 1;
      var maxPixels = 16 * 1000 * 1000;
      scale = Math.min(dpr, Math.sqrt(maxPixels / Math.max(1, w * h)));
      ink.width = Math.round(w * scale);
      ink.height = Math.round(h * scale);
      ink.style.width = w + "px";
      ink.style.height = h + "px";
      ctx = ink.getContext("2d");
      SL.log("layout", { w: w, h: h, dpr: dpr, scale: scale, canvas: ink.width + "x" + ink.height, ok: !!ctx });
    } else {
      ink.setAttribute("width", w);
      ink.setAttribute("height", h);
      ink.setAttribute("viewBox", "0 0 " + w + " " + h);
      ink.style.width = w + "px";
      ink.style.height = h + "px";
      SL.log("layout", { w: w, h: h, render: "svg" });
    }
    if (LAYOUT === "paged") goPage(Math.min(page, pageCount() - 1), true);
    redraw();
  }

  function goPage(n, quiet) {
    page = Math.max(0, Math.min(pageCount() - 1, n));
    viewport.scrollTop = page * pageHeight;
    if (!quiet) SL.log("page", { page: page });
    setStatus();
  }

  // ---- 描画 ----

  function widthFor(pressure, pointerType) {
    // 筆圧が取れているときだけ太さを変える（取れない環境では 0.5 か 0 が来る）
    if (pointerType === "pen" && pressure > 0 && pressure !== 0.5) return BASE_WIDTH * (0.4 + 1.2 * pressure);
    return BASE_WIDTH;
  }

  function drawSegment(a, b, pointerType) {
    ctx.beginPath();
    ctx.lineWidth = widthFor(b[2], pointerType) * scale;
    ctx.moveTo(a[0] * scale, a[1] * scale);
    ctx.lineTo(b[0] * scale, b[1] * scale);
    ctx.stroke();
  }

  function svgPathData(points) {
    var d = "M" + points[0][0].toFixed(1) + " " + points[0][1].toFixed(1);
    for (var i = 1; i < points.length; i += 1) d += "L" + points[i][0].toFixed(1) + " " + points[i][1].toFixed(1);
    if (points.length === 1) d += "l0.1 0";
    return d;
  }

  function svgStroke(stroke) {
    var path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", svgPathData(stroke.points));
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "#000");
    path.setAttribute("stroke-width", String(stroke.width || BASE_WIDTH));
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    ink.appendChild(path);
    return path;
  }

  function redraw() {
    if (RENDER === "canvas") {
      if (!ctx) return;
      ctx.clearRect(0, 0, ink.width, ink.height);
      ctx.strokeStyle = "#000";
      ctx.fillStyle = "#000";
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (var i = 0; i < strokes.length; i += 1) {
        var pts = strokes[i].points;
        if (pts.length === 1) drawSegment(pts[0], [pts[0][0] + 0.1, pts[0][1], pts[0][2]], strokes[i].pointerType);
        for (var j = 1; j < pts.length; j += 1) drawSegment(pts[j - 1], pts[j], strokes[i].pointerType);
      }
    } else {
      while (ink.firstChild) ink.removeChild(ink.firstChild);
      for (var k = 0; k < strokes.length; k += 1) svgStroke(strokes[k]);
    }
  }

  // ---- 入力 ----

  function pointFrom(e) {
    var rect = ink.getBoundingClientRect();
    var pressure = typeof e.pressure === "number" ? e.pressure : (typeof e.force === "number" ? e.force : 0);
    return [
      Math.round((e.clientX - rect.left) * 10) / 10,
      Math.round((e.clientY - rect.top) * 10) / 10,
      Math.round(pressure * 1000) / 1000,
      current ? SL.now() - current.createdAt : 0
    ];
  }

  function describe(e) {
    return {
      type: e.type,
      pointerType: e.pointerType,
      pointerId: e.pointerId,
      isPrimary: e.isPrimary,
      button: e.button,
      buttons: e.buttons,
      pressure: e.pressure,
      tangentialPressure: e.tangentialPressure,
      tiltX: e.tiltX,
      tiltY: e.tiltY,
      twist: e.twist,
      width: e.width,
      height: e.height
    };
  }

  function lagOf(e) {
    // e.timeStamp が performance.now() と同じ時間軸なら、イベントが作られてから処理されるまでの遅れ
    if (!window.performance || !performance.now || !e.timeStamp || e.timeStamp > 1e12) return null;
    var lag = performance.now() - e.timeStamp;
    return lag >= 0 && lag < 10000 ? lag : null;
  }

  function isEraserEvent(e) {
    return e.pointerType === "eraser" || (typeof e.buttons === "number" && (e.buttons & 32) === 32) || e.button === 5;
  }

  function onDown(e) {
    var info = describe(e);
    if (e.pointerType === "touch") {
      if (penDown) {
        // ペンで書いている最中の指 = 手のひらと見なす
        SL.log("palm", info);
        return stop(e);
      }
      if (gesture) return stop(e);
      gesture = { kind: "pan", pointerId: e.pointerId, y: e.clientY, startY: e.clientY, info: info };
      return stop(e);
    }
    if (gesture && gesture.pointerId !== e.pointerId) {
      SL.log("down-while-busy", { info: info, busy: gesture.kind });
    }
    if (current) finishStroke(e); // up が来ないまま次の down が来たとき
    penDown = e.pointerType === "pen";
    if (tool === "hand") {
      gesture = { kind: "pan", pointerId: e.pointerId, y: e.clientY, startY: e.clientY, info: info };
      return stop(e);
    }
    if (tool === "eraser" || isEraserEvent(e)) {
      gesture = { kind: "erase", pointerId: e.pointerId, info: info, viaButton: tool !== "eraser" };
      erasedIds = [];
      eraseAt(pointFrom(e));
      return stop(e);
    }
    if (ink.setPointerCapture && e.pointerId !== undefined) {
      try { ink.setPointerCapture(e.pointerId); } catch (err) {}
    }
    gesture = { kind: "draw", pointerId: e.pointerId };
    current = {
      id: SL.randomId("s"),
      createdAt: SL.now(),
      pointerType: e.pointerType || "unknown",
      surfaceWidth: ink.clientWidth || ink.offsetWidth,
      render: RENDER,
      points: []
    };
    current.points.push(pointFrom(e));
    current.width = widthFor(current.points[0][2], current.pointerType);
    currentStats = { down: info, events: 1, samples: 1, lagSum: 0, lagMax: 0, lagN: 0, pressures: {}, buttons: {} };
    trackLag(e);
    if (RENDER === "svg") currentPath = svgStroke(current);
    else drawSegment(current.points[0], [current.points[0][0] + 0.1, current.points[0][1], current.points[0][2]], current.pointerType);
    return stop(e);
  }

  function trackLag(e) {
    var lag = lagOf(e);
    if (lag != null) {
      currentStats.lagSum += lag;
      currentStats.lagN += 1;
      if (lag > currentStats.lagMax) currentStats.lagMax = lag;
    }
    if (typeof e.pressure === "number") currentStats.pressures[String(Math.round(e.pressure * 100) / 100)] = true;
    if (typeof e.buttons === "number") currentStats.buttons[String(e.buttons)] = true;
  }

  function onMove(e) {
    if (!gesture || (gesture.pointerId !== undefined && e.pointerId !== undefined && gesture.pointerId !== e.pointerId)) {
      return gesture ? stop(e) : undefined;
    }
    if (gesture.kind === "pan") {
      var dy = e.clientY - gesture.y;
      gesture.y = e.clientY;
      if (LAYOUT === "scroll") viewport.scrollTop -= dy;
      return stop(e);
    }
    if (gesture.kind === "erase") {
      eraseAt(pointFrom(e));
      return stop(e);
    }
    if (gesture.kind !== "draw" || !current) return stop(e);
    var samples = [e];
    if (typeof e.getCoalescedEvents === "function") {
      try {
        var c = e.getCoalescedEvents();
        if (c && c.length) samples = c;
      } catch (err) {}
    }
    currentStats.events += 1;
    trackLag(e);
    for (var i = 0; i < samples.length; i += 1) {
      var p = pointFrom(samples[i]);
      var last = current.points[current.points.length - 1];
      if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) < 0.5) continue;
      current.points.push(p);
      currentStats.samples += 1;
      if (RENDER === "canvas") drawSegment(last, p, current.pointerType);
    }
    if (RENDER === "svg" && currentPath) currentPath.setAttribute("d", svgPathData(current.points));
    return stop(e);
  }

  function onUp(e) {
    if (!gesture) return;
    if (gesture.pointerId !== undefined && e.pointerId !== undefined && gesture.pointerId !== e.pointerId) return stop(e);
    var g = gesture;
    gesture = null;
    if (e.pointerType === "pen" || g.kind !== "pan") penDown = false;
    if (g.kind === "pan") {
      var total = e.clientY - g.startY;
      if (LAYOUT === "paged" && Math.abs(total) > 80) goPage(page + (total < 0 ? 1 : -1));
      SL.log("pan", { pointerType: g.info.pointerType, dy: total, scrollTop: viewport.scrollTop });
      return stop(e);
    }
    if (g.kind === "erase") {
      if (erasedIds.length) {
        queueOp({ kind: "del", ids: erasedIds });
        redraw();
      }
      SL.log("erase", { removed: erasedIds.length, viaButton: g.viaButton, down: g.info });
      erasedIds = [];
      setStatus();
      return stop(e);
    }
    if (g.kind === "draw") finishStroke(e);
    return stop(e);
  }

  function finishStroke(e) {
    if (!current) return;
    var stroke = current;
    var stats = currentStats;
    current = null;
    currentPath = null;
    if (e && e.type && e.type.indexOf("up") >= 0 && typeof e.clientX === "number") {
      var p = pointFrom(e);
      p[3] = SL.now() - stroke.createdAt;
      var last = stroke.points[stroke.points.length - 1];
      if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) >= 0.5) stroke.points.push(p);
    }
    var pressures = [];
    for (var k in stats.pressures) if (Object.prototype.hasOwnProperty.call(stats.pressures, k)) pressures.push(Number(k));
    if (pressures.length > 2 && stroke.pointerType === "pen") {
      var sum = 0;
      for (var i = 0; i < stroke.points.length; i += 1) sum += widthFor(stroke.points[i][2], stroke.pointerType);
      stroke.width = Math.round((sum / stroke.points.length) * 100) / 100;
    }
    strokes.push(stroke);
    var duration = stroke.points[stroke.points.length - 1][3];
    SL.log("stroke", {
      id: stroke.id,
      render: RENDER,
      layout: LAYOUT,
      pointerType: stroke.pointerType,
      points: stroke.points.length,
      events: stats.events,
      samples: stats.samples,
      durationMs: duration,
      hz: duration > 0 ? Math.round((stats.samples / duration) * 1000) : null,
      lagAvgMs: stats.lagN ? Math.round(stats.lagSum / stats.lagN) : null,
      lagMaxMs: stats.lagN ? Math.round(stats.lagMax) : null,
      pressures: pressures.sort(function (a, b) { return a - b; }).slice(0, 20),
      pressureKinds: pressures.length,
      buttons: Object.keys(stats.buttons),
      down: stats.down,
      endType: e && e.type
    });
    queueOp({ kind: "add", stroke: stroke });
    setStatus();
  }

  function eraseAt(p) {
    var r = 14;
    var changed = false;
    for (var i = strokes.length - 1; i >= 0; i -= 1) {
      var pts = strokes[i].points;
      for (var j = 0; j < pts.length; j += 1) {
        if (Math.abs(pts[j][0] - p[0]) < r && Math.abs(pts[j][1] - p[1]) < r) {
          erasedIds.push(strokes[i].id);
          strokes.splice(i, 1);
          changed = true;
          break;
        }
      }
    }
    // 消したことがすぐ見えるように、その場で描き直す
    if (changed) redraw();
  }

  function stop(e) {
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    return false;
  }

  // PointerEvent がないブラウザ向け: touch イベントを pointer に見立てる
  function fromTouch(handler) {
    return function (e) {
      var t = (e.changedTouches && e.changedTouches[0]) || (e.touches && e.touches[0]);
      if (!t) return;
      var fake = {
        type: e.type.replace("touchstart", "pointerdown").replace("touchmove", "pointermove").replace("touchend", "pointerup").replace("touchcancel", "pointercancel"),
        pointerType: t.touchType === "stylus" ? "pen" : "touch-as-pen",
        pointerId: t.identifier,
        clientX: t.clientX,
        clientY: t.clientY,
        force: t.force,
        timeStamp: e.timeStamp,
        preventDefault: function () { e.preventDefault(); },
        stopPropagation: function () { e.stopPropagation(); }
      };
      if (e.type === "touchstart") SL.log("touch", { touches: e.touches.length, force: t.force, radiusX: t.radiusX, radiusY: t.radiusY, touchType: t.touchType });
      return handler(fake);
    };
  }

  function bindInput() {
    if (window.PointerEvent) {
      SL.on(ink, "pointerdown", onDown);
      SL.on(ink, "pointermove", onMove);
      SL.on(ink, "pointerup", onUp);
      SL.on(ink, "pointercancel", function (e) {
        SL.log("pointercancel", describe(e));
        onUp(e);
      });
      SL.on(document, "pointerup", onUp);
      // PointerEvent と別に touch イベントがどう届くか（手のひら）を記録する
      SL.on(ink, "touchstart", function (e) {
        var t = e.changedTouches && e.changedTouches[0];
        SL.log("touchstart", { touches: e.touches.length, force: t && t.force, radiusX: t && t.radiusX, touchType: t && t.touchType, penDown: penDown });
      }, { passive: true });
    } else {
      SL.on(ink, "touchstart", fromTouch(onDown), { passive: false });
      SL.on(ink, "touchmove", fromTouch(onMove), { passive: false });
      SL.on(ink, "touchend", fromTouch(onUp), { passive: false });
      SL.on(ink, "touchcancel", fromTouch(onUp), { passive: false });
      SL.on(ink, "mousedown", onDown);
      SL.on(ink, "mousemove", onMove);
      SL.on(document, "mouseup", onUp);
    }
  }

  // ---- 保存と送信 ----

  var sending = false;
  var retryTimer = null;

  function queueOp(op) {
    op.opId = SL.randomId("op");
    op.at = SL.now();
    outbox.push(op);
    saveLocal();
    flushOps();
  }

  function flushOps() {
    if (retryTimer) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (sending || !outbox.length) return;
    sending = true;
    var batch = outbox.slice(0, 50);
    var startedAt = SL.now();
    SL.post("/api/ops", { doc: DOC, client: SL.clientId, ops: batch }, function (err, data) {
      sending = false;
      if (err || !data || !data.acked) {
        SL.log("ops-send-failed", { error: err && err.message, pending: outbox.length });
        retryTimer = window.setTimeout(flushOps, 5000);
        setStatus();
        return;
      }
      var acked = {};
      for (var i = 0; i < data.acked.length; i += 1) acked[data.acked[i]] = true;
      var rest = [];
      for (var j = 0; j < outbox.length; j += 1) if (!acked[outbox[j].opId]) rest.push(outbox[j]);
      outbox = rest;
      saveLocal();
      SL.log("ops-sent", { count: data.acked.length, ms: SL.now() - startedAt, pending: outbox.length });
      setStatus();
      if (outbox.length) flushOps();
    });
  }

  function restore() {
    var local = readJson(LOCAL_KEY, null);
    outbox = readJson(OUTBOX_KEY, []);
    if (local && local.length) {
      strokes = local;
      SL.log("restore", { from: "local", strokes: strokes.length, outbox: outbox.length });
      layout();
      flushOps();
      return;
    }
    // 端末に何もなければ、サーバーにあるものを取ってくる
    SL.get("/api/doc?doc=" + encodeURIComponent(DOC), function (err, data) {
      if (!err && data && data.strokes) {
        strokes = data.strokes.concat(strokes);
        saveLocal();
      }
      SL.log("restore", { from: "server", ok: !err, strokes: strokes.length });
      redraw();
      setStatus();
      flushOps();
    });
    layout();
  }

  // ---- ボタン ----

  function setTool(next) {
    tool = next;
    document.getElementById("penBtn").className = tool === "pen" ? "active" : "";
    document.getElementById("eraserBtn").className = tool === "eraser" ? "active" : "";
    document.getElementById("handBtn").className = tool === "hand" ? "active" : "";
    SL.log("tool", { tool: tool });
    setStatus();
  }

  var clearArmedAt = 0;

  function bindButtons() {
    SL.tap(document.getElementById("homeBtn"), function () {
      SL.flushLog();
      location.href = "/";
    });
    SL.tap(document.getElementById("penBtn"), function () { setTool("pen"); });
    SL.tap(document.getElementById("eraserBtn"), function () { setTool("eraser"); });
    SL.tap(document.getElementById("handBtn"), function () { setTool("hand"); });
    var renderBtn = document.getElementById("renderBtn");
    renderBtn.textContent = RENDER === "canvas" ? "SVG に" : "Canvas に";
    SL.tap(renderBtn, function () {
      location.href = "pad.html?doc=" + DOC + "&content=" + CONTENT + "&layout=" + LAYOUT + "&render=" + (RENDER === "canvas" ? "svg" : "canvas");
    });
    var prev = document.getElementById("prevBtn");
    var next = document.getElementById("nextBtn");
    if (LAYOUT === "paged") {
      SL.tap(prev, function () { goPage(page - 1); });
      SL.tap(next, function () { goPage(page + 1); });
    } else {
      prev.style.display = "none";
      next.style.display = "none";
    }
    var clearBtn = document.getElementById("clearBtn");
    SL.tap(clearBtn, function () {
      // 確認のダイアログは端末を止めることがあるので使わず、2 回押しで消す
      if (SL.now() - clearArmedAt > 3000) {
        clearArmedAt = SL.now();
        clearBtn.textContent = "もう一度で消去";
        window.setTimeout(function () { clearBtn.textContent = "全消去"; }, 3000);
        return;
      }
      clearArmedAt = 0;
      clearBtn.textContent = "全消去";
      strokes = [];
      queueOp({ kind: "clear" });
      redraw();
      setStatus();
    });
  }

  // ---- 起動 ----

  function createInk() {
    if (RENDER === "canvas") {
      ink = document.createElement("canvas");
    } else {
      ink = document.createElementNS(SVG_NS, "svg");
    }
    ink.setAttribute("id", "ink");
    surface.appendChild(ink);
  }

  createInk();
  bindInput();
  bindButtons();
  restore();
  setStatus();
  SL.log("open", { doc: DOC, content: CONTENT, layout: LAYOUT, render: RENDER, viewport: window.innerWidth + "x" + window.innerHeight });

  // 文字の組版が終わってから高さを測り直す
  SL.on(window, "load", layout);

  var resizeTimer = null;
  SL.on(window, "resize", function () {
    if (resizeTimer) window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(layout, 300);
  });
  SL.on(window, "online", flushOps);
  SL.on(document, "visibilitychange", function () {
    if (!document.hidden) flushOps();
  });
  SL.on(window, "pageshow", function () {
    flushOps();
  });
})();
