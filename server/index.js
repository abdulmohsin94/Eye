const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const path = require("path");
const db = require("./db");
const auth = require("./auth");

const app = express();
const PORT = process.env.PORT || 3000;

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
  res.cookie("eye_token", token, {
    httpOnly: true,
    sameSite: "lax",
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
app.post("/api/events", (req, res) => {
  const { sessionId, url, events } = req.body;
  if (!sessionId || !events || !Array.isArray(events)) {
    return res.status(400).json({ error: "Invalid payload" });
  }
  db.upsertSession(sessionId, url);
  db.insertEvents(sessionId, events);
  res.json({ ok: true, count: events.length });
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

// ── List all sessions ────────────────────────────────────────────────
app.get("/api/sessions", (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 25);
  const offset = (page - 1) * limit;

  const sessions = db.getSessions(limit, offset);
  const total = db.getSessionCount();

  res.json({ sessions, total, page, limit });
});

// ── Get single session detail ────────────────────────────────────────
app.get("/api/sessions/:id", (req, res) => {
  const session = db.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json(session);
});

// ── Get events for a session ─────────────────────────────────────────
app.get("/api/sessions/:id/events", (req, res) => {
  const events = db.getEvents(req.params.id);
  res.json({ events });
});

// ── Delete a session ─────────────────────────────────────────────────
app.delete("/api/sessions/:id", (req, res) => {
  db.deleteSession(req.params.id);
  res.json({ ok: true });
});

// ── Dashboard SPA fallback ───────────────────────────────────────────
app.get("/replay/*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Eye Session Replay running at http://localhost:${PORT}`);
  console.log(`Default password: eye-admin (set EYE_PASSWORD env var to change)`);
});
