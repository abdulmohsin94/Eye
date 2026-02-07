(function () {
  "use strict";

  // ── Configuration ──────────────────────────────────────────────────
  var EYE_ENDPOINT =
    window.__EYE_ENDPOINT || (location.origin + "/api/events");
  var EYE_SITE_ID = window.__EYE_SITE_ID || "";
  var FLUSH_INTERVAL = 2000; // ms between batch sends
  var MAX_BUFFER = 200; // flush if buffer exceeds this

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
    if (buffer.length === 0) return;
    var payload = JSON.stringify({
      sessionId: sessionId,
      siteId: EYE_SITE_ID,
      url: location.href,
      events: buffer.splice(0),
    });
    // Use text/plain to avoid CORS preflight on cross-origin sendBeacon
    if (navigator.sendBeacon) {
      navigator.sendBeacon(EYE_ENDPOINT, new Blob([payload], { type: "text/plain" }));
    } else {
      var xhr = new XMLHttpRequest();
      xhr.open("POST", EYE_ENDPOINT, true);
      xhr.setRequestHeader("Content-Type", "text/plain");
      xhr.send(payload);
    }
  }

  // ── DOM Snapshot ───────────────────────────────────────────────────
  function captureSnapshot() {
    var html = document.documentElement.outerHTML;
    push("snapshot", {
      html: html,
      baseUrl: location.origin + location.pathname,
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
        value: isSensitive ? "•".repeat(val.length) : val,
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
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      captureSnapshot();
      captureStyles();
    });
  } else {
    captureSnapshot();
    captureStyles();
  }

  setInterval(flush, FLUSH_INTERVAL);

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
