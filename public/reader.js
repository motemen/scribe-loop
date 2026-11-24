// 資料を読み、書き込み、フィードバックを送る画面。ES5 で書く。
//
// 初代 Kindle Scribe のブラウザ（Silk / Chrome 80 相当）での検証から:
// - ペン・指・手のひらはどれも pointerType "touch" で届き、区別できない。
//   書いている最中に別の接触が来たら無視する。
// - イベントは約 50ms おきに 10〜40 点ずつまとめて届くので、getCoalescedEvents で全部拾う。
// - 筆圧は取れない。
(function () {
  "use strict";

  var DOC = decodeURIComponent(location.pathname.split("/")[2] || "");
  // ?rev=n なら古い版を読むだけで開く
  var VIEW_REV = Number((/[?&]rev=(\d+)/.exec(location.search) || [])[1] || 0);
  var REV = 0; // 開いている版（資料の情報を読んでから決まる）
  var readOnly = false;
  var BASE_WIDTH = 2.5;
  var ERASE_RADIUS = 14;

  var toolbar = document.getElementById("toolbar");
  var viewport = document.getElementById("viewport");
  var surface = document.getElementById("surface");
  var frame = document.getElementById("doc");
  var blank = document.getElementById("blank");
  var titleEl = document.getElementById("title");
  var statusEl = document.getElementById("status");
  var sendBtn = document.getElementById("sendBtn");
  var replyBtn = document.getElementById("replyBtn");
  var reviseBtn = document.getElementById("reviseBtn");
  var newRevBtn = document.getElementById("newRevBtn");
  var prevRevBtn = document.getElementById("prevRevBtn");
  var latestBtn = document.getElementById("latestBtn");

  var LOCAL_KEY = ""; // 版ごと。版が決まってから設定する
  var OUTBOX_KEY = "sl.outbox." + DOC; // 操作には版を書いておくので、資料ごとに一つ
  var FEEDBACK_KEY = "sl.feedback." + DOC;

  var strokes = [];
  var outbox = [];
  var pendingFeedback = null; // 送る途中のフィードバック
  var myStrokeIds = []; // 「戻す」の対象
  var tool = "pen";
  var current = null;
  var gesture = null;
  var erasedIds = [];
  var page = 0;
  var pageHeight = 0;
  var contentHeight = 0;
  var ink = document.createElement("canvas");
  var ctx = null;
  var scale = 1;
  var summary = null;
  var sendState = ""; // 送信の状態の表示

  ink.setAttribute("id", "ink");
  surface.appendChild(ink);

  function readJson(key, fallback) {
    try {
      var v = JSON.parse(SL.storage.get(key) || "null");
      return v == null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function saveLocal() {
    if (readOnly || !LOCAL_KEY) return;
    SL.storage.set(LOCAL_KEY, JSON.stringify(strokes));
    SL.storage.set(OUTBOX_KEY, JSON.stringify(outbox));
    if (pendingFeedback) SL.storage.set(FEEDBACK_KEY, JSON.stringify(pendingFeedback));
    else SL.storage.remove(FEEDBACK_KEY);
  }

  // ---- 表示 ----

  var STATUS = { pending: "未処理", processing: "AI が処理中", done: "処理済み" };

  function setStatus() {
    var parts = [];
    if (readOnly) parts.push("版 " + REV + "（読むだけ）");
    else parts.push(tool === "pen" ? "ペン" : tool === "eraser" ? "消しゴム" : "指");
    parts.push((page + 1) + "/" + pageCount() + "頁");
    if (outbox.length) parts.push("未保存 " + outbox.length);
    if (sendState) parts.push(sendState);
    else if (!readOnly && summary && summary.feedback && summary.feedback.length) {
      var last = summary.feedback[summary.feedback.length - 1];
      if ((last.revision || 1) === REV) parts.push("送信: " + (STATUS[last.status] || ""));
    }
    SL.text(statusEl, parts.join(" / "));
  }

  function pageCount() {
    return Math.max(1, Math.ceil(surface.offsetHeight / Math.max(1, pageHeight)));
  }

  function measureContent() {
    try {
      var d = frame.contentDocument;
      if (d && d.documentElement) return Math.max(d.documentElement.scrollHeight, d.body ? d.body.scrollHeight : 0);
    } catch (e) {}
    return 0;
  }

  function layout() {
    var w = viewport.clientWidth || window.innerWidth;
    pageHeight = window.innerHeight - toolbar.offsetHeight;
    viewport.style.height = pageHeight + "px";
    frame.style.width = w + "px";
    var measured = measureContent();
    if (measured) contentHeight = measured;
    frame.style.height = contentHeight + "px";
    // 資料の後ろに白紙を 1 ページ足す
    var h = Math.ceil((contentHeight + pageHeight) / pageHeight) * pageHeight;
    var maxInk = 0;
    for (var i = 0; i < strokes.length; i += 1) {
      var pts = strokes[i].points;
      for (var j = 0; j < pts.length; j += 1) if (pts[j][1] > maxInk) maxInk = pts[j][1];
    }
    if (maxInk > h - 20) h = Math.ceil((maxInk + 20) / pageHeight) * pageHeight;
    surface.style.height = h + "px";
    blank.style.top = contentHeight + "px";
    blank.style.width = w + "px";
    var dpr = window.devicePixelRatio || 1;
    var nextScale = Math.min(dpr, Math.sqrt((16 * 1000 * 1000) / Math.max(1, w * h)));
    var cw = Math.round(w * nextScale);
    var ch = Math.round(h * nextScale);
    if (ink.width !== cw || ink.height !== ch) {
      scale = nextScale;
      ink.width = cw;
      ink.height = ch;
      ink.style.width = w + "px";
      ink.style.height = h + "px";
      ctx = ink.getContext("2d");
      redraw();
    }
    var keep = viewport.scrollTop;
    viewport.scrollTop = keep;
    syncPage();
    setStatus();
  }

  // 指モードで途中までスクロールできるので、ページは表示位置から求める
  function syncPage() {
    page = Math.max(0, Math.min(pageCount() - 1, Math.floor(viewport.scrollTop / Math.max(1, pageHeight) + 0.5)));
  }

  function goPage(n) {
    page = Math.max(0, Math.min(pageCount() - 1, n));
    viewport.scrollTop = page * pageHeight;
    setStatus();
  }

  // 今の位置から 1 画面ぶん動かす
  function scrollScreens(n) {
    viewport.scrollTop = Math.max(0, viewport.scrollTop + n * pageHeight);
    syncPage();
    setStatus();
  }

  // ---- 描画 ----

  function drawSegment(a, b, width) {
    ctx.beginPath();
    ctx.lineWidth = (width || BASE_WIDTH) * scale;
    ctx.moveTo(a[0] * scale, a[1] * scale);
    ctx.lineTo(b[0] * scale, b[1] * scale);
    ctx.stroke();
  }

  function drawStroke(s) {
    var pts = s.points;
    if (pts.length === 1) drawSegment(pts[0], [pts[0][0] + 0.1, pts[0][1]], s.width);
    for (var j = 1; j < pts.length; j += 1) drawSegment(pts[j - 1], pts[j], s.width);
  }

  function redraw() {
    if (!ctx) return;
    ctx.clearRect(0, 0, ink.width, ink.height);
    ctx.strokeStyle = "#000";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (var i = 0; i < strokes.length; i += 1) drawStroke(strokes[i]);
  }

  // ---- 書き込みの下にあるもの ----

  // 線の下にある、意味のまとまりになる要素（段落、表のセル、図など）
  var BLOCK_SELECTOR = "p, li, td, th, h1, h2, h3, h4, h5, h6, pre, blockquote, figure, figcaption, dt, dd, caption, section, article, table, img, svg, div";

  function blockOf(el, doc) {
    var found = el && el.closest ? el.closest(BLOCK_SELECTOR) : null;
    return found && found !== doc.body && found !== doc.documentElement ? found : null;
  }

  // 要素を特定する CSS セレクタ。id があればそれを使い、なければ body からの nth-child の道筋にする
  function selectorOf(el, doc) {
    if (el.id) return "#" + el.id;
    var parent = el.parentElement;
    if (!parent || el === doc.body) return "body";
    var position = Array.prototype.indexOf.call(parent.children, el) + 1;
    var step = el.tagName.toLowerCase() + ":nth-child(" + position + ")";
    return (parent === doc.body ? "body" : selectorOf(parent, doc)) + " > " + step;
  }

  function clean(text, max) {
    return String(text || "").replace(/\s+/g, " ").replace(/^ | $/g, "").slice(0, max);
  }

  // 線が通った点・囲んだ範囲にある文字と、そのブロック要素を集める
  function captureAnchors(stroke) {
    var doc;
    try {
      doc = frame.contentDocument;
    } catch (e) {
      return null;
    }
    if (!doc || !doc.body || typeof doc.elementFromPoint !== "function") return null;
    var pts = stroke.points;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < pts.length; i += 1) {
      if (pts[i][0] < minX) minX = pts[i][0];
      if (pts[i][0] > maxX) maxX = pts[i][0];
      if (pts[i][1] < minY) minY = pts[i][1];
      if (pts[i][1] > maxY) maxY = pts[i][1];
    }
    var result = { bbox: [Math.round(minX), Math.round(minY), Math.round(maxX), Math.round(maxY)], inDocument: minY < contentHeight, blocks: [], text: "" };
    if (!result.inDocument) return result;

    var samples = [];
    var stride = Math.max(1, Math.ceil(pts.length / 40));
    for (var k = 0; k < pts.length; k += stride) samples.push([pts[k][0], pts[k][1]]);
    var flat = maxY - minY < 24;
    if (flat) {
      // 下線: 線の少し上の文字を拾う
      for (var u = 0; u < pts.length; u += stride) {
        samples.push([pts[u][0], pts[u][1] - 12]);
        samples.push([pts[u][0], pts[u][1] - 24]);
      }
    } else {
      // 丸囲みなど: 囲んだ範囲を格子状に調べる
      var stepX = Math.max(8, (maxX - minX) / 12);
      var stepY = Math.max(8, (maxY - minY) / 8);
      for (var gx = minX; gx <= maxX; gx += stepX) for (var gy = minY; gy <= maxY; gy += stepY) samples.push([gx, gy]);
    }

    var ranges = []; // [textNode, minOffset, maxOffset]
    var blocks = [];
    var hits = [];
    for (var s = 0; s < samples.length; s += 1) {
      var x = samples[s][0], y = samples[s][1];
      if (y < 0 || y > contentHeight) continue;
      if (doc.caretRangeFromPoint) {
        var r = null;
        try { r = doc.caretRangeFromPoint(x, y); } catch (e) {}
        if (r && r.startContainer && r.startContainer.nodeType === 3) {
          // 点がその文字の上に本当に乗っているかを確かめる（行末の余白で最後の文字を拾わないように）
          var node = r.startContainer;
          var off = r.startOffset;
          var hit = false;
          for (var o = Math.max(0, off - 1); o <= Math.min(node.length - 1, off); o += 1) {
            var cr = doc.createRange();
            cr.setStart(node, o);
            cr.setEnd(node, o + 1);
            var rect = cr.getBoundingClientRect();
            if (x >= rect.left - 4 && x <= rect.right + 4 && y >= rect.top - 4 && y <= rect.bottom + 4) {
              off = o;
              hit = true;
              break;
            }
          }
          if (hit) {
            var found = false;
            for (var q = 0; q < ranges.length; q += 1) {
              if (ranges[q][0] === node) {
                if (off < ranges[q][1]) ranges[q][1] = off;
                if (off > ranges[q][2]) ranges[q][2] = off;
                found = true;
              }
            }
            if (!found) ranges.push([node, off, off]);
          }
        }
      }
      var el = null;
      try { el = doc.elementFromPoint(x, y); } catch (e) {}
      var block = el && blockOf(el, doc);
      if (block) {
        var bi = blocks.indexOf(block);
        if (bi < 0) {
          blocks.push(block);
          hits.push(1);
        } else {
          hits[bi] += 1;
        }
      }
    }
    // よく当たった要素を先に並べる
    var orderIdx = [];
    for (var oi = 0; oi < blocks.length; oi += 1) orderIdx.push(oi);
    orderIdx.sort(function (a, b) { return hits[b] - hits[a]; });
    var sorted = [];
    for (var si = 0; si < orderIdx.length; si += 1) sorted.push(blocks[orderIdx[si]]);
    blocks = sorted;
    var texts = [];
    for (var t = 0; t < ranges.length; t += 1) texts.push(ranges[t][0].data.slice(ranges[t][1], ranges[t][2] + 1));
    result.text = clean(texts.join(" "), 300);
    for (var b = 0; b < blocks.length && b < 4; b += 1) {
      result.blocks.push({ selector: selectorOf(blocks[b], doc), tag: blocks[b].tagName.toLowerCase(), text: clean(blocks[b].textContent, 200) });
    }
    return result;
  }

  // ---- 入力 ----

  function pointFrom(e) {
    var rect = ink.getBoundingClientRect();
    return [
      Math.round((e.clientX - rect.left) * 10) / 10,
      Math.round((e.clientY - rect.top) * 10) / 10,
      current ? SL.now() - current.createdAt : 0
    ];
  }

  function stop(e) {
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    return false;
  }

  function onDown(e) {
    if (gesture && gesture.pointerId !== e.pointerId) return stop(e);
    if (readOnly || tool === "hand") {
      // 指モード（古い版を読むときも）: なぞった方向にスクロールする
      if (ink.setPointerCapture && e.pointerId !== undefined) {
        try { ink.setPointerCapture(e.pointerId); } catch (err) {}
      }
      gesture = { kind: "pan", pointerId: e.pointerId, y: e.clientY, top: viewport.scrollTop };
      return stop(e);
    }
    if (gesture && gesture.pointerId !== e.pointerId) return stop(e); // 書いている最中の別の接触（手のひらなど）
    if (current) finishStroke(null);
    if (ink.setPointerCapture && e.pointerId !== undefined) {
      try { ink.setPointerCapture(e.pointerId); } catch (err) {}
    }
    if (tool === "eraser") {
      gesture = { kind: "erase", pointerId: e.pointerId };
      erasedIds = [];
      eraseAt(pointFrom(e));
      return stop(e);
    }
    gesture = { kind: "draw", pointerId: e.pointerId };
    current = { id: SL.randomId("s"), createdAt: SL.now(), width: BASE_WIDTH, points: [] };
    current.points.push(pointFrom(e));
    drawSegment(current.points[0], [current.points[0][0] + 0.1, current.points[0][1]], current.width);
    return stop(e);
  }

  function onMove(e) {
    if (!gesture) return;
    if (gesture.pointerId !== undefined && e.pointerId !== undefined && gesture.pointerId !== e.pointerId) return stop(e);
    if (gesture.kind === "pan") {
      viewport.scrollTop = Math.max(0, gesture.top - (e.clientY - gesture.y));
      return stop(e);
    }
    if (gesture.kind === "erase") {
      eraseAt(pointFrom(e));
      return stop(e);
    }
    if (!current) return stop(e);
    var samples = [e];
    if (typeof e.getCoalescedEvents === "function") {
      try {
        var c = e.getCoalescedEvents();
        if (c && c.length) samples = c;
      } catch (err) {}
    }
    for (var i = 0; i < samples.length; i += 1) {
      var p = pointFrom(samples[i]);
      var last = current.points[current.points.length - 1];
      if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) < 0.5) continue;
      current.points.push(p);
      drawSegment(last, p, current.width);
    }
    return stop(e);
  }

  function onUp(e) {
    if (!gesture) return;
    if (gesture.pointerId !== undefined && e.pointerId !== undefined && gesture.pointerId !== e.pointerId) return stop(e);
    var g = gesture;
    gesture = null;
    if (g.kind === "pan") {
      syncPage();
      setStatus();
      return stop(e);
    }
    if (g.kind === "erase") {
      if (erasedIds.length) queueOp({ kind: "del", ids: erasedIds });
      erasedIds = [];
      setStatus();
      return stop(e);
    }
    finishStroke(e);
    return stop(e);
  }

  function finishStroke(e) {
    var stroke = current;
    current = null;
    if (!stroke) return;
    if (e && e.type === "pointerup" && typeof e.clientX === "number") {
      var p = pointFrom(e);
      p[2] = SL.now() - stroke.createdAt;
      var last = stroke.points[stroke.points.length - 1];
      if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) >= 0.5) stroke.points.push(p);
    }
    stroke.anchors = captureAnchors(stroke);
    strokes.push(stroke);
    myStrokeIds.push(stroke.id);
    queueOp({ kind: "add", stroke: stroke });
    if (sendState) sendState = "";
    setStatus();
  }

  function eraseAt(p) {
    var changed = false;
    for (var i = strokes.length - 1; i >= 0; i -= 1) {
      var pts = strokes[i].points;
      for (var j = 0; j < pts.length; j += 1) {
        if (Math.abs(pts[j][0] - p[0]) < ERASE_RADIUS && Math.abs(pts[j][1] - p[1]) < ERASE_RADIUS) {
          erasedIds.push(strokes[i].id);
          strokes.splice(i, 1);
          changed = true;
          break;
        }
      }
    }
    if (changed) redraw();
  }

  SL.on(ink, "pointerdown", onDown);
  SL.on(ink, "pointermove", onMove);
  SL.on(ink, "pointerup", onUp);
  SL.on(ink, "pointercancel", onUp);
  SL.on(document, "pointerup", onUp);

  // ---- 保存と送信 ----

  var sending = false;
  var retryTimer = null;

  function queueOp(op) {
    op.opId = SL.randomId("op");
    op.at = SL.now();
    op.revision = REV;
    outbox.push(op);
    saveLocal();
    flush();
  }

  function scheduleRetry(ms) {
    if (retryTimer) window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(function () {
      retryTimer = null;
      flush();
    }, ms);
  }

  // 書き込みの操作を送り切ってから、フィードバックを送る
  function flush() {
    if (sending) return;
    if (outbox.length) {
      sending = true;
      var batch = outbox.slice(0, 50);
      SL.post("/api/documents/" + encodeURIComponent(DOC) + "/ink", { client: SL.clientId, ops: batch }, function (err, data) {
        sending = false;
        if (err || !data || !data.acked) {
          if (pendingFeedback) sendState = "送信待ち（つながったら送ります）";
          setStatus();
          scheduleRetry(5000);
          return;
        }
        var acked = {};
        for (var i = 0; i < data.acked.length; i += 1) acked[data.acked[i]] = true;
        var rest = [];
        for (var j = 0; j < outbox.length; j += 1) if (!acked[outbox[j].opId]) rest.push(outbox[j]);
        outbox = rest;
        saveLocal();
        setStatus();
        flush();
      });
      return;
    }
    if (pendingFeedback) {
      sending = true;
      SL.post("/api/documents/" + encodeURIComponent(DOC) + "/feedback", pendingFeedback, function (err, data) {
        sending = false;
        if (err && data && data.error === "document was revised") {
          // 送る前に資料が書き換えられていた
          pendingFeedback = null;
          saveLocal();
          sendState = "送れませんでした（新しい版があります）";
          setStatus();
          loadSummary();
          return;
        }
        if (err) {
          sendState = "送信待ち（つながったら送ります）";
          setStatus();
          scheduleRetry(err.message === "HTTP 409" ? 2000 : 10000);
          return;
        }
        pendingFeedback = null;
        saveLocal();
        sendState = "送信しました";
        setStatus();
        loadSummary();
      });
    }
  }

  // 資料の各ブロック要素の位置。サーバーで合成画像を作るときに、フォントの違いによる
  // ずれを補正するのに使う。[文書内の要素の番号, left, top, width, height]
  function captureLayout() {
    var out = [];
    try {
      var doc = frame.contentDocument;
      var all = doc.body.getElementsByTagName("*");
      for (var i = 0; i < all.length && out.length < 3000; i += 1) {
        var el = all[i];
        if (el.ownerSVGElement) continue; // SVG の中の図形は見ない
        var tag = el.tagName.toLowerCase();
        var display = doc.defaultView.getComputedStyle(el).display;
        if (display === "none") continue;
        if (display.indexOf("inline") === 0 && tag !== "svg" && tag !== "img") continue;
        var r = el.getBoundingClientRect();
        if (r.height <= 0 || r.width <= 0) continue;
        out.push([i, Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]);
      }
    } catch (e) {}
    return out;
  }

  function send() {
    if (readOnly) return;
    var ids = [];
    for (var i = 0; i < strokes.length; i += 1) ids.push(strokes[i].id);
    pendingFeedback = {
      clientRequestId: SL.randomId("fr"),
      client: SL.clientId,
      revision: REV,
      strokeIds: ids,
      surface: { width: ink.clientWidth || ink.offsetWidth, pageHeight: pageHeight, contentHeight: contentHeight, devicePixelRatio: window.devicePixelRatio || 1, userAgent: navigator.userAgent, layout: captureLayout() }
    };
    sendState = "送信中…";
    saveLocal();
    setStatus();
    flush();
  }

  function undo() {
    while (myStrokeIds.length) {
      var id = myStrokeIds.pop();
      for (var i = strokes.length - 1; i >= 0; i -= 1) {
        if (strokes[i].id === id) {
          strokes.splice(i, 1);
          redraw();
          queueOp({ kind: "del", ids: [id] });
          setStatus();
          return;
        }
      }
    }
  }

  // ---- 資料の状態（返信が来たか） ----

  function loadSummary() {
    SL.get("/api/documents/" + encodeURIComponent(DOC), function (err, data) {
      if (err || !data) return;
      summary = data;
      var rev = data.revision || 1;
      SL.text(titleEl, data.title + (rev > 1 || readOnly ? "（版 " + (REV || rev) + (readOnly ? " / 最新 " + rev : "") + "）" : ""));
      document.title = data.title;
      reviseBtn.firstChild.nodeValue = data.reviseOnSend ? "☑ 書き換え" : "☐ 書き換え";
      reviseBtn.className = data.reviseOnSend ? "active" : "";
      if (REV && !readOnly && rev > REV) newRevBtn.style.display = "";
      var reply = data.replies && data.replies.length ? data.replies[data.replies.length - 1] : null;
      if (reply) {
        replyBtn.style.display = "";
        replyBtn.setAttribute("data-id", reply);
      }
      if (sendState === "送信しました") sendState = "";
      setStatus();
    });
  }

  // ---- ボタン ----

  function setTool(next) {
    tool = next;
    document.getElementById("penBtn").className = tool === "pen" ? "active" : "";
    document.getElementById("eraserBtn").className = tool === "eraser" ? "active" : "";
    document.getElementById("handBtn").className = tool === "hand" ? "active" : "";
    setStatus();
  }

  SL.tap(document.getElementById("homeBtn"), function () { location.href = "/"; });
  SL.tap(document.getElementById("penBtn"), function () { setTool("pen"); });
  SL.tap(document.getElementById("eraserBtn"), function () { setTool("eraser"); });
  SL.tap(document.getElementById("undoBtn"), undo);
  SL.tap(document.getElementById("handBtn"), function () { setTool("hand"); });
  SL.tap(document.getElementById("prevBtn"), function () { scrollScreens(-1); });
  SL.tap(document.getElementById("nextBtn"), function () { scrollScreens(1); });
  SL.tap(sendBtn, send);
  SL.tap(reviseBtn, function () {
    if (readOnly) return;
    var next = !(summary && summary.reviseOnSend);
    reviseBtn.firstChild.nodeValue = next ? "☑ 書き換え" : "☐ 書き換え";
    reviseBtn.className = next ? "active" : "";
    SL.post("/api/documents/" + encodeURIComponent(DOC) + "/settings", { reviseOnSend: next }, function (err, data) {
      if (!err && data && summary) summary.reviseOnSend = data.reviseOnSend;
      loadSummary();
    });
  });
  SL.tap(newRevBtn, function () {
    // 書きかけの操作を送り切ってから、新しい版を開く
    flush();
    window.setTimeout(function () { location.href = "/d/" + encodeURIComponent(DOC); }, outbox.length ? 1500 : 0);
  });
  SL.tap(prevRevBtn, function () { location.href = "/d/" + encodeURIComponent(DOC) + "?rev=" + (REV - 1); });
  SL.tap(latestBtn, function () { location.href = "/d/" + encodeURIComponent(DOC); });
  SL.tap(replyBtn, function () {
    var id = replyBtn.getAttribute("data-id");
    if (id) location.href = "/d/" + encodeURIComponent(id);
  });

  // ---- 起動 ----

  function restore(done) {
    outbox = readJson(OUTBOX_KEY, []);
    if (readOnly) {
      // 古い版: サーバーにある書き込みを表示するだけ
      SL.get("/api/documents/" + encodeURIComponent(DOC) + "/ink?rev=" + REV, function (err, data) {
        if (!err && data && data.strokes) strokes = data.strokes;
        done();
      });
      return;
    }
    pendingFeedback = readJson(FEEDBACK_KEY, null);
    var local = readJson(LOCAL_KEY, null);
    // 版を持つ前の保存（版 1 だけ）を引き継ぐ
    if (!local && REV === 1) local = readJson("sl.ink." + DOC, null);
    if (local) {
      strokes = local;
      done();
      return;
    }
    // 端末に何もなければ、サーバーにあるものを使う
    SL.get("/api/documents/" + encodeURIComponent(DOC) + "/ink?rev=" + REV, function (err, data) {
      if (!err && data && data.strokes) strokes = data.strokes;
      saveLocal();
      done();
    });
  }

  var started = false;
  function start() {
    if (started) return;
    started = true;
    restore(function () {
      layout();
      redraw();
      setStatus();
      flush();
    });
    // 画像やフォントの読み込みで高さが変わることがあるので、少しあとに測り直す
    window.setTimeout(layout, 800);
    window.setTimeout(layout, 3000);
  }

  // 資料の情報を読んで開く版を決めてから、資料と書き込みを読み込む
  function open(rev) {
    REV = rev;
    readOnly = VIEW_REV > 0 && VIEW_REV < rev;
    if (readOnly) REV = VIEW_REV;
    LOCAL_KEY = "sl.ink." + DOC + ".r" + REV;
    if (readOnly) {
      var hide = ["penBtn", "eraserBtn", "handBtn", "undoBtn", "sendBtn", "reviseBtn"];
      for (var i = 0; i < hide.length; i += 1) document.getElementById(hide[i]).style.display = "none";
      latestBtn.style.display = "";
    }
    if (REV > 1) prevRevBtn.style.display = "";
    SL.on(frame, "load", start);
    frame.src = "/d/" + encodeURIComponent(DOC) + "/frame?rev=" + REV;
    window.setTimeout(start, 5000); // load が来ないときのため
    if (!readOnly) SL.post("/api/documents/" + encodeURIComponent(DOC) + "/read", {}, null);
  }

  function boot() {
    SL.get("/api/documents/" + encodeURIComponent(DOC), function (err, data) {
      if (err || !data) {
        SL.text(statusEl, "サーバーに届きません。再読み込みしてください。");
        window.setTimeout(boot, 5000);
        return;
      }
      open(data.revision || 1);
      loadSummary();
    });
  }
  boot();

  var resizeTimer = null;
  SL.on(window, "resize", function () {
    if (resizeTimer) window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(layout, 300);
  });
  SL.on(window, "online", flush);
  SL.on(document, "visibilitychange", function () {
    if (!document.hidden) {
      flush();
      loadSummary();
    }
  });
  window.setInterval(function () {
    if (!document.hidden) loadSummary();
  }, 30000);
})();
