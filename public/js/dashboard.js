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
  const btnFullscreen = document.getElementById("btn-fullscreen");
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
  const filterSite = document.getElementById("filter-site");
  const filterDateFrom = document.getElementById("filter-date-from");
  const filterDateTo = document.getElementById("filter-date-to");
  const filterMinEvents = document.getElementById("filter-min-events");
  const btnClearFilters = document.getElementById("btn-clear-filters");
  const resultsSummary = document.getElementById("results-summary");

  // ── Site management DOM refs ──────────────────────────────────
  const viewSites = document.getElementById("view-sites");
  const btnAddSite = document.getElementById("btn-add-site");
  const siteForm = document.getElementById("site-form");
  const siteFormTitle = document.getElementById("site-form-title");
  const siteNameInput = document.getElementById("site-name");
  const siteDomainInput = document.getElementById("site-domain");
  const btnSaveSite = document.getElementById("btn-save-site");
  const btnCancelSite = document.getElementById("btn-cancel-site");
  const sitesList = document.getElementById("sites-list");
  let editingSiteId = null;
  let sitesCache = [];

  // ── Sessions List ────────────────────────────────────────────────
  let debounceTimer = null;

  function getFilterParams() {
    const params = new URLSearchParams();
    const siteId = filterSite.value;
    const search = filterSearch.value.trim();
    const dateFrom = filterDateFrom.value;
    const dateTo = filterDateTo.value;
    const minEvents = filterMinEvents.value;

    if (siteId) params.set("siteId", siteId);
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

  filterSite.addEventListener("change", loadSessions);
  filterDateFrom.addEventListener("change", loadSessions);
  filterDateTo.addEventListener("change", loadSessions);
  filterMinEvents.addEventListener("change", loadSessions);

  btnClearFilters.addEventListener("click", () => {
    filterSite.value = "";
    filterSearch.value = "";
    filterDateFrom.value = "";
    filterDateTo.value = "";
    filterMinEvents.value = "";
    loadSessions();
  });

  // ── Normalize timestamps across page reloads ────────────────────
  // When a page reloads within the same session, the recorder resets
  // its startTs so timestamps jump back near 0. We detect these resets
  // (a snapshot event with a t much smaller than the previous event)
  // and accumulate an offset so the timeline is continuous.
  function normalizeTimestamps() {
    if (currentEvents.length === 0) return;

    let offset = 0;
    let prevT = 0;
    const GAP_BETWEEN_LOADS = 500; // add 500ms gap between page loads

    for (let i = 0; i < currentEvents.length; i++) {
      const evt = currentEvents[i];
      // Detect a timestamp reset: t drops significantly below previous
      if (i > 0 && evt.t < prevT - 1000) {
        // New page load detected: shift by previous high-water mark + gap
        offset = prevT + GAP_BETWEEN_LOADS;
      }
      prevT = evt.t;
      evt.t = evt.t + offset;
    }
  }

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

      // Normalize timestamps: page reloads reset t to 0, so we need to
      // detect those resets and make timestamps continuously increasing.
      normalizeTimestamps();

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

      // Find first non-snapshot event to start from
      playbackIndex = 0;
      for (let i = 0; i < currentEvents.length; i++) {
        if (currentEvents[i].type !== "snapshot" && currentEvents[i].type !== "styles") {
          playbackIndex = i;
          break;
        }
      }

      isPlaying = false;
      btnPlay.classList.remove("hidden");
      btnPause.classList.add("hidden");
      replayCursor.style.display = "none";

      // Auto-play
      play();
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

  // ── Playback Engine (requestAnimationFrame-based) ──────────────
  let rafId = null;

  function play() {
    if (playbackIndex >= currentEvents.length) {
      playbackIndex = 0;
      // Reload snapshot
      const snapshot = currentEvents.find((e) => e.type === "snapshot");
      if (snapshot) loadSnapshot(snapshot.data);
    }
    isPlaying = true;
    btnPlay.classList.add("hidden");
    btnPause.classList.remove("hidden");
    replayCursor.style.display = "block";

    playbackStart = performance.now() - (currentEvents[playbackIndex].t / speed);
    if (rafId) cancelAnimationFrame(rafId);
    rafLoop();
  }

  function pause() {
    isPlaying = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    btnPause.classList.add("hidden");
    btnPlay.classList.remove("hidden");
  }

  function rafLoop() {
    if (!isPlaying) return;

    const elapsed = (performance.now() - playbackStart) * speed;
    let eventsThisFrame = 0;
    const maxPerFrame = 50; // cap to avoid jank

    while (
      playbackIndex < currentEvents.length &&
      eventsThisFrame < maxPerFrame
    ) {
      const evt = currentEvents[playbackIndex];
      if (evt.t > elapsed) break; // not time yet

      processEvent(evt);
      playbackIndex++;
      eventsThisFrame++;
    }

    // Update UI (only once per frame, not per event)
    if (eventsThisFrame > 0) {
      const currentT = currentEvents[Math.min(playbackIndex, currentEvents.length - 1)].t;
      scrubber.value = currentT;
      updateTimeDisplay(currentT);
    }

    if (playbackIndex >= currentEvents.length) {
      pause();
      return;
    }

    rafId = requestAnimationFrame(rafLoop);
  }

  function processEvent(evt) {
    const d = evt.data;
    switch (evt.type) {
      case "snapshot":
        loadSnapshot(d);
        break;

      case "mousemove":
        replayCursor.style.left = (d.x * viewportScale) + "px";
        replayCursor.style.top = (d.y * viewportScale) + "px";
        replayCursor.style.display = "block";
        replayCursor.classList.remove("clicking", "rage");
        break;

      case "click":
        replayCursor.style.left = (d.x * viewportScale) + "px";
        replayCursor.style.top = (d.y * viewportScale) + "px";
        replayCursor.classList.add("clicking");
        setTimeout(() => replayCursor.classList.remove("clicking"), 300);
        break;

      case "rage_click":
        replayCursor.style.left = (d.x * viewportScale) + "px";
        replayCursor.style.top = (d.y * viewportScale) + "px";
        replayCursor.classList.add("rage");
        setTimeout(() => replayCursor.classList.remove("rage"), 600);
        break;

      case "scroll":
        try {
          replayFrame.contentWindow.scrollTo(d.x, d.y);
        } catch (e) {}
        break;

      case "resize": {
        const container = document.getElementById("replay-viewport");
        viewportScale = container.clientWidth / d.width;
        replayFrame.style.width = d.width + "px";
        replayFrame.style.height = d.height + "px";
        replayFrame.style.transform = `scale(${viewportScale})`;
        break;
      }

      case "input":
        try {
          const el = replayFrame.contentDocument.querySelector(d.selector);
          if (el) el.value = d.value;
        } catch (e) {}
        break;

      case "mutation":
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
      // Skip mousemoves during seek for speed
      if (currentEvents[i].type !== "mousemove") {
        processEvent(currentEvents[i]);
      }
      playbackIndex = i + 1;
    }

    updateTimeDisplay(targetT);

    if (wasPlaying) {
      playbackStart = performance.now() - (targetT / speed);
      isPlaying = true;
      btnPlay.classList.add("hidden");
      btnPause.classList.remove("hidden");
      if (rafId) cancelAnimationFrame(rafId);
      rafLoop();
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

  // ── Fullscreen toggle ───────────────────────────────────────────
  function toggleFullscreen() {
    viewReplay.classList.toggle("fullscreen");
    // Recalculate viewport scale after layout change
    setTimeout(() => {
      const snapshot = currentEvents.find((e) => e.type === "snapshot");
      if (snapshot && snapshot.data.width) {
        const container = document.getElementById("replay-viewport");
        viewportScale = container.clientWidth / snapshot.data.width;
        replayFrame.style.transform = `scale(${viewportScale})`;
      }
    }, 100);
  }

  if (btnFullscreen) {
    btnFullscreen.addEventListener("click", toggleFullscreen);
  }

  // ── Navigation ───────────────────────────────────────────────────
  btnBack.addEventListener("click", () => {
    pause();
    viewReplay.classList.remove("fullscreen");
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

  // ── View navigation ────────────────────────────────────────────
  const allViews = [viewSessions, viewReplay, viewSites];
  const navLinks = document.querySelectorAll(".nav-link[data-view]");

  function showView(viewId) {
    allViews.forEach((v) => v.classList.add("hidden"));
    navLinks.forEach((l) => l.classList.remove("active"));
    const target = document.getElementById("view-" + viewId);
    if (target) target.classList.remove("hidden");
    const link = document.querySelector(`.nav-link[data-view="${viewId}"]`);
    if (link) link.classList.add("active");

    if (viewId === "sessions") loadSessions();
    if (viewId === "sites") loadSites();
  }

  navLinks.forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      showView(link.dataset.view);
      closeSidebar();
    });
  });

  // ── Site management ───────────────────────────────────────────
  async function loadSites() {
    try {
      const res = await fetch(`${API}/api/sites`);
      if (!checkAuth(res)) return;
      const data = await res.json();
      sitesCache = data.sites || [];
      renderSites(sitesCache);
      populateSiteFilter(sitesCache);
    } catch (e) {
      sitesList.innerHTML = '<div class="empty-state">Failed to load sites.</div>';
    }
  }

  async function populateSiteFilter(sites) {
    const current = filterSite.value;
    filterSite.innerHTML = '<option value="">All sites</option>';
    (sites || sitesCache).forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.name;
      filterSite.appendChild(opt);
    });
    filterSite.value = current;
  }

  function renderSites(sites) {
    if (!sites || sites.length === 0) {
      sitesList.innerHTML = '<div class="empty-state" style="padding:48px;text-align:center;color:var(--text-muted)">No sites yet. Click "+ Add Site" to create one and get a tracking snippet.</div>';
      return;
    }

    const host = location.origin;
    sitesList.innerHTML = sites.map((s) => `
      <div class="site-card" data-id="${s.id}">
        <div class="site-info">
          <div class="site-name">${esc(s.name)}</div>
          ${s.domain ? `<div class="site-domain">${esc(s.domain)}</div>` : ""}
          <div class="site-meta">
            <span class="site-id-badge">${s.id}</span>
            &middot; ${s.session_count || 0} session${s.session_count !== 1 ? "s" : ""}
            &middot; Created ${formatDate(s.created_at)}
          </div>
          <div class="snippet-block" id="snippet-${s.id}">
            <div style="margin-top:8px;margin-bottom:6px;font-size:12px;color:var(--text-muted)">
              Paste this as a <strong>Custom HTML</strong> tag in GTM, or add directly to your site:
            </div>
            <div class="snippet-code" id="code-${s.id}">&lt;script&gt;
window.__EYE_SITE_ID = "${s.id}";
window.__EYE_ENDPOINT = "${host}/api/events";
&lt;/script&gt;
&lt;script src="${host}/snippet/eye-recorder.js"&gt;&lt;/script&gt;</div>
            <button class="btn btn-sm" style="margin-top:8px" onclick="window.__eye_copy('${s.id}')">Copy</button>
          </div>
        </div>
        <div class="site-actions">
          <button class="btn btn-sm btn-primary" onclick="window.__eye_snippet_toggle('${s.id}')">Snippet</button>
          <button class="btn btn-sm" onclick="window.__eye_edit_site('${s.id}')">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="window.__eye_delete_site('${s.id}')">Delete</button>
        </div>
      </div>
    `).join("");
  }

  // Show/hide snippet
  window.__eye_snippet_toggle = (id) => {
    const el = document.getElementById("snippet-" + id);
    if (el) el.classList.toggle("open");
  };

  // Copy snippet to clipboard
  window.__eye_copy = (id) => {
    const host = location.origin;
    const text = `<script>\nwindow.__EYE_SITE_ID = "${id}";\nwindow.__EYE_ENDPOINT = "${host}/api/events";\n</script>\n<script src="${host}/snippet/eye-recorder.js"></script>`;
    navigator.clipboard.writeText(text).then(() => {
      alert("Snippet copied to clipboard!");
    });
  };

  // Add site
  btnAddSite.addEventListener("click", () => {
    editingSiteId = null;
    siteFormTitle.textContent = "Add New Site";
    siteNameInput.value = "";
    siteDomainInput.value = "";
    siteForm.classList.remove("hidden");
  });

  btnCancelSite.addEventListener("click", () => {
    siteForm.classList.add("hidden");
    editingSiteId = null;
  });

  // Save site (create or update)
  btnSaveSite.addEventListener("click", async () => {
    const name = siteNameInput.value.trim();
    const domain = siteDomainInput.value.trim();
    if (!name) { alert("Site name is required."); return; }

    try {
      if (editingSiteId) {
        const res = await fetch(`${API}/api/sites/${editingSiteId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, domain }),
        });
        if (!checkAuth(res)) return;
      } else {
        const res = await fetch(`${API}/api/sites`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, domain }),
        });
        if (!checkAuth(res)) return;
      }
      siteForm.classList.add("hidden");
      editingSiteId = null;
      loadSites();
    } catch (e) {
      alert("Failed to save site.");
    }
  });

  // Edit site
  window.__eye_edit_site = (id) => {
    const site = sitesCache.find((s) => s.id === id);
    if (!site) return;
    editingSiteId = id;
    siteFormTitle.textContent = "Edit Site";
    siteNameInput.value = site.name;
    siteDomainInput.value = site.domain || "";
    siteForm.classList.remove("hidden");
  };

  // Delete site
  window.__eye_delete_site = async (id) => {
    if (!confirm("Delete this site? Sessions will remain but won't be linked.")) return;
    const res = await fetch(`${API}/api/sites/${id}`, { method: "DELETE" });
    if (!checkAuth(res)) return;
    loadSites();
  };

  // ── Keyboard shortcuts ──────────────────────────────────────────
  document.addEventListener("keydown", (e) => {
    if (viewReplay.classList.contains("hidden")) return;
    if (e.key === "Escape" && viewReplay.classList.contains("fullscreen")) {
      toggleFullscreen();
    }
    if (e.key === " " && e.target.tagName !== "INPUT" && e.target.tagName !== "SELECT") {
      e.preventDefault();
      isPlaying ? pause() : play();
    }
  });

  // ── Init ─────────────────────────────────────────────────────────
  loadSessions();
  // Populate site filter dropdown on load
  fetch(`${API}/api/sites`).then(r => r.json()).then(d => populateSiteFilter(d.sites || [])).catch(() => {});
})();
