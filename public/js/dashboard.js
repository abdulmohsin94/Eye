// ── Eye Session Replay Dashboard ─────────────────────────────────────

(function () {
  "use strict";

  const API = "";

  // ── Auth helper: redirect to login on 401 ─────────────────────
  function checkAuth(res) {
    if (res.status === 401) {
      window.location.href = "/login";
      return false;
    }
    return true;
  }

  // ── DOM refs ─────────────────────────────────────────────────────
  const viewSessions = document.getElementById("view-sessions");
  const viewReplay = document.getElementById("view-replay");
  const sessionsBody = document.getElementById("sessions-body");
  const btnRefresh = document.getElementById("btn-refresh");
  const btnBack = document.getElementById("btn-back");
  const replayTitle = document.getElementById("replay-title");
  const replayFrame = document.getElementById("replay-frame");
  const replayCursor = document.getElementById("replay-cursor");
  const btnPlay = document.getElementById("btn-play");
  const btnPause = document.getElementById("btn-pause");
  const scrubber = document.getElementById("replay-scrubber");
  const timeDisplay = document.getElementById("replay-time");
  const speedSelect = document.getElementById("replay-speed");
  const timelineEvents = document.getElementById("timeline-events");

  // ── State ────────────────────────────────────────────────────────
  let currentEvents = [];
  let playbackTimer = null;
  let playbackIndex = 0;
  let playbackStart = 0;
  let totalDuration = 0;
  let speed = 1;
  let isPlaying = false;
  let viewportScale = 1;

  // ── Filter DOM refs ─────────────────────────────────────────────
  const filterSearch = document.getElementById("filter-search");
  const filterDateFrom = document.getElementById("filter-date-from");
  const filterDateTo = document.getElementById("filter-date-to");
  const filterMinEvents = document.getElementById("filter-min-events");
  const btnClearFilters = document.getElementById("btn-clear-filters");
  const resultsSummary = document.getElementById("results-summary");

  // ── Sessions List ────────────────────────────────────────────────
  let debounceTimer = null;

  function getFilterParams() {
    const params = new URLSearchParams();
    const search = filterSearch.value.trim();
    const dateFrom = filterDateFrom.value;
    const dateTo = filterDateTo.value;
    const minEvents = filterMinEvents.value;

    if (search) params.set("search", search);
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    if (minEvents && parseInt(minEvents) > 0) params.set("minEvents", minEvents);

    return params;
  }

  async function loadSessions() {
    try {
      const params = getFilterParams();
      const res = await fetch(`${API}/api/sessions?${params.toString()}`);
      if (!checkAuth(res)) return;
      const data = await res.json();
      renderSessions(data.sessions, data.total);
    } catch (e) {
      sessionsBody.innerHTML =
        '<tr><td colspan="6" class="empty-state">Failed to load sessions.</td></tr>';
      resultsSummary.textContent = "";
    }
  }

  function renderSessions(sessions, total) {
    const hasFilters = getFilterParams().toString().length > 0;

    if (total !== undefined) {
      resultsSummary.textContent = hasFilters
        ? `${total} session${total !== 1 ? "s" : ""} found`
        : `${total} total session${total !== 1 ? "s" : ""}`;
    } else {
      resultsSummary.textContent = "";
    }

    if (!sessions || sessions.length === 0) {
      sessionsBody.innerHTML = hasFilters
        ? '<tr><td colspan="6" class="empty-state">No sessions match your filters.</td></tr>'
        : '<tr><td colspan="6" class="empty-state">No sessions recorded yet. Add the snippet to your site to start capturing.</td></tr>';
      return;
    }

    sessionsBody.innerHTML = sessions
      .map(
        (s) => `
      <tr>
        <td><span class="session-id">${s.id.slice(0, 12)}...</span></td>
        <td><span class="session-url" title="${esc(s.url)}">${esc(s.url || "—")}</span></td>
        <td><span class="badge badge-events">${s.event_count}</span></td>
        <td>${formatDate(s.first_seen)}</td>
        <td>${formatDate(s.last_seen)}</td>
        <td>
          <button class="btn btn-sm btn-primary" onclick="window.__eye_replay('${s.id}')">Replay</button>
          <button class="btn btn-sm btn-danger" onclick="window.__eye_delete('${s.id}')">Delete</button>
        </td>
      </tr>
    `
      )
      .join("");
  }

  // ── Filter event listeners ─────────────────────────────────────
  filterSearch.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(loadSessions, 300);
  });

  filterDateFrom.addEventListener("change", loadSessions);
  filterDateTo.addEventListener("change", loadSessions);
  filterMinEvents.addEventListener("change", loadSessions);

  btnClearFilters.addEventListener("click", () => {
    filterSearch.value = "";
    filterDateFrom.value = "";
    filterDateTo.value = "";
    filterMinEvents.value = "";
    loadSessions();
  });

  // ── Replay ───────────────────────────────────────────────────────
  async function startReplay(sessionId) {
    try {
      const res = await fetch(`${API}/api/sessions/${sessionId}/events`);
      if (!checkAuth(res)) return;
      const data = await res.json();
      currentEvents = data.events.map((e) => ({
        ...e,
        data: typeof e.data === "string" ? JSON.parse(e.data) : e.data,
      }));

      if (currentEvents.length === 0) {
        alert("No events recorded for this session.");
        return;
      }

      // Switch views
      viewSessions.classList.add("hidden");
      viewReplay.classList.remove("hidden");
      replayTitle.textContent = `Session ${sessionId.slice(0, 12)}...`;

      // Calculate total duration
      totalDuration = currentEvents[currentEvents.length - 1].t;
      scrubber.max = totalDuration;
      scrubber.value = 0;
      updateTimeDisplay(0);

      // Render timeline
      renderTimeline();

      // Load initial snapshot
      const snapshot = currentEvents.find((e) => e.type === "snapshot");
      if (snapshot) {
        loadSnapshot(snapshot.data);
      }

      playbackIndex = 0;
      isPlaying = false;
      btnPlay.classList.remove("hidden");
      btnPause.classList.add("hidden");
      replayCursor.style.display = "none";
    } catch (e) {
      alert("Failed to load session events.");
    }
  }

  function loadSnapshot(data) {
    const doc = replayFrame.contentDocument;
    doc.open();
    doc.write(data.html);
    doc.close();

    // Remove all scripts to prevent execution
    const scripts = doc.querySelectorAll("script");
    scripts.forEach((s) => s.remove());

    // Scale to fit viewport
    if (data.width) {
      const container = document.getElementById("replay-viewport");
      viewportScale = container.clientWidth / data.width;
      replayFrame.style.width = data.width + "px";
      replayFrame.style.height = data.height + "px";
      replayFrame.style.transform = `scale(${viewportScale})`;
    }
  }

  // ── Playback Engine ──────────────────────────────────────────────
  function play() {
    if (playbackIndex >= currentEvents.length) {
      playbackIndex = 0;
    }
    isPlaying = true;
    btnPlay.classList.add("hidden");
    btnPause.classList.remove("hidden");
    replayCursor.style.display = "block";

    playbackStart = Date.now() - currentEvents[playbackIndex].t / speed;
    scheduleNext();
  }

  function pause() {
    isPlaying = false;
    clearTimeout(playbackTimer);
    btnPause.classList.add("hidden");
    btnPlay.classList.remove("hidden");
  }

  function scheduleNext() {
    if (!isPlaying || playbackIndex >= currentEvents.length) {
      pause();
      return;
    }

    const evt = currentEvents[playbackIndex];
    const elapsed = (Date.now() - playbackStart) * speed;
    const delay = Math.max(0, (evt.t - elapsed) / speed);

    playbackTimer = setTimeout(() => {
      processEvent(evt);
      playbackIndex++;
      scrubber.value = evt.t;
      updateTimeDisplay(evt.t);

      // Highlight active timeline dot
      document.querySelectorAll(".timeline-dot").forEach((d) => d.classList.remove("active"));
      const dot = document.getElementById("dot-" + playbackIndex);
      if (dot) dot.classList.add("active");

      scheduleNext();
    }, delay);
  }

  function processEvent(evt) {
    const d = evt.data;
    switch (evt.type) {
      case "snapshot":
        loadSnapshot(d);
        break;

      case "mousemove":
        replayCursor.style.left = d.x * viewportScale + "px";
        replayCursor.style.top = d.y * viewportScale + "px";
        replayCursor.style.display = "block";
        replayCursor.classList.remove("clicking", "rage");
        break;

      case "click":
        replayCursor.style.left = d.x * viewportScale + "px";
        replayCursor.style.top = d.y * viewportScale + "px";
        replayCursor.classList.add("clicking");
        setTimeout(() => replayCursor.classList.remove("clicking"), 300);
        break;

      case "rage_click":
        replayCursor.style.left = d.x * viewportScale + "px";
        replayCursor.style.top = d.y * viewportScale + "px";
        replayCursor.classList.add("rage");
        setTimeout(() => replayCursor.classList.remove("rage"), 600);
        break;

      case "scroll":
        try {
          replayFrame.contentWindow.scrollTo(d.x, d.y);
        } catch (e) {}
        break;

      case "resize":
        // Update viewport scale
        const container = document.getElementById("replay-viewport");
        viewportScale = container.clientWidth / d.width;
        replayFrame.style.width = d.width + "px";
        replayFrame.style.height = d.height + "px";
        replayFrame.style.transform = `scale(${viewportScale})`;
        break;

      case "input":
        try {
          const el = replayFrame.contentDocument.querySelector(d.selector);
          if (el) el.value = d.value;
        } catch (e) {}
        break;

      case "mutation":
        // For now just display in timeline; full DOM patching is complex
        break;

      case "error":
        console.warn("[Eye Replay] JS Error:", d.message, d.filename, d.lineno);
        break;
    }
  }

  // ── Scrubber / Seek ──────────────────────────────────────────────
  scrubber.addEventListener("input", () => {
    const targetT = parseInt(scrubber.value);
    seekTo(targetT);
  });

  function seekTo(targetT) {
    const wasPlaying = isPlaying;
    if (isPlaying) pause();

    // Find nearest snapshot before targetT
    let snapshotIdx = -1;
    for (let i = 0; i < currentEvents.length; i++) {
      if (currentEvents[i].type === "snapshot" && currentEvents[i].t <= targetT) {
        snapshotIdx = i;
      }
    }

    // Replay from snapshot to targetT
    if (snapshotIdx >= 0) {
      processEvent(currentEvents[snapshotIdx]);
    }

    // Fast-forward through events up to targetT
    for (let i = snapshotIdx + 1; i < currentEvents.length; i++) {
      if (currentEvents[i].t > targetT) {
        playbackIndex = i;
        break;
      }
      processEvent(currentEvents[i]);
      playbackIndex = i + 1;
    }

    updateTimeDisplay(targetT);

    if (wasPlaying) {
      playbackStart = Date.now() - targetT / speed;
      isPlaying = true;
      btnPlay.classList.add("hidden");
      btnPause.classList.remove("hidden");
      scheduleNext();
    }
  }

  // ── Speed ────────────────────────────────────────────────────────
  speedSelect.addEventListener("change", () => {
    speed = parseFloat(speedSelect.value);
    if (isPlaying) {
      const currentT = currentEvents[Math.max(0, playbackIndex - 1)]?.t || 0;
      playbackStart = Date.now() - currentT / speed;
    }
  });

  // ── Timeline ─────────────────────────────────────────────────────
  function renderTimeline() {
    const significant = currentEvents.filter(
      (e) => e.type !== "mousemove"
    );
    timelineEvents.innerHTML = significant
      .map((e, i) => {
        const label = e.type === "click" ? `click ${e.data.tag || ""}` : e.type;
        return `<span class="timeline-dot evt-${e.type}" id="dot-${i}"
                      onclick="window.__eye_seek(${e.t})"
                      title="${e.type} @ ${formatMs(e.t)}">${label} <small>${formatMs(e.t)}</small></span>`;
      })
      .join("");
  }

  // ── Helpers ──────────────────────────────────────────────────────
  function formatMs(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, "0")}`;
  }

  function updateTimeDisplay(currentMs) {
    timeDisplay.textContent = `${formatMs(currentMs)} / ${formatMs(totalDuration)}`;
  }

  function formatDate(d) {
    if (!d) return "—";
    return new Date(d + "Z").toLocaleString();
  }

  function esc(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Delete session ───────────────────────────────────────────────
  async function deleteSession(id) {
    if (!confirm("Delete this session and all its events?")) return;
    const res = await fetch(`${API}/api/sessions/${id}`, { method: "DELETE" });
    if (!checkAuth(res)) return;
    loadSessions();
  }

  // ── Navigation ───────────────────────────────────────────────────
  btnBack.addEventListener("click", () => {
    pause();
    viewReplay.classList.add("hidden");
    viewSessions.classList.remove("hidden");
    replayCursor.style.display = "none";
    loadSessions();
  });

  btnRefresh.addEventListener("click", () => { loadSessions(); });
  btnPlay.addEventListener("click", play);
  btnPause.addEventListener("click", pause);

  // ── Expose globals for inline handlers ───────────────────────────
  window.__eye_replay = startReplay;
  window.__eye_delete = deleteSession;
  window.__eye_seek = (t) => {
    scrubber.value = t;
    seekTo(t);
  };

  // ── Mobile sidebar toggle ────────────────────────────────────────
  const menuToggle = document.getElementById("menu-toggle");
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebar-overlay");

  function openSidebar() {
    sidebar.classList.add("open");
    overlay.classList.remove("hidden");
  }
  function closeSidebar() {
    sidebar.classList.remove("open");
    overlay.classList.add("hidden");
  }

  menuToggle.addEventListener("click", () => {
    sidebar.classList.contains("open") ? closeSidebar() : openSidebar();
  });
  overlay.addEventListener("click", closeSidebar);

  // Close sidebar when a nav link is tapped on mobile
  sidebar.querySelectorAll(".nav-link").forEach((link) => {
    link.addEventListener("click", closeSidebar);
  });

  // ── Init ─────────────────────────────────────────────────────────
  loadSessions();
})();
