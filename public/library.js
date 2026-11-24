// 資料の一覧。返信は元の資料の下に並べる。
// 電子ペーパーの書き換えを減らすため、内容が変わったときだけ描き直す。
(function () {
  "use strict";

  var listEl = document.getElementById("docs");
  var subEl = document.getElementById("sub");
  var lastJson = "";

  var STATUS = { pending: "送信済み・未処理", processing: "AI が処理中", done: "処理済み" };

  function badge(parent, text, strong) {
    var b = document.createElement("span");
    b.className = strong ? "badge strong" : "badge";
    b.appendChild(document.createTextNode(text));
    parent.appendChild(b);
  }

  function order(docs) {
    var byId = {};
    var children = {};
    var roots = [];
    var i;
    for (i = 0; i < docs.length; i += 1) byId[docs[i].id] = docs[i];
    for (i = 0; i < docs.length; i += 1) {
      var d = docs[i];
      if (d.parentId && byId[d.parentId]) (children[d.parentId] = children[d.parentId] || []).push(d);
      else roots.push(d);
    }
    // スレッドの中で最新の資料の時刻で、スレッドを新しい順に並べる
    function latest(d) {
      var t = d.createdAt;
      var c = children[d.id] || [];
      for (var j = 0; j < c.length; j += 1) {
        var lt = latest(c[j]);
        if (lt > t) t = lt;
      }
      return t;
    }
    roots.sort(function (a, b) { return latest(a) < latest(b) ? 1 : -1; });
    var out = [];
    function walk(d, depth) {
      out.push({ doc: d, depth: depth });
      var c = (children[d.id] || []).slice().sort(function (a, b) { return a.createdAt < b.createdAt ? -1 : 1; });
      for (var j = 0; j < c.length; j += 1) walk(c[j], depth + 1);
    }
    for (i = 0; i < roots.length; i += 1) walk(roots[i], 0);
    return out;
  }

  function render(docs) {
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    var unread = 0;
    var rows = order(docs);
    for (var i = 0; i < rows.length; i += 1) {
      var d = rows[i].doc;
      var li = document.createElement("li");
      if (rows[i].depth > 0) li.className = "reply";
      var a = document.createElement("a");
      a.className = "title";
      a.href = "/d/" + encodeURIComponent(d.id);
      a.appendChild(document.createTextNode((rows[i].depth > 0 ? "↳ " : "") + d.title));
      li.appendChild(a);
      var meta = document.createElement("div");
      meta.className = "meta";
      if (!d.readAt) {
        unread += 1;
        badge(meta, "未読", true);
      }
      var fb = d.feedback && d.feedback.length ? d.feedback[d.feedback.length - 1] : null;
      if (fb) badge(meta, STATUS[fb.status] || fb.status, fb.status !== "done");
      if (d.revision > 1) badge(meta, "版 " + d.revision, false);
      if (d.reviseOnSend) badge(meta, "書き換え", false);
      if (d.strokes) badge(meta, "書き込み " + d.strokes, false);
      meta.appendChild(document.createTextNode(SL.formatTime(d.createdAt)));
      li.appendChild(meta);
      listEl.appendChild(li);
    }
    if (!rows.length) {
      var empty = document.createElement("li");
      empty.className = "empty";
      empty.appendChild(document.createTextNode("資料はまだありません。エージェントが登録すると、ここに出ます。"));
      listEl.appendChild(empty);
    }
    SL.text(subEl, unread ? "未読 " + unread + " 件" : "未読はありません");
  }

  function load() {
    SL.get("/api/documents", function (err, data) {
      if (err || !data) {
        SL.text(subEl, "サーバーに届きません。少ししてから再読み込みしてください。");
        return;
      }
      var json = JSON.stringify(data.documents);
      if (json === lastJson) return;
      lastJson = json;
      render(data.documents);
    });
  }

  load();
  window.setInterval(function () {
    if (!document.hidden) load();
  }, 30000);
  SL.on(document, "visibilitychange", function () {
    if (!document.hidden) load();
  });
  SL.on(window, "pageshow", load);
})();
