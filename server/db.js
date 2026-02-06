// ── In-memory storage (Vercel-compatible) ────────────────────────────
// Data lives in memory for the lifetime of the serverless function.
// For persistent storage, swap this for a hosted DB (Turso, Supabase, etc.)

const sessions = new Map();
const events = new Map(); // sessionId -> [events]

function now() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

module.exports = {
  upsertSession(sessionId, url) {
    const existing = sessions.get(sessionId);
    if (existing) {
      existing.url = url;
      existing.last_seen = now();
    } else {
      sessions.set(sessionId, {
        id: sessionId,
        url,
        event_count: 0,
        first_seen: now(),
        last_seen: now(),
      });
    }
  },

  insertEvents(sessionId, newEvents) {
    if (!events.has(sessionId)) {
      events.set(sessionId, []);
    }
    const list = events.get(sessionId);
    for (const evt of newEvents) {
      list.push({
        id: list.length + 1,
        session_id: sessionId,
        seq: evt.seq,
        t: evt.t,
        type: evt.type,
        data: JSON.stringify(evt.data),
      });
    }
    // Update event count
    const session = sessions.get(sessionId);
    if (session) {
      session.event_count = list.length;
    }
  },

  getSessions(limit, offset) {
    const all = Array.from(sessions.values())
      .sort((a, b) => (b.last_seen > a.last_seen ? 1 : -1));
    return all.slice(offset, offset + limit);
  },

  getSessionCount() {
    return sessions.size;
  },

  searchSessions({ search, dateFrom, dateTo, minEvents, limit, offset }) {
    let results = Array.from(sessions.values());

    if (search) {
      const q = search.toLowerCase();
      results = results.filter(
        (s) => s.id.toLowerCase().includes(q) || (s.url || "").toLowerCase().includes(q)
      );
    }
    if (dateFrom) {
      results = results.filter((s) => s.first_seen >= dateFrom);
    }
    if (dateTo) {
      results = results.filter((s) => s.first_seen <= dateTo + " 23:59:59");
    }
    if (minEvents) {
      results = results.filter((s) => s.event_count >= minEvents);
    }

    results.sort((a, b) => (b.last_seen > a.last_seen ? 1 : -1));
    const total = results.length;
    const rows = results.slice(offset, offset + limit);
    return { rows, total };
  },

  getSession(id) {
    return sessions.get(id) || null;
  },

  getEvents(sessionId) {
    const list = events.get(sessionId) || [];
    return list.slice().sort((a, b) => a.seq - b.seq);
  },

  deleteSession(id) {
    sessions.delete(id);
    events.delete(id);
  },
};
