const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "eye.db");

// Ensure data directory exists
const fs = require("fs");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read/write performance
db.pragma("journal_mode = WAL");

// ── Schema ───────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id           TEXT PRIMARY KEY,
    url          TEXT,
    event_count  INTEGER DEFAULT 0,
    first_seen   TEXT DEFAULT (datetime('now')),
    last_seen    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    t          INTEGER NOT NULL,
    type       TEXT NOT NULL,
    data       TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);
`);

// ── Prepared statements ──────────────────────────────────────────────
const stmts = {
  upsertSession: db.prepare(`
    INSERT INTO sessions (id, url) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET
      url = excluded.url,
      last_seen = datetime('now')
  `),

  updateEventCount: db.prepare(`
    UPDATE sessions SET event_count = (
      SELECT COUNT(*) FROM events WHERE session_id = ?
    ) WHERE id = ?
  `),

  insertEvent: db.prepare(`
    INSERT INTO events (session_id, seq, t, type, data) VALUES (?, ?, ?, ?, ?)
  `),

  getSessions: db.prepare(`
    SELECT * FROM sessions ORDER BY last_seen DESC LIMIT ? OFFSET ?
  `),

  getSessionCount: db.prepare(`SELECT COUNT(*) as count FROM sessions`),

  getSession: db.prepare(`SELECT * FROM sessions WHERE id = ?`),

  getEvents: db.prepare(`
    SELECT * FROM events WHERE session_id = ? ORDER BY seq ASC
  `),

  deleteEvents: db.prepare(`DELETE FROM events WHERE session_id = ?`),
  deleteSession: db.prepare(`DELETE FROM sessions WHERE id = ?`),
};

// ── Transactional batch insert ───────────────────────────────────────
const insertMany = db.transaction((sessionId, events) => {
  for (const evt of events) {
    stmts.insertEvent.run(
      sessionId,
      evt.seq,
      evt.t,
      evt.type,
      JSON.stringify(evt.data)
    );
  }
  stmts.updateEventCount.run(sessionId, sessionId);
});

// ── Exports ──────────────────────────────────────────────────────────
module.exports = {
  upsertSession(sessionId, url) {
    stmts.upsertSession.run(sessionId, url);
  },

  insertEvents(sessionId, events) {
    insertMany(sessionId, events);
  },

  getSessions(limit, offset) {
    return stmts.getSessions.all(limit, offset);
  },

  getSessionCount() {
    return stmts.getSessionCount.get().count;
  },

  getSession(id) {
    return stmts.getSession.get(id);
  },

  getEvents(sessionId) {
    return stmts.getEvents.all(sessionId);
  },

  deleteSession(id) {
    stmts.deleteEvents.run(id);
    stmts.deleteSession.run(id);
  },
};
