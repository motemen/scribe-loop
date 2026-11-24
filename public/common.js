// 共通の処理（一覧と書き込みの画面）。Kindle のブラウザがどの世代の JavaScript を解釈するか分からないので、ES5 で書く。
(function () {
  "use strict";

  var SL = (window.SL = {});

  SL.now = function () {
    return new Date().getTime();
  };

  SL.storage = {
    get: function (key) {
      try {
        return window.localStorage.getItem(key);
      } catch (e) {
        return null;
      }
    },
    set: function (key, value) {
      try {
        window.localStorage.setItem(key, value);
        return true;
      } catch (e) {
        return false;
      }
    },
    remove: function (key) {
      try {
        window.localStorage.removeItem(key);
      } catch (e) {}
    }
  };

  var idSeq = 0;
  SL.randomId = function (prefix) {
    idSeq += 1;
    var rand = Math.floor(Math.random() * 0x7fffffff).toString(36);
    return prefix + "-" + SL.now().toString(36) + idSeq.toString(36) + "-" + rand;
  };

  SL.clientId = SL.storage.get("sl.client");
  if (!SL.clientId) {
    SL.clientId = SL.randomId("c");
    SL.storage.set("sl.client", SL.clientId);
  }

  SL.on = function (target, type, handler, options) {
    if (target.addEventListener) target.addEventListener(type, handler, options || false);
    else if (target.attachEvent) target.attachEvent("on" + type, handler);
  };

  SL.post = function (url, body, done) {
    var xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.setRequestHeader("content-type", "application/json");
    xhr.timeout = 15000;
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      var data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch (e) {}
      if (done) done(xhr.status >= 200 && xhr.status < 300 ? null : new Error("HTTP " + xhr.status), data);
    };
    xhr.send(JSON.stringify(body));
  };

  SL.get = function (url, done) {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.timeout = 15000;
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      var data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch (e) {}
      done(xhr.status >= 200 && xhr.status < 300 ? null : new Error("HTTP " + xhr.status), data);
    };
    xhr.send();
  };

  // ボタン。Kindle Scribe のブラウザ（Silk）は、ペンで書いた直後などに click を出さないことがあるので、
  // 指（ペン）を離したときに反応する。そのあとに click が来ても、少しのあいだは同じ操作として無視する。
  var loadedAt = SL.now();
  SL.tap = function (element, handler) {
    var usePointer = !!window.PointerEvent;
    var pressed = false;
    var releasedAt = 0;
    function run(event) {
      // 前のページで押した指の click が、遷移した先のボタンに届くことがあるので、開いた直後は無視する
      if (SL.now() - loadedAt < 1000) return;
      handler(event);
    }
    SL.on(element, usePointer ? "pointerdown" : "touchstart", function (e) {
      pressed = e.pointerType !== "mouse"; // マウスはふつうの click に任せる
    });
    SL.on(element, usePointer ? "pointercancel" : "touchcancel", function () {
      pressed = false;
    });
    SL.on(element, usePointer ? "pointerup" : "touchend", function (e) {
      if (!pressed) return;
      pressed = false;
      releasedAt = SL.now();
      run(e);
    });
    SL.on(element, "click", function (e) {
      if (SL.now() - releasedAt < 700) return;
      run(e);
    });
  };

  SL.formatTime = function (iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    function p(n) { return n < 10 ? "0" + n : String(n); }
    return (d.getMonth() + 1) + "/" + d.getDate() + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  };

  SL.text = function (el, value) {
    var v = value == null ? "" : String(value);
    if (el.textContent !== v) el.textContent = v;
  };
})();
