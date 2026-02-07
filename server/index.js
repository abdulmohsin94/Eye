const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const path = require("path");
const db = require("./db");
const auth = require("./auth");

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy so req.secure works behind Vercel/nginx/etc.
app.set("trust proxy", 1);

app.use(cors());
app.use(cookieParser());
app.use(express.json({ limit: "5mb" }));
// Accept text/plain bodies (snippet sends as text/plain to avoid CORS preflight)
app.use(express.text({ limit: "5mb", type: "text/plain" }));

// ── Auth routes (public) ─────────────────────────────────────────────
app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "login.html"));
});

app.post("/api/auth/login", (req, res) => {
  const { password } = req.body;
  if (!password || !auth.verifyPassword(password)) {
    return res.status(401).json({ error: "Invalid password" });
  }
  const token = auth.generateToken();
  const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.cookie("eye_token", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecure,
    maxAge: 24 * 60 * 60 * 1000,
  });
  res.json({ ok: true });
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("eye_token");
  res.json({ ok: true });
});

// ── Serve snippet publicly (sites need to load it without auth) ──────
// CRITICAL: no-cache so client browsers always get the latest snippet version
app.use("/snippet", express.static(path.join(__dirname, "..", "snippet"), {
  setHeaders(res) {
    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
  },
}));

// ── All-in-one recorder JS per site (config baked in, no external deps) ──
const fs = require("fs");
const recorderPath = path.join(__dirname, "..", "snippet", "eye-recorder.js");

app.get("/api/recorder/:siteId", (req, res) => {
  const siteId = req.params.siteId;
  const host = `${req.protocol}://${req.get("host")}`;
  const recorderCode = fs.readFileSync(recorderPath, "utf-8");
  // Prepend config so the recorder picks it up — single file, zero race conditions
  const full = `window.__EYE_SITE_ID="${siteId}";window.__EYE_ENDPOINT="${host}/api/events";\n${recorderCode}`;
  res.set("Content-Type", "application/javascript");
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.send(full);
});

// ── GTM-ready snippet HTML (public) ─────────────────────────────────
app.get("/api/snippet/:siteId", async (req, res) => {
  const siteId = req.params.siteId;
  const host = `${req.protocol}://${req.get("host")}`;
  // Single script tag that dynamically loads the all-in-one recorder
  const html = `<script>
(function(){var s=document.createElement("script");s.src="${host}/api/recorder/${siteId}";document.head.appendChild(s);})();
</script>`;
  res.type("text/plain").send(html);
});

