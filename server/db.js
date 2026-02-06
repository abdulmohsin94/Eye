// ── Turso (libSQL) persistent storage ────────────────────────────────
// Set these env vars in Vercel:
//   TURSO_DATABASE_URL  - e.g. libsql://your-db-name-your-org.turso.io
//   TURSO_AUTH_TOKEN    - your Turso auth token

const { createClient } = require("@libsql/client");

const client = createClient({
  url: process.env.TURSO_DATABASE_URL || "file:./data/local.db",
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// ── Initialize schema ────────────────────────────────────────────────
let initialized = false;

async function init() {
  if (initialized) return;
  await client.batch([
    `CREATE TABLE IF NOT EXISTS sessions (
      id           TEXT PRIMARY KEY,
      url          TEXT,
      event_count  INTEGER DEFAULT 0,
      first_seen   TEXT DEFAULT (datetime('now')),
      last_seen    TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      seq        INTEGER NOT NULL,
      t          INTEGER NOT NULL,
      type       TEXT NOT NULL,
      data       TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq)`,
  ]);
  initialized = true;
}

// ── Exports ──────────────────────────────────────────────────────────
module.exports = {
  init,

  async upsertSession(sessionId, url) {
    await init();
    await client.execute({
      sql: `INSERT INTO sessions (id, url) VALUES (?, ?)
            ON CONFLICT(id) DO UPDATE SET url = excluded.url, last_seen = datetime('now')`,
      args: [sessionId, url],
    });
  },

  async insertEvents(sessionId, events) {
    await init();
    const stmts = events.map((evt) => ({
      sql: "INSERT INTO events (session_id, seq, t, type, data) VALUES (?, ?, ?, ?, ?)",
      args: [sessionId, evt.seq, evt.t, evt.type, JSON.stringify(evt.data)],
    }));
    // Update event count after insert
    stmts.push({
      sql: "UPDATE sessions SET event_count = (SELECT COUNT(*) FROM events WHERE session_id = ?) WHERE id = ?",
      args: [sessionId, sessionId],
    });
    await client.batch(stmts);
  },

  async getSessions(limit, offset) {
    await init();
    const result = await client.execute({
      sql: "SELECT * FROM sessions ORDER BY last_seen DESC LIMIT ? OFFSET ?",
      args: [limit, offset],
    });
    return result.rows;
  },

  async getSessionCount() {
    await init();
    const result = await client.execute("SELECT COUNT(*) as count FROM sessions");
    return Number(result.rows[0].count);
  },

  async searchSessions({ search, dateFrom, dateTo, minEvents, limit, offset }) {
    await init();
    const conditions = [];
    const args = [];

    if (search) {
      conditions.push("(id LIKE ? OR url LIKE ?)");
      args.push(`%${search}%`, `%${search}%`);
    }
    if (dateFrom) {
      conditions.push("first_seen >= ?");
      args.push(dateFrom);
    }
    if (dateTo) {
      conditions.push("first_seen <= ?");
      args.push(dateTo + " 23:59:59");
    }
    if (minEvents) {
      conditions.push("event_count >= ?");
      args.push(minEvents);
    }

    const where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

    const [rowsResult, countResult] = await Promise.all([
      client.execute({
        sql: `SELECT * FROM sessions ${where} ORDER BY last_seen DESC LIMIT ? OFFSET ?`,
        args: [...args, limit, offset],
      }),
      client.execute({
        sql: `SELECT COUNT(*) as count FROM sessions ${where}`,
        args: args,
      }),
    ]);

    return {
      rows: rowsResult.rows,
      total: Number(countResult.rows[0].count),
    };
  },

  async getSession(id) {
    await init();
    const result = await client.execute({
      sql: "SELECT * FROM sessions WHERE id = ?",
      args: [id],
    });
    return result.rows[0] || null;
  },

  async getEvents(sessionId) {
    await init();
    const result = await client.execute({
      sql: "SELECT * FROM events WHERE session_id = ? ORDER BY seq ASC",
      args: [sessionId],
    });
    return result.rows;
  },

  async deleteSession(id) {
    await init();
    await client.batch([
      { sql: "DELETE FROM events WHERE session_id = ?", args: [id] },
      { sql: "DELETE FROM sessions WHERE id = ?", args: [id] },
    ]);
  },
};
