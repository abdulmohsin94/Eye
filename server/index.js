const express = require("express");
const cors = require("cors");
const path = require("path");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

// ── Ingest events from the recorder snippet ──────────────────────────
app.post("/api/events", (req, res) => {
  const { sessionId, url, events } = req.body;
  if (!sessionId || !events || !Array.isArray(events)) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  // Upsert session row
  db.upsertSession(sessionId, url);

  // Store events
  db.insertEvents(sessionId, events);

  res.json({ ok: true, count: events.length });
});

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
});
