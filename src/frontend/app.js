// ─── Auth token from URL hash (#token=) or legacy query param (?token=) ─
const hashToken =
  (location.hash.match(/token=([^&]+)/) || [])[1] || new URLSearchParams(location.search).get("token") || "";
function authFetch(url, opts) {
  if (!hashToken) return fetch(url, opts);
  const nextOpts = Object.assign({}, opts || {});
  nextOpts.headers = Object.assign({}, nextOpts.headers || {}, {
    Authorization: `Bearer ${decodeURIComponent(hashToken)}`,
  });
  return fetch(url, nextOpts);
}

// ─── State ──────────────────────────────────────────────────────
let currentTab = "sessions";
let currentSubTab = "sessions"; // 'sessions' (non-cron) or 'cron'
let currentPage = 1;
let expandedSessionKey = null;
let expandedSessionId = null;
let selectedRunId = null; // null = latest run
let showAllRuns = false;

// ─── Tab switching ──────────────────────────────────────────────
document.querySelectorAll("button.tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("button.tab").forEach((b) => {
      b.classList.remove("active");
    });
    document.querySelectorAll(".tab-content").forEach((c) => {
      c.classList.remove("active");
      c.classList.add("hidden");
    });
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    document.getElementById(`tab-${tab}`)?.classList.remove("hidden");
    document.getElementById(`tab-${tab}`)?.classList.add("active");
    currentTab = tab;
    refresh();
  });
});

// ─── Sub-tab switching ──────────────────────────────────────────
document.querySelectorAll(".sub-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".sub-tab").forEach((b) => {
      b.classList.remove("active");
    });
    btn.classList.add("active");
    currentSubTab = btn.dataset.subtab;
    currentPage = 1;
    activeParentIdFilter = null;
    refresh();
  });
});

// ─── Copy to clipboard (with fallback for non-HTTPS) ────────────
window.copyText = (text, btn) => {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        btn.textContent = "done";
        setTimeout(() => (btn.textContent = "copy"), 1200);
      })
      .catch(() => fallbackCopy(text, btn));
  } else {
    fallbackCopy(text, btn);
  }
};
function fallbackCopy(text, btn) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
    btn.textContent = "done";
    setTimeout(() => (btn.textContent = "copy"), 1200);
  } catch {
    btn.textContent = "fail";
    setTimeout(() => (btn.textContent = "copy"), 1200);
  }
  document.body.removeChild(ta);
}

