(function () {
  "use strict";

  // ── Configuration ──────────────────────────────────────────────────
  var EYE_ENDPOINT =
    window.__EYE_ENDPOINT || (location.origin + "/api/events");
  var EYE_SITE_ID = window.__EYE_SITE_ID || "";
  var FLUSH_INTERVAL = 2000; // ms between batch sends
  var MAX_BUFFER = 200; // flush if buffer exceeds this

  // ── Remote diagnostics ─────────────────────────────────────────────
  // Sends debug logs to the Eye server so you can troubleshoot from the dashboard
  var LOG_ENDPOINT = EYE_ENDPOINT.replace("/api/events", "/api/debug/log");

  function remoteLog(level, message, extra) {
    try {
      var payload = JSON.stringify({
        siteId: EYE_SITE_ID,
        sessionId: sessionStorage.getItem("_eye_sid") || "",
        level: level,
        message: message,
        data: extra ? JSON.stringify(extra) : "",
        url: location.href,
      });
      navigator.sendBeacon(LOG_ENDPOINT, new Blob([payload], { type: "text/plain" }));
    } catch (e) {}
  }

  remoteLog("info", "recorder loaded", {
    endpoint: EYE_ENDPOINT,
    siteId: EYE_SITE_ID,
    ua: navigator.userAgent.slice(0, 120),
  });

  // ── Debug mode ─────────────────────────────────────────────────────
  // Activate by adding ?eye_debug=1 to any page URL
  var isDebug = /[?&]eye_debug=1/.test(location.search);
  var debugEl = null;
  var debugSent = 0;
  var debugFail = 0;

  function initDebugOverlay() {
    if (!isDebug) return;
    var target = document.body || document.documentElement;
    if (!target) {
      // Body not ready yet, retry after DOM load
      document.addEventListener("DOMContentLoaded", function () {
        initDebugOverlay();
      });
      return;
    }
    debugEl = document.createElement("div");
    debugEl.id = "eye-debug";
    debugEl.style.cssText = "position:fixed;bottom:8px;right:8px;z-index:999999;"
      + "background:#111;color:#0f0;font:11px/1.4 monospace;padding:8px 12px;"
      + "border-radius:8px;opacity:0.9;max-width:280px;pointer-events:none;";
    debugEl.innerHTML = "Eye: loading...";
    target.appendChild(debugEl);
    debugLog("ready");
  }

  function debugLog(msg) {
    if (!debugEl) return;
    debugEl.innerHTML = "<b>Eye Debug</b><br>"
      + "SID: " + sessionId.slice(0, 8) + "...<br>"
      + "Site: " + (EYE_SITE_ID || "(self)") + "<br>"
      + "EP: " + EYE_ENDPOINT + "<br>"
      + "Buf: " + buffer.length + "<br>"
      + "Sent: " + debugSent + " | Fail: " + debugFail + "<br>"
      + msg;
  }

  // ── Session bootstrapping ──────────────────────────────────────────
  var sessionId =
    sessionStorage.getItem("_eye_sid") || crypto.randomUUID();
  sessionStorage.setItem("_eye_sid", sessionId);

  var buffer = [];
  var startTs = Date.now();
  var seqNum = parseInt(sessionStorage.getItem("_eye_seq") || "0", 10);

  // Persist cumulative time offset so timestamps are continuous across refreshes
  var timeOffset = parseFloat(sessionStorage.getItem("_eye_toff") || "0");
  // On unload we save current elapsed time as the new offset
  window.addEventListener("pagehide", function () {
    sessionStorage.setItem("_eye_toff", String(timeOffset + (Date.now() - startTs)));
    sessionStorage.setItem("_eye_seq", String(seqNum));
  });

  // ── Helpers ────────────────────────────────────────────────────────
  function ts() {
    return timeOffset + (Date.now() - startTs);
  }

  function push(type, data) {
    buffer.push({ t: ts(), seq: seqNum++, type: type, data: data });
    if (buffer.length >= MAX_BUFFER) flush();
  }

  function flush() {
    if (buffer.length === 0) {
      if (isDebug) debugLog("idle");
      return;
    }
    var count = buffer.length;
    var types = {};
    buffer.forEach(function(e) { types[e.type] = (types[e.type] || 0) + 1; });
    var events = buffer.splice(0);
    var payload = JSON.stringify({
      sessionId: sessionId,
      siteId: EYE_SITE_ID,
      url: location.href,
      events: events,
    });
    var payloadSize = payload.length;

    remoteLog("info", "flush attempt", { count: count, size: payloadSize, types: types });

    // Primary: sendBeacon with text/plain (no CORS preflight, works cross-origin)
    if (navigator.sendBeacon) {
      var ok = navigator.sendBeacon(EYE_ENDPOINT, new Blob([payload], { type: "text/plain" }));
      if (ok) {
        debugSent += count;
        if (isDebug) debugLog("beacon OK (" + count + ")");
        remoteLog("info", "beacon OK", { count: count, size: payloadSize });
        return;
      }
      // sendBeacon failed (payload too large?) — fall through to fetch
      if (isDebug) debugLog("beacon FAIL, trying fetch...");
      remoteLog("warn", "beacon FAILED", { count: count, size: payloadSize });
    }

    // Fallback: fetch without keepalive
    try {
      fetch(EYE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: payload,
      }).then(function (r) {
        if (r.ok) {
          debugSent += count;
          if (isDebug) debugLog("fetch OK (" + count + ")");
          remoteLog("info", "fetch OK", { count: count, status: r.status });
        } else {
          debugFail += count;
          if (isDebug) debugLog("fetch HTTP " + r.status);
          remoteLog("error", "fetch HTTP error", { count: count, status: r.status });
        }
      }).catch(function (err) {
        debugFail += count;
        if (isDebug) debugLog("fetch ERR: " + (err.message || err));
        remoteLog("error", "fetch network error", { error: err.message || String(err) });
      });
    } catch (e) {
      debugFail += count;
      if (isDebug) debugLog("fetch THROW: " + (e.message || e));
      remoteLog("error", "fetch throw", { error: e.message || String(e) });
    }
  }

  // ── DOM Snapshot ───────────────────────────────────────────────────
  function captureSnapshot() {
    // Clone the DOM and strip all <script> tags before serializing.
    // Scripts are useless for replay (we remove them on playback anyway)
    // and they massively bloat the payload (GTM, analytics, etc.).
    var clone = document.documentElement.cloneNode(true);
    var scripts = clone.querySelectorAll("script");
    for (var i = 0; i < scripts.length; i++) {
      scripts[i].parentNode.removeChild(scripts[i]);
    }
    // Fix lazy-loaded images: copy actual src from live DOM, remove lazy attrs
    var liveImgs = document.querySelectorAll("img");
    var cloneImgs = clone.querySelectorAll("img");
    for (var j = 0; j < cloneImgs.length && j < liveImgs.length; j++) {
      // Use the live currentSrc (the actually loaded image) if available
      if (liveImgs[j].currentSrc && !cloneImgs[j].getAttribute("src")) {
        cloneImgs[j].setAttribute("src", liveImgs[j].currentSrc);
      }
      // Copy data-src to src if src is empty/placeholder
      var dataSrc = cloneImgs[j].getAttribute("data-src");
      if (dataSrc && !cloneImgs[j].getAttribute("src")) {
        cloneImgs[j].setAttribute("src", dataSrc);
      }
      var dataSrcset = cloneImgs[j].getAttribute("data-srcset");
      if (dataSrcset) {
        cloneImgs[j].setAttribute("srcset", dataSrcset);
      }
      // Remove lazy loading so images load immediately in replay
      cloneImgs[j].removeAttribute("loading");
      cloneImgs[j].removeAttribute("data-src");
      cloneImgs[j].removeAttribute("data-srcset");
    }
    var html = clone.outerHTML;
    remoteLog("info", "snapshot captured", { htmlSize: html.length, stripped: scripts.length + " scripts" });
    push("snapshot", {
      html: html,
      baseUrl: location.origin,
      width: window.innerWidth,
      height: window.innerHeight,
      doctype: document.doctype
        ? new XMLSerializer().serializeToString(document.doctype)
        : "",
    });
  }

  // ── CSS capture ────────────────────────────────────────────────────
  function captureStyles() {
    var styles = [];
    try {
      for (var i = 0; i < document.styleSheets.length; i++) {
        var sheet = document.styleSheets[i];
        if (sheet.href) {
          styles.push({ type: "link", href: sheet.href });
        } else {
          try {
            var rules = [];
            for (var j = 0; j < sheet.cssRules.length; j++) {
              rules.push(sheet.cssRules[j].cssText);
            }
            styles.push({ type: "inline", css: rules.join("\n") });
          } catch (e) {
            // cross-origin stylesheet
          }
        }
      }
    } catch (e) {}
    push("styles", { styles: styles });
  }

  // ── XPath-like selector for elements ───────────────────────────────
  function getSelector(el) {
    if (!el || el === document) return "";
    if (el.id) return "#" + el.id;
    var path = [];
    while (el && el.nodeType === 1) {
      var tag = el.tagName.toLowerCase();
      var idx = 1;
      var sib = el.previousElementSibling;
      while (sib) {
        if (sib.tagName.toLowerCase() === tag) idx++;
        sib = sib.previousElementSibling;
      }
      path.unshift(tag + ":nth-of-type(" + idx + ")");
      el = el.parentElement;
    }
    return path.join(" > ");
  }

  // ── Mouse tracking ─────────────────────────────────────────────────
  var lastMx = -1,
    lastMy = -1;
  document.addEventListener(
    "mousemove",
    function (e) {
      // Throttle: only record if moved > 4px
      if (
        Math.abs(e.clientX - lastMx) > 4 ||
        Math.abs(e.clientY - lastMy) > 4
      ) {
        lastMx = e.clientX;
        lastMy = e.clientY;
        push("mousemove", { x: e.clientX, y: e.clientY });
      }
    },
    true
  );

  document.addEventListener(
    "click",
    function (e) {
      push("click", {
        x: e.clientX,
        y: e.clientY,
        selector: getSelector(e.target),
        tag: e.target.tagName,
        text: (e.target.textContent || "").slice(0, 80),
      });
    },
    true
  );

  // ── Touch tracking (for mobile sessions) ──────────────────────────
  document.addEventListener(
    "touchstart",
    function (e) {
      if (e.touches.length > 0) {
        var touch = e.touches[0];
        push("click", {
          x: Math.round(touch.clientX),
          y: Math.round(touch.clientY),
          selector: getSelector(e.target),
          tag: e.target.tagName,
          text: (e.target.textContent || "").slice(0, 80),
        });
      }
    },
    true
  );

  // ── Scroll tracking ────────────────────────────────────────────────
  var scrollTimer = null;
  window.addEventListener(
    "scroll",
    function () {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(function () {
        push("scroll", {
          x: window.scrollX,
          y: window.scrollY,
        });
      }, 100);
    },
    true
  );

  // ── Viewport resize ────────────────────────────────────────────────
  var resizeTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      push("resize", {
        width: window.innerWidth,
        height: window.innerHeight,
      });
    }, 200);
  });

  // ── Input / form changes (values masked for privacy) ──────────────
  document.addEventListener(
    "input",
    function (e) {
      var el = e.target;
      var val = el.value || "";
      // Mask password & sensitive fields
      var isSensitive =
        el.type === "password" ||
        /credit|card|cvv|ssn|secret|token/i.test(el.name || el.id || "");
      push("input", {
        selector: getSelector(el),
        value: isSensitive ? "\u2022".repeat(val.length) : val,
        masked: isSensitive,
      });
    },
    true
  );

  // ── DOM Mutations ──────────────────────────────────────────────────
  if (window.MutationObserver) {
    var observer = new MutationObserver(function (mutations) {
      var changes = [];
      mutations.forEach(function (m) {
        if (m.type === "childList") {
          m.addedNodes.forEach(function (n) {
            if (n.nodeType === 1) {
              changes.push({
                action: "add",
                parent: getSelector(m.target),
                html: n.outerHTML.slice(0, 2000),
              });
            }
          });
          m.removedNodes.forEach(function (n) {
            if (n.nodeType === 1) {
              changes.push({
                action: "remove",
                parent: getSelector(m.target),
                tag: n.tagName,
                selector: getSelector(n),
              });
            }
          });
        } else if (m.type === "attributes") {
          changes.push({
            action: "attr",
            selector: getSelector(m.target),
            attr: m.attributeName,
            value: (m.target.getAttribute(m.attributeName) || "").slice(0, 500),
          });
        } else if (m.type === "characterData") {
          changes.push({
            action: "text",
            selector: getSelector(m.target.parentElement),
            text: (m.target.textContent || "").slice(0, 500),
          });
        }
      });
      if (changes.length > 0) {
        push("mutation", { changes: changes });
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
      attributeOldValue: false,
    });
  }

  // ── Page visibility / unload ───────────────────────────────────────
  document.addEventListener("visibilitychange", function () {
    push("visibility", { state: document.visibilityState });
  });

  window.addEventListener("beforeunload", function () {
    push("unload", {});
    flush();
  });

  // ── Frustration signals: rage clicks ───────────────────────────────
  var clickTimes = [];
  document.addEventListener(
    "click",
    function (e) {
      var now = Date.now();
      clickTimes.push(now);
      // Keep only clicks within last 1s
      clickTimes = clickTimes.filter(function (t) {
        return now - t < 1000;
      });
      if (clickTimes.length >= 3) {
        push("rage_click", {
          x: e.clientX,
          y: e.clientY,
          selector: getSelector(e.target),
          count: clickTimes.length,
        });
        clickTimes = [];
      }
    },
    true
  );

  // ── Console errors ─────────────────────────────────────────────────
  window.addEventListener("error", function (e) {
    push("error", {
      message: e.message,
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
    });
  });

  // ── Kick it off ────────────────────────────────────────────────────
  // Start flush interval FIRST so interaction events always get sent
  // even if snapshot/style capture fails
  setInterval(flush, FLUSH_INTERVAL);

  // Init debug overlay
  initDebugOverlay();

  try {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () {
        try { captureSnapshot(); captureStyles(); } catch (e) {}
        if (isDebug && !debugEl) initDebugOverlay();
      });
    } else {
      captureSnapshot();
      captureStyles();
    }
  } catch (e) {}

  // Expose minimal API
  window.__eye = {
    sessionId: sessionId,
    identify: function (userId, traits) {
      push("identify", { userId: userId, traits: traits || {} });
    },
    track: function (eventName, props) {
      push("custom", { name: eventName, properties: props || {} });
    },
  };
})();