// ── Health check (public - shows if Turso is connected) ──────────────
app.get("/api/health", async (req, res) => {
  try {
    const count = await db.getSessionCount();
    res.json({
      ok: true,
      db: process.env.TURSO_DATABASE_URL ? "turso" : "local-file",
      sessions: count,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── CORS preflight for /api/events (needed for fetch fallback) ────────
app.options("/api/events", (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Max-Age", "86400");
  res.status(204).end();
});

// ── Event ingestion (public - no auth required) ──────────────────────
app.post("/api/events", async (req, res) => {
  // Allow cross-origin fetch fallback
  res.set("Access-Control-Allow-Origin", "*");
  try {
    // Body may arrive as text/plain string (to avoid CORS preflight) or parsed JSON
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const { sessionId, siteId, url, events } = body;
    if (!sessionId || !events || !Array.isArray(events)) {
      return res.status(400).json({ error: "Invalid payload" });
    }
    await db.upsertSession(sessionId, url, siteId || "");
    await db.insertEvents(sessionId, events);
    console.log(`[Eye] Stored ${events.length} events for session ${sessionId.slice(0, 8)}... (site: ${siteId || "self"})`);
    res.json({ ok: true, count: events.length });
  } catch (e) {
    console.error("Event ingestion error:", e);
    res.status(500).json({ error: "Failed to store events" });
  }
});

// ── Public debug endpoint (test connectivity from any site) ──────────
app.get("/api/debug/ping", (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.json({ ok: true, ts: new Date().toISOString(), msg: "Eye endpoint is reachable" });
});

app.post("/api/debug/ping", (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  const len = body ? body.length : 0;
  console.log(`[Eye Debug] Received test ping, body size: ${len} bytes`);
  res.json({ ok: true, received: len, ts: new Date().toISOString() });
});

// ── Debug logs reader (public but key-protected, for remote CLI access) ──
app.get("/api/debug/logs", (req, res, next) => {
  // Allow access with ?key=<EYE_PASSWORD> (for CLI tooling)
  // Otherwise falls through to the auth-protected version below
  const key = req.query.key;
  if (key && auth.verifyPassword(key)) {
    return db.getDebugLogs(100).then((logs) => {
      res.json({ logs });
    }).catch((e) => res.status(500).json({ error: e.message }));
  }
  next(); // fall through to auth middleware
});

// ── Remote debug log ingestion (public - client sites send logs here) ──
app.post("/api/debug/log", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    await db.insertDebugLog(body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Auth middleware for everything below ─────────────────────────────
function requireAuth(req, res, next) {
  const token = req.cookies.eye_token;
  if (auth.isValidToken(token)) return next();

  // API requests get 401, browser requests get redirected
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return res.redirect("/login");
}

app.use(requireAuth);

// ── Static assets (protected) ────────────────────────────────────────
app.use(express.static(path.join(__dirname, "..", "public")));

// ── Debug logs viewer (protected) ────────────────────────────────────
app.get("/api/debug/logs", async (req, res) => {
  try {
    const logs = await db.getDebugLogs(100);
    res.json({ logs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/debug/logs", async (req, res) => {
  try {
    await db.clearDebugLogs();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Site management ──────────────────────────────────────────────────
app.get("/api/sites", async (req, res) => {
  try {
    const sites = await db.getSites();
    res.json({ sites });
  } catch (e) {
    console.error("List sites error:", e);
    res.status(500).json({ error: "Failed to load sites" });
  }
});

app.post("/api/sites", async (req, res) => {
  try {
    const { name, domain } = req.body;
    if (!name) return res.status(400).json({ error: "Name is required" });
    const id = require("crypto").randomBytes(12).toString("hex");
    await db.createSite(id, name, domain);
    const site = await db.getSite(id);
    res.json({ ok: true, site });
  } catch (e) {
    console.error("Create site error:", e);
    res.status(500).json({ error: "Failed to create site" });
  }
});

app.put("/api/sites/:id", async (req, res) => {
  try {
    const { name, domain } = req.body;
    if (!name) return res.status(400).json({ error: "Name is required" });
    await db.updateSite(req.params.id, name, domain);
    res.json({ ok: true });
  } catch (e) {
    console.error("Update site error:", e);
    res.status(500).json({ error: "Failed to update site" });
  }
});

app.delete("/api/sites/:id", async (req, res) => {
  try {
    await db.deleteSite(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error("Delete site error:", e);
    res.status(500).json({ error: "Failed to delete site" });
  }
});

// ── List all sessions (with optional search & filters) ───────────────
app.get("/api/sessions", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 25);
    const offset = (page - 1) * limit;
    const search = req.query.search || "";
    const dateFrom = req.query.dateFrom || "";
    const dateTo = req.query.dateTo || "";
    const minEvents = parseInt(req.query.minEvents) || 0;
    const siteId = req.query.siteId || "";

    const hasFilters = search || dateFrom || dateTo || minEvents || siteId;

    if (hasFilters) {
      const { rows, total } = await db.searchSessions({
        search, dateFrom, dateTo, minEvents, siteId, limit, offset,
      });
      return res.json({ sessions: rows, total, page, limit });
    }

    const [sessions, total] = await Promise.all([
      db.getSessions(limit, offset),
      db.getSessionCount(),
    ]);

    res.json({ sessions, total, page, limit });
  } catch (e) {
    console.error("List sessions error:", e);
    res.status(500).json({ error: "Failed to load sessions" });
  }
});

// ── Get single session detail ────────────────────────────────────────
app.get("/api/sessions/:id", async (req, res) => {
  try {
    const session = await db.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    res.json(session);
  } catch (e) {
    console.error("Get session error:", e);
    res.status(500).json({ error: "Failed to load session" });
  }
});

// ── Get events for a session ─────────────────────────────────────────
app.get("/api/sessions/:id/events", async (req, res) => {
  try {
    const events = await db.getEvents(req.params.id);
    res.json({ events });
  } catch (e) {
    console.error("Get events error:", e);
    res.status(500).json({ error: "Failed to load events" });
  }
});

// ── Delete a session ─────────────────────────────────────────────────
app.delete("/api/sessions/:id", async (req, res) => {
  try {
    await db.deleteSession(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error("Delete session error:", e);
    res.status(500).json({ error: "Failed to delete session" });
  }
});

// ── Dashboard SPA fallback ───────────────────────────────────────────
app.get("/replay/*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// Start server when run directly (not on Vercel)
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Eye Session Replay running at http://localhost:${PORT}`);
    console.log(`Default password: eye-admin (set EYE_PASSWORD env var to change)`);
  });
}

// Export for Vercel serverless
module.exports = app;
