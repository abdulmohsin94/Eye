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
app.use("/snippet", express.static(path.join(__dirname, "..", "snippet")));

// ── Event ingestion (public - no auth required) ──────────────────────
app.post("/api/events", async (req, res) => {
  try {
    const { sessionId, url, events } = req.body;
    if (!sessionId || !events || !Array.isArray(events)) {
      return res.status(400).json({ error: "Invalid payload" });
    }
    await db.upsertSession(sessionId, url);
    await db.insertEvents(sessionId, events);
    res.json({ ok: true, count: events.length });
  } catch (e) {
    console.error("Event ingestion error:", e);
    res.status(500).json({ error: "Failed to store events" });
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

    const hasFilters = search || dateFrom || dateTo || minEvents;

    if (hasFilters) {
      const { rows, total } = await db.searchSessions({
        search, dateFrom, dateTo, minEvents, limit, offset,
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
