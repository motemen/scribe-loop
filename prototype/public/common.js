// 共通の処理。Kindle のブラウザがどの世代の JavaScript を解釈するか分からないので、ES5 で書く。
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

  SL.randomId = function (prefix) {
    return prefix + "-" + SL.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
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

  // ---- ログ ----
  // オフラインのあいだも失わないよう localStorage に貯め、まとめて送る。

  var LOG_KEY = "sl.logQueue";
  var logQueue = [];
  try {
    logQueue = JSON.parse(SL.storage.get(LOG_KEY) || "[]") || [];
  } catch (e) {
    logQueue = [];
  }
  var logTimer = null;
  var logSending = false;

  SL.log = function (event, data) {
    var entry = { t: SL.now(), page: location.pathname + location.search, e: event };
    if (data) entry.d = data;
    logQueue.push(entry);
    if (logQueue.length > 2000) logQueue.splice(0, logQueue.length - 2000);
    SL.storage.set(LOG_KEY, JSON.stringify(logQueue));
    if (!logTimer) logTimer = window.setTimeout(SL.flushLog, 3000);
  };

  SL.flushLog = function () {
    logTimer = null;
    if (logSending || !logQueue.length) return;
    var batch = logQueue.slice(0, 200);
    logSending = true;
    SL.post("/api/log", { client: SL.clientId, events: batch }, function (err) {
      logSending = false;
      if (!err) {
        logQueue.splice(0, batch.length);
        SL.storage.set(LOG_KEY, JSON.stringify(logQueue));
        if (logQueue.length) logTimer = window.setTimeout(SL.flushLog, 500);
      } else {
        logTimer = window.setTimeout(SL.flushLog, 10000);
      }
    });
  };

  window.onerror = function (message, source, line, column) {
    SL.log("error", { message: String(message), source: String(source), line: line, column: column });
  };

  // ---- ページの一生（スリープや通信切断からの復帰を見る） ----

  var hiddenAt = 0;
  SL.on(document, "visibilitychange", function () {
    if (document.hidden) {
      hiddenAt = SL.now();
      SL.log("hidden");
    } else {
      SL.log("visible", { hiddenMs: hiddenAt ? SL.now() - hiddenAt : null });
      SL.flushLog();
    }
  });
  SL.on(window, "pageshow", function (e) {
    SL.log("pageshow", { persisted: !!e.persisted });
  });
  SL.on(window, "pagehide", function (e) {
    SL.log("pagehide", { persisted: !!e.persisted });
  });
  SL.on(window, "online", function () {
    SL.log("online");
    SL.flushLog();
  });
  SL.on(window, "offline", function () {
    SL.log("offline");
  });

  // 一定間隔で時刻を記録し、間が大きく空いたら（端末が眠っていたら）記録する。
  var lastTick = SL.now();
  window.setInterval(function () {
    var now = SL.now();
    if (now - lastTick > 30000) SL.log("timer-gap", { gapMs: now - lastTick });
    lastTick = now;
  }, 5000);

  // ---- 環境の判定 ----

  SL.features = function () {
    var canvas = document.createElement("canvas");
    var f = {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      screen: screen.width + "x" + screen.height,
      viewport: window.innerWidth + "x" + window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      maxTouchPoints: navigator.maxTouchPoints,
      PointerEvent: !!window.PointerEvent,
      getCoalescedEvents: !!(window.PointerEvent && window.PointerEvent.prototype.getCoalescedEvents),
      pointerrawupdate: "onpointerrawupdate" in window,
      getPredictedEvents: !!(window.PointerEvent && window.PointerEvent.prototype.getPredictedEvents),
      TouchEvent: "ontouchstart" in window,
      touchActionCss: !!(window.CSS && CSS.supports && CSS.supports("touch-action", "none")),
      canvas2d: !!(canvas.getContext && canvas.getContext("2d")),
      desynchronizedCanvas: false,
      svg: !!(document.createElementNS && document.createElementNS("http://www.w3.org/2000/svg", "svg").createSVGRect),
      localStorage: SL.storage.set("sl.test", "1"),
      indexedDB: !!window.indexedDB,
      serviceWorker: "serviceWorker" in navigator,
      fetch: !!window.fetch,
      promise: !!window.Promise,
      requestAnimationFrame: !!window.requestAnimationFrame,
      requestIdleCallback: !!window.requestIdleCallback,
      performanceNow: !!(window.performance && performance.now),
      visibilityState: "visibilityState" in document,
      wakeLock: "wakeLock" in navigator,
      onLine: navigator.onLine,
      isSecureContext: !!window.isSecureContext,
      cssGrid: !!(window.CSS && CSS.supports && CSS.supports("display", "grid")),
      es2015: (function () {
        try {
          return !!new Function("let a = 1; const b = (x) => x; return `${b(a)}` === '1';")();
        } catch (e) {
          return false;
        }
      })()
    };
    try {
      var ctx = canvas.getContext("2d", { desynchronized: true });
      f.desynchronizedCanvas = !!(ctx && ctx.getContextAttributes && ctx.getContextAttributes().desynchronized);
    } catch (e) {}
    SL.storage.remove("sl.test");
    return f;
  };

  // ボタン。ペンで書いた直後は click が来ないことがある（Hermes Notebook の知見）ので、
  // pointerup / touchend で反応し、そのあとに来る click は重複として捨てる。
  var loadedAt = SL.now();
  SL.tap = function (element, handler) {
    var armed = false;
    var firedAt = 0;
    function fire(event, how) {
      // 前のページで押した指の click が、遷移した先のボタンに届くことがあるので、開いた直後は無視する
      if (SL.now() - loadedAt < 1000) return;
      if (how !== "click") firedAt = SL.now();
      handler(event);
    }
    if (window.PointerEvent) {
      SL.on(element, "pointerdown", function () { armed = true; });
      SL.on(element, "pointercancel", function () { armed = false; });
      SL.on(element, "pointerup", function (e) {
        if (!armed) return;
        armed = false;
        if (e.pointerType === "mouse") return;
        fire(e, "pointerup");
      });
    } else if ("ontouchstart" in window) {
      SL.on(element, "touchstart", function () { armed = true; });
      SL.on(element, "touchend", function (e) {
        if (!armed) return;
        armed = false;
        fire(e, "touchend");
      });
    }
    SL.on(element, "click", function (e) {
      if (SL.now() - firedAt < 800) return;
      fire(e, "click");
    });
  };

  SL.flushOnUnload = function () {
    SL.on(window, "pagehide", SL.flushLog);
  };
  SL.flushOnUnload();
})();