// ─── Helpers ────────────────────────────────────────────────────
const esc = (s) => {
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
};
const fmtMs = (ms) => (ms == null ? "-" : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
const fmtDur = (ms) => (ms == null ? "-" : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60000).toFixed(1)}m`);
const fmtTok = (n) => (n == null ? "-" : n > 1000 ? `${Math.round(n / 1000)}K` : String(n));
const fmtAge = (ms) =>
  ms == null ? "-" : ms < 60000 ? "<1m" : ms < 3600000 ? `${Math.round(ms / 60000)}m` : `${(ms / 3600000).toFixed(1)}h`;
const fmtPct = (n) => (n == null ? "-" : `${(n * 100).toFixed(1)}%`);

function badge(text, type) {
  return `<span class="badge badge-${type || text || "default"}">${esc(text || "unknown")}</span>`;
}

function activityBars(bars) {
  if (!bars?.length) return "";
  const cls = ["act-idle", "act-busy", "act-stuck", "act-error"];
  return (
    '<span class="act-bars">' +
    bars.map((v) => `<span class="act-bar ${cls[v] || cls[0]}"></span>`).join("") +
    "</span>"
  );
}

/**
 * Build a compact, human-readable label for a parent session.
 * Priority: label > diag > parsed-from-key > truncated key.
 */
function parentDisplayName(s) {
  // Use label if the parent has one
  if (s.parentLabel) {
    const l = s.parentLabel;
    return l.length > 20 ? `${l.slice(0, 18)}..` : l;
  }
  // Use diag (already short: "group:chat-1", "user:local-1", "cron:188f")
  if (s.parentDiag) return s.parentDiag;
  // Fallback: parse the key
  if (!s.parentSessionKey) return "";
  const p = s.parentSessionKey.split(":");
  // "agent:main:channel:group:oc_xxx" -> "channel:group"
  if (p.length >= 4) return `${p[2]}:${p[3]}`;
  return p.slice(-2).join(":");
}

function renderParentChild(s, showChildren) {
  const parts = [];
  if (s.parentSessionId) {
    const name = parentDisplayName(s);
    // Only show agent prefix if parent is a different agent than child
    const agentPrefix = s.parentAgentId && s.parentAgentId !== s.agentId ? `${esc(s.parentAgentId)}/` : "";
    parts.push(
      `<span class="parent-badge" title="parent session: ${esc(s.parentSessionId)}" ` +
        `onclick="event.stopPropagation();filterToSession('${esc(s.parentSessionId)}')">` +
        `^ ${agentPrefix}${esc(name)}</span>`,
    );
  } else if (s.parentSessionKey) {
    // Fallback: parent_session_id not resolved yet, show key-level link
    const name = parentDisplayName(s);
    parts.push(
      `<span class="parent-badge" title="${esc(s.parentSessionKey)}" ` +
        `onclick="event.stopPropagation();filterToSession('${esc(s.parentSessionKey)}')">` +
        `^ ${esc(name)}</span>`,
    );
  }
  if (showChildren) {
    parts.push(
      `<span class="child-badge" ` +
        `onclick="event.stopPropagation();filterChildren('${esc(s.sessionId)}')">` +
        `${s.childCount} sub</span>`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : "-";
}

/** Active parent filter — set when user clicks "N sub" badge. */
let activeParentIdFilter = null;

/** Filter session list to show a specific session (e.g. jump to parent by session_id). */
window.filterToSession = (sessionId) => {
  clearParentFilter();
  const qInput = document.getElementById("filter-q");
  if (qInput) {
    qInput.value = sessionId.slice(0, 8);
    currentPage = 1;
    refresh();
  }
};
/** Filter session list to show children of a parent session (by session_id). */
window.filterChildren = (parentSessionId) => {
  activeParentIdFilter = parentSessionId;
  const channelSel = document.getElementById("filter-channel");
  const stateSel = document.getElementById("filter-state");
  const qInput = document.getElementById("filter-q");
  if (channelSel) channelSel.value = "";
  if (stateSel) stateSel.value = "";
  if (qInput) qInput.value = "";
  currentPage = 1;
  refresh();
};
function clearParentFilter() {
  activeParentIdFilter = null;
}

// ─── Summary Cards ──────────────────────────────────────────────
async function refreshSummary() {
  const res = await authFetch("/api/summary");
  const d = await res.json();
  const el = document.getElementById("summary-cards");
  el.innerHTML = [
    card("Runs", d.runs, "blue"),
    card("Success", d.success, "green"),
    card("Failed", d.failed, d.failed > 0 ? "red" : ""),
    card("Running", d.running, d.running > 0 ? "blue" : ""),
    card("Avg Duration", fmtDur(d.avgDurationMs)),
    card("P95 Duration", fmtDur(d.p95DurationMs)),
    card("Tools", d.tools),
    card("Tool Errors", d.toolErrors, d.toolErrors > 0 ? "red" : ""),
    card("Subagents", d.subagents),
    card("Stalled", d.stalled, d.stalled > 0 ? "yellow" : ""),
    card("Timeouts", d.timeouts, d.timeouts > 0 ? "red" : ""),
  ].join("");
  document.getElementById("header-time").textContent = `Updated: ${new Date().toLocaleString()} · Scope: all agents`;
}

function card(label, value, color) {
  return `<div class="card"><div class="card-label">${label}</div><div class="card-value${color ? ` ${color}` : ""}">${value}</div></div>`;
}

// ─── Sessions Tab ───────────────────────────────────────────────
window.setPage = (p) => {
  currentPage = p;
  refresh();
};

async function refreshSessions() {
  const params = new URLSearchParams();
  params.set("tab", currentSubTab);
  params.set("page", String(currentPage));
  const ch = document.getElementById("filter-channel")?.value;
  const ag = document.getElementById("filter-agent")?.value;
  const st = document.getElementById("filter-state")?.value;
  const diag = document.getElementById("filter-diag")?.value;
  const label = document.getElementById("filter-label")?.value;
  const q = document.getElementById("filter-q")?.value;
  if (ch) params.set("channel", ch);
  if (ag) params.set("agent", ag);
  if (st) params.set("state", st);
  if (diag) params.set("diag", diag);
  if (label) params.set("label", label);
  if (q) params.set("q", q);
  if (activeParentIdFilter) params.set("parentId", activeParentIdFilter);

  const res = await authFetch(`/api/sessions?${params}`);
  const data = await res.json();
  const tbody = document.querySelector("#sessions-table tbody");

  // Populate filter dropdowns (once)
  const channelSel = document.getElementById("filter-channel");
  if (channelSel?.options.length <= 1) {
    [...new Set(data.sessions.map((s) => s.channel).filter(Boolean))].sort().forEach((c) => {
      channelSel.add(new Option(c, c));
    });
  }
  const agentSel = document.getElementById("filter-agent");
  if (agentSel?.options.length <= 1) {
    [...new Set(data.sessions.map((s) => s.agentId).filter(Boolean))].sort().forEach((a) => {
      agentSel.add(new Option(a, a));
    });
  }

  // Parent-filter banner
  const bannerEl = document.getElementById("parent-filter-banner");
  if (bannerEl) {
    if (activeParentIdFilter) {
      const short = activeParentIdFilter.length > 50 ? `...${activeParentIdFilter.slice(-40)}` : activeParentIdFilter;
      bannerEl.innerHTML = `<span>Showing children of: <strong>${esc(short)}</strong></span> <button onclick="clearParentFilter();refresh();">clear</button>`;
      bannerEl.classList.remove("hidden");
    } else {
      bannerEl.classList.add("hidden");
    }
  }

  // Track which session_keys we've already shown child count for (de-dup across same-key rows)
  const shownChildCountFor = new Set();
  tbody.innerHTML = data.sessions
    .map((s) => {
      const showChildren = s.childCount > 0 && !shownChildCountFor.has(s.sessionKey);
      if (s.childCount > 0) shownChildCountFor.add(s.sessionKey);
      const keyShort = s.sessionKey.length > 45 ? `...${s.sessionKey.slice(-40)}` : s.sessionKey;
      const modelShort = s.model ? s.model.replace(/^gpt-/, "").split("-").slice(0, 2).join("-") : "";
      const _lr = s.latestRun;
      const blockerText = s.blocker || "-";
      const blockDur = s.lastBlockDurationMs ? fmtDur(s.lastBlockDurationMs) : "";
      return `<tr data-key="${esc(s.sessionKey)}" data-session-id="${esc(s.sessionId || "")}">
      <td><button class="expand-btn" onclick="toggleSession('${esc(s.sessionKey)}','${esc(s.sessionId || "")}')">&#9654;</button></td>
      <td>${esc(s.agentId)}</td>
      <td class="mono"><div class="key-cell" title="${esc(s.sessionKey)}"><span class="key-text">${esc(keyShort)}</span><button class="copy-btn" data-key="${esc(s.sessionKey)}" onclick="event.stopPropagation();copyText(this.dataset.key,this)">copy</button></div></td>
      <td class="mono text-sm" title="${esc(s.sessionId || "")}">${esc((s.sessionId || "").slice(0, 8))}</td>
      <td class="text-sm">${esc(s.diag || "-")}</td>
      <td>${esc(s.label || "-")}</td>
      <td>${badge(s.channel, channelBadgeKind(s.channel))}</td>
      <td class="text-sm">${renderParentChild(s, showChildren)}</td>
      <td>${esc(s.kind)}</td>
      <td>${badge(s.source || "auth-only", s.source === "transcript+auth" ? "active" : "default")}</td>
      <td>${badge(s.diagState || "idle", s.diagState || "idle")}</td>
      <td class="mono text-sm" title="${esc(s.currentOp || "")}">${esc(s.currentOp?.slice(0, 20) || "-")}</td>
      <td class="text-sm" title="${esc(blockerText)}">${esc(blockerText.slice(0, 15))} ${blockDur ? `<span class="text-muted">${blockDur}</span>` : ""}</td>
      <td>${fmtAge(s.ageMs)}</td>
      <td>${fmtTok(s.totalTokens)}/${fmtTok(s.contextTokens)}</td>
      <td class="text-sm">${fmtTok(s.inputTokens)}/${fmtTok(s.outputTokens)}</td>
      <td>${s.llmCallCount}</td>
      <td>${s.toolCallCount}</td>
      <td>${s.skillCallCount}</td>
      <td>${s.mcpCallCount}</td>
      <td class="text-sm">${esc(modelShort)}</td>
      <td>${badge(s.runtimeMode || "default", "default")}</td>
      <td>${activityBars(s.activityBars)}</td>
    </tr>`;
    })
    .join("");

  // Pagination
  const totalPages = data.totalPages || 1;
  const pag = document.getElementById("session-pagination");
  if (pag) {
    pag.innerHTML =
      totalPages > 1
        ? `
      <button onclick="setPage(${currentPage - 1})" ${currentPage <= 1 ? "disabled" : ""}>&laquo; Prev</button>
      <span class="page-info">Page ${currentPage} / ${totalPages} (${data.total} total)</span>
      <button onclick="setPage(${currentPage + 1})" ${currentPage >= totalPages ? "disabled" : ""}>Next &raquo;</button>
    `
        : `<span class="page-info">${data.total} sessions</span>`;
  }

  if (expandedSessionKey) refreshDetail(expandedSessionKey, expandedSessionId);
}

function channelBadgeKind(channel) {
  if (!channel) return "default";
  if (channel === "cron") return "waiting";
  if (channel.endsWith("-group") || channel.endsWith("-direct")) return "processing";
  return "default";
}

window.toggleSession = async (key, sessionId) => {
  const detail = document.getElementById("session-detail");
  sessionId = sessionId || null;
  if (expandedSessionKey === key && expandedSessionId === sessionId) {
    expandedSessionKey = null;
    expandedSessionId = null;
    selectedRunId = null;
    showAllRuns = false;
    detail.classList.add("hidden");
    return;
  }
  expandedSessionKey = key;
  expandedSessionId = sessionId;
  selectedRunId = null;
  showAllRuns = false;
  detail.classList.remove("hidden");
  await refreshDetail(key, sessionId);
};

window.selectRun = (runId) => {
  selectedRunId = runId || null;
  if (expandedSessionKey) refreshDetail(expandedSessionKey, expandedSessionId);
};

window.toggleRunSelector = () => {
  showAllRuns = !showAllRuns;
  if (expandedSessionKey) refreshDetail(expandedSessionKey, expandedSessionId);
};

// Stacked detail: Prompt Check + Workflow Graph + Workflow trace + Context length, refreshed together.
async function refreshDetail(key, sessionId) {
  const detail = document.getElementById("session-detail");
  const params = new URLSearchParams();
  if (selectedRunId) params.set("runId", selectedRunId);
  if (sessionId) params.set("sessionId", sessionId);
  const query = params.toString();
  const [promptRes, workflowRes, traceRes, ctxRes] = await Promise.all([
    authFetch(`/api/sessions/${encodeURIComponent(key)}/prompt-check?${query}`).catch(() => null),
    authFetch(`/api/sessions/${encodeURIComponent(key)}/workflow?${query}`).catch(() => null),
    authFetch(`/api/sessions/${encodeURIComponent(key)}/trace?${query}`).catch(() => null),
    authFetch(`/api/sessions/${encodeURIComponent(key)}/context?${query}`).catch(() => null),
  ]);

  let promptData = null;
  if (promptRes?.ok) {
    try {
      promptData = await promptRes.json();
    } catch {
      /* swallow */
    }
  }
  let workflowData = null;
  if (workflowRes?.ok) {
    try {
      workflowData = await workflowRes.json();
    } catch {
      /* swallow */
    }
  }
  let traceData = null;
  if (traceRes?.ok) {
    try {
      traceData = await traceRes.json();
    } catch {
      /* swallow */
    }
  }
  let ctxData = null;
  if (ctxRes?.ok) {
    try {
      ctxData = await ctxRes.json();
    } catch {
      /* swallow */
    }
  }

  // Run selector comes from whichever endpoint actually returned runs.
  const runs =
    (promptData?.runs?.length
      ? promptData.runs
      : workflowData?.runs?.length
        ? workflowData.runs
        : traceData?.runs?.length
          ? traceData.runs
          : ctxData?.runs) || [];
  const activeRunId = promptData?.runId || workflowData?.runId || traceData?.runId || ctxData?.runId || null;

  let html = renderRunSelector(runs, activeRunId);
  html += '<div class="detail-section detail-section-prompt">';
  html += '<div class="detail-section-title">Prompt Check</div>';
  html += promptData
    ? renderPromptCheck(promptData)
    : '<div class="trace-header">No prompt check data for this run</div>';
  html += "</div>";
  html += '<div class="detail-section detail-section-workflow">';
  html += '<div class="detail-section-title">Workflow Graph</div>';
  html += workflowData
    ? renderWorkflowGraph(workflowData)
    : '<div class="trace-header">No workflow data for this run</div>';
  html += "</div>";
  html += '<div class="detail-section detail-section-trace">';
  html += '<div class="detail-section-title">Workflow trace</div>';
  html += traceData ? buildTraceHtml(traceData) : '<div class="trace-header">No trace data for this run</div>';
  html += "</div>";
  html += '<div class="detail-section detail-section-context">';
  html += '<div class="detail-section-title">Context length</div>';
  html +=
    ctxData?.breakdown && ctxData?.timeline
      ? renderContextView(ctxData.breakdown, ctxData.timeline)
      : '<div class="trace-header">No context data for this run</div>';
  html += "</div>";
  detail.innerHTML = html;
}

function renderRunSelector(runs, activeRunId) {
  if (!runs || runs.length <= 1) return "";
  const maxCompactRuns = 18;
  const visibleRuns = showAllRuns ? runs : runs.slice(0, maxCompactRuns);
  if (!showAllRuns && activeRunId && !visibleRuns.some((r) => r.runId === activeRunId)) {
    const active = runs.find((r) => r.runId === activeRunId);
    if (active) visibleRuns.push(active);
  }
  let html = '<div class="run-selector">';
  html += `<div class="run-selector-head"><span class="run-selector-label">Runs ${runs.length}${showAllRuns ? "" : ` · latest ${visibleRuns.length}`}</span>`;
  if (runs.length > maxCompactRuns) {
    html += `<button class="run-toggle" onclick="toggleRunSelector()">${showAllRuns ? "compact" : "all"}</button>`;
  }
  html += "</div>";
  html += '<div class="run-list">';
  for (const r of visibleRuns) {
    const isActive = r.runId === activeRunId;
    const time = new Date(r.startedAt).toLocaleTimeString();
    const durStr = fmtDur(r.durationMs);
    const stepsStr = `${r.modelSteps}m+${r.toolSteps}t`;
    html += `<button class="run-item${isActive ? " run-active" : ""}" onclick="selectRun('${esc(r.runId)}')">${time} (${durStr}, ${stepsStr})${r.status === "running" ? " ●" : ""}</button>`;
  }
  html += "</div></div>";
  return html;
}

function renderPromptCheck(data) {
  const rules = data.rules || [];
  const hooks = data.hooks || [];
  const diagnostics = data.diagnostics || [];
  const warnings =
    diagnostics.filter((d) => d.severity === "warning" || d.severity === "error").length +
    rules.filter((r) => r.status && r.status !== "ok").length;
  let html = `<div class="prompt-check prompt-${esc(data.status || "ok")}">`;
  html += `<div class="prompt-check-head">
    <span class="prompt-status">${esc(data.status || "ok")}</span>
    <strong>Rules: ${rules.length}</strong>
    <span>Hooks: ${hooks.length}</span>
    <span>Warnings: ${warnings}</span>
  </div>`;

  const visibleRules = rules.filter((r) => r.status && r.status !== "ok");
  const okRules = rules.filter((r) => r.status === "ok").length;
  if (visibleRules.length) {
    html += '<div class="prompt-diagnostics">';
    for (const r of visibleRules) {
      const id = `prompt-rule-${r.ruleId.replace(/[^a-z0-9]/gi, "_")}`;
      html += `<button class="prompt-row prompt-${esc(r.status)}" onclick="toggleWorkflowDetail('${id}')">
        <span class="prompt-kind">${esc(r.severity || "warning")}</span>
        <span class="prompt-title">${esc(r.title || r.ruleId)}</span>
        <span class="prompt-message">${esc(r.message || "")}</span>
      </button>`;
      html += `<div id="${id}" class="workflow-detail prompt-detail hidden">
        <div class="detail-row"><span class="detail-label">rule_id:</span> <code>${esc(r.ruleId)}</code></div>
        ${(r.evidenceStepIds || []).map((s) => `<div class="detail-row"><span class="detail-label">step_id:</span> <code>${esc(s)}</code></div>`).join("")}
        ${(r.sourceFiles || []).map((s) => `<div class="detail-row"><span class="detail-label">source:</span> <code>${esc(s)}</code></div>`).join("")}
      </div>`;
    }
    html += "</div>";
  }

  if (diagnostics.length) {
    html += '<div class="prompt-diagnostics">';
    for (const d of diagnostics) {
      const id = `prompt-diag-${d.id.replace(/[^a-z0-9]/gi, "_")}`;
      html += `<button class="prompt-row prompt-${esc(d.severity)}" onclick="toggleWorkflowDetail('${id}')">
        <span class="prompt-kind">${esc(d.type)}</span>
        <span class="prompt-title">${esc(d.message)}</span>
      </button>`;
      html += `<div id="${id}" class="workflow-detail prompt-detail hidden">`;
      const prov = d.provenance || {};
      for (const [k, v] of Object.entries(prov)) {
        if (v == null || v === "") continue;
        html += `<div class="detail-row"><span class="detail-label">${esc(k)}:</span> <code>${esc(String(v))}</code></div>`;
      }
      html += "</div>";
    }
    html += "</div>";
  }

  if (hooks.length) {
    html += '<div class="prompt-hooks">';
    for (const h of hooks.slice(0, 6)) {
      html += `<span class="prompt-hook prompt-${esc(h.status)}" title="${esc(h.message || "")}">${esc(h.hookId)} · ${esc(h.event)}</span>`;
    }
    html += "</div>";
  }
  if (!visibleRules.length && !diagnostics.length) {
    html += `<div class="prompt-ok">${okRules} rules passed${hooks.length ? ` · ${hooks.length} hook events bound` : ""}</div>`;
  }
  html += "</div>";
  return html;
}

function renderWorkflowGraph(data) {
  const lanes = data.lanes || [];
  const events = data.events || [];
  const edges = data.edges || [];
  const diagnostics = data.diagnostics || [];
  const validation = data.validation || null;
  const attention = data.attention || null;
  const validationStatus = validation?.status || "unknown";
  const validationChecks = validation?.checks || [];
  const validationBad = validationChecks.filter((c) => c.status && c.status !== "ok");
  if (!events.length) {
    let emptyHtml = `<div class="trace-header">
      No workflow events for this run &middot;
      <strong>Data:</strong> <span class="workflow-validation wf-${esc(validationStatus)}">${esc(validationStatus)}${validationBad.length ? ` ${validationBad.length}` : ""}</span>
    </div>`;
    if (attention) emptyHtml += renderWorkflowAttention(attention);
    if (validationBad.length) {
      emptyHtml += '<div class="workflow-diagnostics">';
      for (const c of validationBad) {
        emptyHtml += `<div class="workflow-diagnostic wf-${esc(c.status)}">validation ${esc(c.id)}: ${esc(c.message)}</div>`;
      }
      emptyHtml += "</div>";
    }
    return emptyHtml;
  }

  const laneIndex = new Map(lanes.map((lane, i) => [lane.id, i]));
  let html = `<div class="workflow-view" style="--wf-lanes:${Math.max(1, lanes.length)}">`;
  html += `<div class="trace-header">
    <strong>Run:</strong> ${esc((data.runId || "").slice(0, 8) || "latest")} &middot;
    <strong>Events:</strong> ${events.length} &middot;
    <strong>Edges:</strong> ${edges.length} &middot;
    <strong>Data:</strong> <span class="workflow-validation wf-${esc(validationStatus)}">${esc(validationStatus)}${validationBad.length ? ` ${validationBad.length}` : ""}</span>
  </div>`;
  if (attention) html += renderWorkflowAttention(attention);
  if (validationBad.length) {
    html += '<div class="workflow-diagnostics">';
    for (const c of validationBad) {
      html += `<div class="workflow-diagnostic wf-${esc(c.status)}">validation ${esc(c.id)}: ${esc(c.message)}</div>`;
    }
    html += "</div>";
  }
  if (diagnostics.length) {
    html += '<div class="workflow-diagnostics">';
    for (const d of diagnostics) {
      html += `<div class="workflow-diagnostic wf-${esc(d.severity)}">${esc(d.type)}: ${esc(d.message)}</div>`;
    }
    html += "</div>";
  }

  html += '<div class="workflow-sequence">';
  html += '<div class="sequence-head">';
  html += '<div class="sequence-time-head"></div>';
  html += '<div class="sequence-lane-area sequence-participants">';
  for (const lane of lanes) {
    html += `<div class="sequence-participant sequence-${esc(lane.kind)}">${esc(lane.title)}</div>`;
  }
  html += "</div></div>";

  for (const e of events) {
    const msg = workflowMessageForEvent(e, laneIndex);
    const detailId = `wf-detail-${e.id.replace(/[^a-z0-9]/gi, "_")}`;
    html += '<div class="sequence-row">';
    html += `<div class="sequence-time">${e.ts ? esc(new Date(e.ts).toLocaleTimeString()) : "-"}</div>`;
    html += '<div class="sequence-lane-area">';
    for (const lane of lanes) html += `<div class="sequence-cell" data-lane="${esc(lane.id)}"></div>`;
    if (msg) {
      const fromIdx = laneIndex.get(msg.from);
      const toIdx = laneIndex.get(msg.to);
      if (fromIdx != null && toIdx != null) {
        const fromCenter = laneCenterPct(fromIdx, lanes.length);
        const toCenter = laneCenterPct(toIdx, lanes.length);
        const left = Math.min(fromCenter, toCenter);
        const width = Math.max(0.01, Math.abs(toCenter - fromCenter));
        const dir = fromIdx === toIdx ? "self" : fromIdx < toIdx ? "forward" : "reverse";
        const posStyle =
          dir === "self"
            ? `left:calc(${fromCenter.toFixed(4)}% - 58px);width:116px;`
            : `left:${left.toFixed(4)}%;width:${width.toFixed(4)}%;`;
        const attnHit =
          attention && (attention.eventId === e.id || (attention.stepId && e.provenance?.step_id === attention.stepId));
        html += `<button class="sequence-message wf-type-${esc(e.type)} sequence-${dir}${e.status === "warning" ? " wf-event-warning" : ""}${attnHit ? " wf-attention-hit" : ""}" style="${posStyle}" onclick="toggleWorkflowDetail('${detailId}')">
          <span class="sequence-line"></span>
          <span class="sequence-label">
            <span class="sequence-title">${esc(msg.label)}</span>
            ${msg.subtitle ? `<span class="sequence-subtitle">${esc(msg.subtitle)}</span>` : ""}
            <span class="sequence-meta">${esc(workflowEventMeta(e))}</span>
          </span>
        </button>`;
      }
    }
    html += "</div></div>";
    html += `<div id="${detailId}" class="workflow-detail sequence-detail hidden">`;
    const prov = e.provenance || {};
    for (const [k, v] of Object.entries(prov)) {
      if (v == null || v === "") continue;
      html += `<div class="detail-row"><span class="detail-label">${esc(k)}:</span> <code>${esc(String(v))}</code></div>`;
    }
    html += "</div>";
  }

  html += "</div></div>";
  return html;
}

function renderWorkflowAttention(attention) {
  const status = attention.status || "ok";
  const age = attention.ageMs != null ? fmtDur(Number(attention.ageMs)) : "";
  let html = `<div class="workflow-attention wf-${esc(status)}">
    <div class="workflow-attention-main">
      <span class="workflow-attention-status">${esc(status)}</span>
      <strong>${esc(attention.title || "Workflow attention")}</strong>
      ${age ? `<span class="workflow-attention-age">${esc(age)}</span>` : ""}
    </div>`;
  if (attention.subtitle) html += `<div class="workflow-attention-sub">${esc(attention.subtitle)}</div>`;
  const chips = [];
  if (attention.runId) chips.push(`run ${String(attention.runId).slice(0, 8)}`);
  if (attention.stepId) chips.push(`step ${String(attention.stepId).slice(0, 10)}`);
  if (attention.childSessionKey) chips.push(`child ${shortText(attention.childSessionKey, 28)}`);
  if (attention.childSessionId) chips.push(`sid ${String(attention.childSessionId).slice(0, 8)}`);
  if (chips.length)
    html += `<div class="workflow-attention-chips">${chips.map((c) => `<code>${esc(c)}</code>`).join("")}</div>`;
  html += "</div>";
  return html;
}

function shortText(text, max) {
  text = String(text || "");
  return text.length > max ? `...${text.slice(-(max - 3))}` : text;
}

function laneCenterPct(index, laneCount) {
  return ((index + 0.5) / Math.max(1, laneCount)) * 100;
}

function workflowMessageForEvent(e, laneIndex) {
  const childLane = e.laneId?.startsWith("child:") ? e.laneId : null;
  const childName = childLane ? "child" : "";
  switch (e.type) {
    case "user_message":
      return { from: "user", to: "parent", label: e.title || "user message", subtitle: e.subtitle };
    case "skill_or_source_step":
    case "checkpoint_write":
      return { from: "parent", to: "parent", label: e.title || e.type, subtitle: e.subtitle };
    case "sessions_spawn_requested":
      return { from: "parent", to: "runtime", label: e.title || "sessions_spawn", subtitle: e.subtitle };
    case "sessions_spawn_accepted":
      return { from: "runtime", to: "parent", label: "accepted childSessionKey + runId", subtitle: e.subtitle };
    case "sessions_yield":
      return { from: "parent", to: "runtime", label: "sessions_yield", subtitle: e.subtitle };
    case "child_started":
      return { from: "runtime", to: childLane || e.laneId, label: "create child session", subtitle: e.subtitle };
    case "child_artifact_written":
      return {
        from: childLane || e.laneId,
        to: childLane || e.laneId,
        label: e.title || "write artifact",
        subtitle: e.subtitle,
      };
    case "child_final":
      return { from: childLane || e.laneId, to: "runtime", label: `${childName} final answer`, subtitle: e.subtitle };
    case "parent_resumed":
      return { from: "runtime", to: "parent", label: "auto-resume parent", subtitle: e.subtitle };
    case "workflow_state_snapshot":
      return { from: "workflow_state", to: "workflow_state", label: "workflow snapshot", subtitle: e.subtitle };
    case "workflow_state_child_bound":
      return { from: "runtime", to: "workflow_state", label: "workflow child bound", subtitle: e.subtitle };
    case "workflow_state_gap":
      return { from: "runtime", to: "workflow_state", label: e.title || "workflow gap", subtitle: e.subtitle };
    default:
      if (laneIndex.has(e.laneId))
        return { from: e.laneId, to: e.laneId, label: e.title || e.type, subtitle: e.subtitle };
      return null;
  }
}

function workflowEventMeta(e) {
  const p = e.provenance || {};
  const parts = [];
  if (p.duration_ms != null) parts.push(fmtMs(Number(p.duration_ms)));
  const ctx = Number(p.input_tokens || 0) + Number(p.cache_read_tokens || 0);
  if (ctx > 0) parts.push(`ctx ${fmtTok(ctx)}`);
  if (p.input_tokens != null) parts.push(`in ${fmtTok(Number(p.input_tokens))}`);
  if (p.cache_read_tokens != null) parts.push(`cache ${fmtTok(Number(p.cache_read_tokens))}`);
  if (p.output_tokens != null) parts.push(`out ${fmtTok(Number(p.output_tokens))}`);
  if (p.total_tokens != null) parts.push(`total ${fmtTok(Number(p.total_tokens))}`);
  return parts.length ? parts.join(" · ") : e.type;
}

window.toggleWorkflowDetail = (id) => {
  const el = document.getElementById(id);
  if (el) el.classList.toggle("hidden");
};

function buildTraceHtml(data) {
  const spans = data.spans || [];
  if (!spans.length) return '<div class="trace-header">No trace data for this run</div>';

  const totalMs = data.traceDurationMs || 1;
  let html = `<div class="trace-header">
    <strong>Run:</strong> ${esc(data.runId?.slice(0, 8))} &middot;
    <strong>Started:</strong> ${new Date(data.startedAt).toLocaleString()} &middot;
    <strong>Duration:</strong> ${fmtDur(data.traceDurationMs)} &middot;
    <strong>Steps:</strong> ${spans.length}
  </div><div class="trace-container">`;

  for (const span of spans) {
    const depth = getDepth(span, spans);
    const pad = depth * 22;
    let barL = totalMs > 0 ? (span.startOffsetMs / totalMs) * 100 : 0;
    let barW = totalMs > 0 ? (Math.max(span.durationMs || 1, totalMs * 0.005) / totalMs) * 100 : 1;
    // Clamp to prevent overflow beyond the Gantt area
    barL = Math.min(barL, 99);
    barW = Math.min(barW, 100 - barL);
    const barCls = `bar-${span.type}${span.status === "error" ? " bar-error" : ""}${span.isStuck ? " bar-stuck" : ""}`;

    const hasDetail = span.inputPreview || span.resultPreview || span.errorText;
    const detailId = `detail-${span.id.replace(/[^a-z0-9]/gi, "_")}`;
    html += `<div class="trace-row${hasDetail ? " clickable" : ""}" style="padding-left:${pad}px"${hasDetail ? ` onclick="toggleDetail('${detailId}')"` : ""}>
      <div class="trace-label">
        <span class="trace-type type-${span.type}">${esc(span.type.replace("_", " "))}</span>
        ${esc(span.label || "")}
        <span class="trace-dur">${fmtMs(span.durationMs)}</span>
        ${span.status === "error" ? '<span class="trace-err">ERR</span>' : ""}
        ${span.tokens ? `<span class="trace-dur">${fmtTok(span.tokens)} tok</span>` : ""}
      </div>
      <div class="trace-gantt">
        <div class="trace-bar ${barCls}" style="left:${barL.toFixed(1)}%;width:${Math.max(barW, 0.5).toFixed(1)}%"></div>
      </div>
    </div>`;
    if (hasDetail) {
      html += `<div id="${detailId}" class="trace-detail hidden" style="padding-left:${pad + 22}px">`;
      if (span.inputPreview)
        html += `<div class="detail-row"><span class="detail-label">Input:</span> <code>${esc(span.inputPreview)}</code></div>`;
      if (span.resultPreview)
        html += `<div class="detail-row"><span class="detail-label">Result:</span> <code>${esc(span.resultPreview)}</code></div>`;
      if (span.errorText)
        html += `<div class="detail-row detail-error"><span class="detail-label">Error:</span> <code>${esc(span.errorText)}</code></div>`;
      html += `</div>`;
    }
  }
  html += `</div>`; // close trace-container
  return html;
}

window.toggleDetail = (id) => {
  const el = document.getElementById(id);
  if (el) el.classList.toggle("hidden");
};

function getDepth(span, spans) {
  let d = 0,
    cur = span;
  while (cur.parentId) {
    const p = spans.find((s) => s.id === cur.parentId);
    if (!p) break;
    d++;
    cur = p;
  }
  return d;
}

// ─── Round 6 — Context Length view ──────────────────────────────

function renderContextView(breakdown, timeline) {
  const peakInput = timeline.cumulative.peakInputTokens || 1;
  const totalLatest = breakdown.totalLatest || peakInput;
  const buckets = breakdown.buckets;

  // Coarse 5-bucket bars (% of totalLatest, clamped 0-100)
  const bucketRows = [
    { name: "Framework baseline", value: buckets.frameworkBaseline, cls: "bucket-baseline" },
    { name: "Assistant outputs", value: buckets.assistantOutputsCumulative, cls: "bucket-output" },
    { name: "Tool result inflow", value: buckets.toolResultsCumulative, cls: "bucket-tool" },
    { name: "MCP context inflow", value: buckets.mcpDeltasCumulative, cls: "bucket-mcp" },
    { name: "Unaccounted", value: buckets.unaccountedCumulative, cls: "bucket-unacc" },
  ];

  let html = '<div class="context-view">';

  // Header — current context
  html += `<div class="context-header">
    <div class="context-header-title">
      <strong>Context:</strong> ${fmtTok(totalLatest)} of latest assistant input
      ${timeline.loopFlags.healthVerdict !== "healthy" ? `<span class="context-loop-warn">⚠ ${timeline.loopFlags.healthVerdict}</span>` : ""}
    </div>
    <div class="context-header-meta">
      Run ${esc(breakdown.runId.slice(0, 8))} ·
      ${timeline.cumulative.totalTurns} turns ·
      peak ${fmtTok(peakInput)} ·
      cache hit ${timeline.cumulative.cacheHitRate != null ? `${(timeline.cumulative.cacheHitRate * 100).toFixed(0)}%` : "—"}
    </div>
  </div>`;

  // Coarse bucket bars
  html += '<div class="context-bucket-grid">';
  for (const b of bucketRows) {
    const pct = totalLatest > 0 ? Math.max(0, Math.min(100, (Math.abs(b.value) / totalLatest) * 100)) : 0;
    const pctStr = totalLatest > 0 ? ((b.value / totalLatest) * 100).toFixed(1) : "0.0";
    html += `<div class="context-bucket-row">
      <div class="context-bucket-label">${b.name}</div>
      <div class="context-bucket-value">${fmtTok(b.value)}</div>
      <div class="context-bucket-bar"><div class="context-bucket-fill ${b.cls}" style="width:${pct.toFixed(1)}%"></div></div>
      <div class="context-bucket-pct">${pctStr}%</div>
    </div>`;
  }
  html += "</div>";

  // Insight banner (server-computed)
  if (timeline.insightBanner) {
    html += `<div class="context-insight">⚠ ${esc(timeline.insightBanner)}</div>`;
  }

  // Per-turn timeline table (postmortem-style)
  html += `<div class="context-section-title">Per-turn timeline</div>`;
  html += '<div class="context-turn-table-wrap"><table class="context-turn-table">';
  html +=
    "<thead><tr><th>Turn</th><th>Tool</th><th>Δctx</th><th>in</th><th>cR</th><th>out</th><th>prevTR</th><th>think</th><th>note</th></tr></thead><tbody>";
  for (const t of timeline.turns) {
    const deltaCls = t.deltaIn == null ? "" : t.deltaIn > 5000 ? "delta-spike" : t.deltaIn < 0 ? "delta-neg" : "";
    const deltaStr = t.deltaIn == null ? "—" : (t.deltaIn >= 0 ? "+" : "") + t.deltaIn.toLocaleString();
    const toolStr = t.primaryTool || (t.replyTextChars > 0 ? "(reply)" : "(think)");
    const note = t.deltaIn == null ? "baseline" : t.deltaIn > 5000 ? "⚡ spike" : "";
    html += `<tr>
      <td>${t.seq}</td>
      <td class="mono">${esc(toolStr)}</td>
      <td class="mono ${deltaCls}">${deltaStr}</td>
      <td class="mono">${t.inputTokens.toLocaleString()}</td>
      <td class="mono">${t.cacheReadTokens.toLocaleString()}</td>
      <td class="mono">${t.outputTokens.toLocaleString()}</td>
      <td class="mono">${t.prevToolResultChars > 0 ? t.prevToolResultChars.toLocaleString() : "—"}</td>
      <td class="mono">${t.thinkingChars > 0 ? t.thinkingChars.toLocaleString() : "—"}</td>
      <td>${esc(note)}</td>
    </tr>`;
  }
  html += "</tbody></table></div>";

  // Phase strip
  if (timeline.phases.length > 0) {
    html += `<div class="context-section-title">Phases</div><div class="context-phase-strip">`;
    const totalSeqs = Math.max(1, timeline.turns.length);
    for (const p of timeline.phases) {
      const startIdx = timeline.turns.findIndex((t) => t.seq === p.startSeq);
      const endIdx = timeline.turns.findIndex((t) => t.seq === p.endSeq);
      const span = endIdx - startIdx + 1 || 1;
      const widthPct = ((span / totalSeqs) * 100).toFixed(1);
      html += `<div class="context-phase phase-${p.name}" style="width:${widthPct}%" title="${esc(p.note)}">
        <span class="context-phase-name">${p.name}</span>
      </div>`;
    }
    html += "</div>";
  }

  // Top spikes
  if (timeline.topSpikes.length > 0) {
    html += `<div class="context-section-title">Top single-point spikes</div><div class="context-spikes">`;
    for (let i = 0; i < timeline.topSpikes.length; i++) {
      const s = timeline.topSpikes[i];
      html += `<div class="context-spike-row">
        <span class="context-spike-rank">#${i + 1}</span>
        <span class="mono">+${s.deltaIn.toLocaleString()}</span>
        <span>turn ${s.seq}</span>
        <span>${esc(s.triggerSummary)}</span>
      </div>`;
    }
    html += "</div>";
  }

  // Cumulative aggregates
  const cum = timeline.cumulative;
  html += `<div class="context-section-title">Cumulative</div>
    <div class="context-cumulative-grid">
      <div><span>output tokens</span><b>${cum.totalOutputTokens.toLocaleString()}</b></div>
      <div><span>tool_result chars</span><b>${cum.totalToolResultChars.toLocaleString()}</b></div>
      <div><span>thinking chars</span><b>${cum.totalThinkingChars.toLocaleString()}</b></div>
      <div><span>toolCall args chars</span><b>${cum.totalToolCallArgsChars.toLocaleString()}</b></div>
      <div><span>reply text chars</span><b>${cum.totalReplyTextChars.toLocaleString()}</b></div>
      <div><span>peak input</span><b>${cum.peakInputTokens.toLocaleString()}</b></div>
      <div><span>cache hit rate</span><b>${cum.cacheHitRate != null ? `${(cum.cacheHitRate * 100).toFixed(0)}%` : "—"}</b></div>
      <div><span>consec. no-write</span><b>${timeline.loopFlags.consecutiveNoWriteTurns}</b></div>
      <div><span>health verdict</span><b class="verdict-${timeline.loopFlags.healthVerdict}">${timeline.loopFlags.healthVerdict}</b></div>
    </div>`;

  // Repeated file reads (if any)
  if (timeline.loopFlags.repeatedFileReads.length > 0) {
    html += `<div class="context-section-title">Repeatedly read files</div><div class="context-repeated-reads">`;
    for (const r of timeline.loopFlags.repeatedFileReads.slice(0, 8)) {
      html += `<div class="context-repeated-row"><span class="mono">${r.readCount}×</span> <span class="mono">${esc(r.filePath)}</span></div>`;
    }
    html += "</div>";
  }

  html += "</div>"; // close .context-view
  return html;
}

// ─── Rankings renderer ──────────────────────────────────────────
function renderRankings(rankings, container) {
  if (!rankings) return;
  const colorMap = {
    topUsed: "rank-used",
    topErrors: "rank-errors",
    topStuck: "rank-stuck",
    topErrorTypes: "rank-errtype",
  };
  const titleMap = {
    topUsed: "Most Used",
    topErrors: "Most Errors",
    topStuck: "Most Stuck",
    topErrorTypes: "Error Types",
  };
  let html = "";
  for (const [key, items] of Object.entries(rankings)) {
    if (!Array.isArray(items) || !items.length) continue;
    const maxCount = items[0]?.count || 1;
    html += `<div class="ranking-card ${colorMap[key] || ""}"><h3>${titleMap[key] || key}</h3>`;
    for (const item of items.slice(0, 10)) {
      const pct = Math.max(10, (item.count / maxCount) * 100);
      html += `<div class="ranking-item">
        <span class="ranking-name">${esc(item.name || item.type || "?")}</span>
        <span class="ranking-count">${item.count}</span>
      </div><div class="ranking-bar" style="width:${pct}%"></div>`;
    }
    html += "</div>";
  }
  container.innerHTML = html;
}

// ─── Skills Tab ─────────────────────────────────────────────────
async function refreshSkills() {
  const range = document.getElementById("skills-range")?.value || "day";
  const q = document.getElementById("skills-q")?.value || "";
  const res = await authFetch(`/api/skills?range=${range}&q=${encodeURIComponent(q)}`);
  const data = await res.json();

  renderRankings(data.rankings, document.getElementById("skills-rankings"));

  document.querySelector("#skills-table tbody").innerHTML = data.skills
    .map((s) => {
      const shortPath = s.path ? `~/${s.path.split("/").slice(-2).join("/")}` : "-";
      return `<tr>
    <td>${esc(s.name)}</td>
    <td class="mono text-sm" title="${esc(s.path || "")}">${esc(shortPath)}</td>
    <td>${badge(s.status, s.status)}</td>
    <td>${s.callCount}</td>
    <td>${s.avgDurationMs != null ? Math.round(s.avgDurationMs) : "-"}</td>
    <td>${s.p95DurationMs ?? "-"}</td>
    <td>${fmtTok(s.totalTokens)}</td>
    <td>${s.errorCount}</td>
    <td>${s.stuckCount}</td>
  </tr>`;
    })
    .join("");
}

// ─── Scripts Tab ────────────────────────────────────────────────
async function refreshScripts() {
  const range = document.getElementById("scripts-range")?.value || "day";
  const q = document.getElementById("scripts-q")?.value || "";
  const res = await authFetch(`/api/scripts?range=${range}&q=${encodeURIComponent(q)}`);
  const data = await res.json();

  renderRankings(data.rankings, document.getElementById("scripts-rankings"));

  document.querySelector("#scripts-table tbody").innerHTML = data.scripts
    .map((s) => {
      const shortPath = s.path ? `~/${s.path.split("/").slice(-3).join("/")}` : "-";
      return `<tr>
    <td>${esc(s.name)}</td>
    <td class="mono text-sm" title="${esc(s.path || "")}">${esc(shortPath)}</td>
    <td>${s.callCount}</td>
    <td>${s.avgDurationMs != null ? Math.round(s.avgDurationMs) : "-"}</td>
    <td>${s.p95DurationMs ?? "-"}</td>
    <td>${s.errorCount}</td>
    <td>${s.stuckCount}</td>
  </tr>`;
    })
    .join("");
}

// ─── MCPs Tab ───────────────────────────────────────────────────
async function refreshMcps() {
  const range = document.getElementById("mcps-range")?.value || "day";
  const q = document.getElementById("mcps-q")?.value || "";
  const res = await authFetch(`/api/mcps?range=${range}&q=${encodeURIComponent(q)}`);
  const data = await res.json();

  renderRankings(data.rankings, document.getElementById("mcps-rankings"));

  document.querySelector("#mcps-table tbody").innerHTML = data.mcps
    .map(
      (s) => `<tr>
    <td>${esc(s.name)}</td>
    <td>${esc(s.server)}</td>
    <td>${s.callCount}</td>
    <td>${fmtMs(s.avgDurationMs)}</td>
    <td>${fmtMs(s.p95DurationMs)}</td>
    <td>${fmtPct(s.errorRate)}</td>
    <td>${s.errorCount}</td>
    <td>${s.stuckCount}</td>
    <td>${s.avgResultBytes ?? "-"}</td>
    <td>${s.avgContextTokenDelta ?? "-"}</td>
  </tr>`,
    )
    .join("");
}

// ─── Refresh dispatch ───────────────────────────────────────────
async function refreshHealth() {
  try {
    const res = await authFetch("/healthz");
    const d = await res.json();
    const ind = document.getElementById("refresh-indicator");
    if (!ind) return;
    // Pure mapping lives in health-indicator.js so the same function can be
    // unit-tested from Node (see tests/auth-stale.test.ts).
    const out = window.computeRefreshIndicator
      ? window.computeRefreshIndicator(d)
      : { text: "● auto-refresh 5s", className: "" };
    ind.textContent = out.text;
    ind.className = out.className;
  } catch {
    /* swallow */
  }
}

async function refresh() {
  try {
    await Promise.all([refreshSummary(), refreshHealth()]);
    if (currentTab === "sessions") await refreshSessions();
    else if (currentTab === "skills") await refreshSkills();
    else if (currentTab === "scripts") await refreshScripts();
    else if (currentTab === "mcps") await refreshMcps();
  } catch (err) {
    console.error("Refresh error:", err);
  }
}

// Filter handlers
for (const id of [
  "filter-channel",
  "filter-agent",
  "filter-state",
  "filter-diag",
  "filter-label",
  "filter-q",
  "skills-range",
  "skills-q",
  "scripts-range",
  "scripts-q",
  "mcps-range",
  "mcps-q",
]) {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener("change", refresh);
    el.addEventListener("input", debounce(refresh, 300));
  }
}
function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

// Boot
refresh();
setInterval(refresh, 5000);
