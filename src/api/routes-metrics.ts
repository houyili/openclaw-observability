/**
 * Prometheus `/metrics` endpoint — pure text exposition v0.0.4.
 *
 * Emits aggregate counters/gauges only:
 *   - obs_build_info{version}
 *   - obs_sessions_total{state}
 *   - obs_steps_total{status}
 *   - obs_steps_stuck_total
 *   - obs_registry_entries_total{type,status}
 *   - obs_auth_poll_last_success_seconds
 *   - obs_auth_poll_last_success_age_seconds
 *   - obs_auth_poll_failures_total
 *   - obs_auth_poll_inflight
 *
 * No session keys, no transcript content. The body is built from a
 * single SQL pass per metric block plus `getAuthPollStatus()`. Output
 * is deterministic so byte-equal calls produce byte-equal bodies on
 * the same DB state.
 */

import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { getAuthPollStatus } from "../ingest/auth-poller.ts";
import { getDb } from "../storage/db.ts";

function loadVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

const VERSION = loadVersion();

// Canonical state/status sets — emit zero rows for absent keys so that
// scraping always yields the same series shape.
const SESSION_STATES = ["processing", "waiting", "idle", "stuck", "unknown"] as const;
const STEP_STATUSES = ["ok", "error", "running"] as const;

/**
 * Escape a Prometheus label value per text exposition spec:
 * backslash, double-quote and newline only.
 */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * Format a counter value safely. NaN / Infinity / negative finite ages
 * are coerced to integers / sentinels so the body stays scrape-clean.
 */
function fmtInt(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return Math.round(n).toString();
}

export function buildMetricsBody(): string {
  const db = getDb();
  const out: string[] = [];

  // ── obs_build_info ───────────────────────────────────────────
  out.push("# HELP obs_build_info Build information for this OpenClaw Observability instance.");
  out.push("# TYPE obs_build_info gauge");
  out.push(`obs_build_info{version="${escapeLabel(VERSION)}"} 1`);
  out.push("");

  // ── obs_sessions_total ──────────────────────────────────────
  const sessRows = db
    .prepare("SELECT diag_state AS diag_state, COUNT(*) AS c FROM sessions GROUP BY diag_state")
    .all() as any[];
  const sessByState = new Map<string, number>();
  for (const row of sessRows) {
    const raw = row.diag_state;
    const key = raw == null || raw === "" ? "unknown" : String(raw);
    sessByState.set(key, (sessByState.get(key) ?? 0) + Number(row.c ?? 0));
  }
  out.push("# HELP obs_sessions_total Number of sessions tracked, broken down by diag_state.");
  out.push("# TYPE obs_sessions_total gauge");
  for (const state of SESSION_STATES) {
    out.push(`obs_sessions_total{state="${escapeLabel(state)}"} ${fmtInt(sessByState.get(state) ?? 0)}`);
  }
  out.push("");

  // ── obs_steps_total ─────────────────────────────────────────
  const stepRows = db.prepare("SELECT status, COUNT(*) AS c FROM steps GROUP BY status").all() as any[];
  const stepByStatus = new Map<string, number>();
  for (const row of stepRows) {
    if (!row.status) continue;
    stepByStatus.set(String(row.status), (stepByStatus.get(String(row.status)) ?? 0) + Number(row.c ?? 0));
  }
  out.push("# HELP obs_steps_total Number of transcript steps in the database, broken down by status.");
  out.push("# TYPE obs_steps_total gauge");
  for (const status of STEP_STATUSES) {
    out.push(`obs_steps_total{status="${escapeLabel(status)}"} ${fmtInt(stepByStatus.get(status) ?? 0)}`);
  }
  out.push("");

  // ── obs_steps_stuck_total ───────────────────────────────────
  const stuckRow = db.prepare("SELECT COUNT(*) AS c FROM steps WHERE is_stuck = 1").get() as any;
  out.push("# HELP obs_steps_stuck_total Number of transcript steps currently flagged as stuck.");
  out.push("# TYPE obs_steps_stuck_total gauge");
  out.push(`obs_steps_stuck_total ${fmtInt(Number(stuckRow?.c ?? 0))}`);
  out.push("");

  // ── obs_registry_entries_total ──────────────────────────────
  // Differs from sessions/steps: do NOT emit phantom zero rows for
  // (type,status) combinations the registry has never observed.
  const regRows = db
    .prepare("SELECT type, status, COUNT(*) AS c FROM registry GROUP BY type, status ORDER BY type, status")
    .all() as any[];
  out.push("# HELP obs_registry_entries_total Number of items in the registry, broken down by type and status.");
  out.push("# TYPE obs_registry_entries_total gauge");
  for (const row of regRows) {
    if (!row.type || !row.status) continue;
    out.push(
      `obs_registry_entries_total{type="${escapeLabel(String(row.type))}",status="${escapeLabel(String(row.status))}"} ${fmtInt(Number(row.c ?? 0))}`,
    );
  }
  out.push("");

  // ── auth-poll metrics ───────────────────────────────────────
  const poll = getAuthPollStatus();
  const lastSuccessSeconds = poll.lastSuccessAt != null ? Math.round(poll.lastSuccessAt / 1000) : -1;
  const lastSuccessAgeSeconds = poll.lastSuccessAt != null ? Math.round((Date.now() - poll.lastSuccessAt) / 1000) : -1;

  out.push(
    "# HELP obs_auth_poll_last_success_seconds Unix timestamp of the last successful openclaw sessions --json poll.",
  );
  out.push("# TYPE obs_auth_poll_last_success_seconds gauge");
  out.push(`obs_auth_poll_last_success_seconds ${fmtInt(lastSuccessSeconds)}`);
  out.push("");

  out.push("# HELP obs_auth_poll_last_success_age_seconds Seconds since the last successful auth-poller call.");
  out.push("# TYPE obs_auth_poll_last_success_age_seconds gauge");
  out.push(`obs_auth_poll_last_success_age_seconds ${fmtInt(lastSuccessAgeSeconds)}`);
  out.push("");

  out.push("# HELP obs_auth_poll_failures_total Number of auth-poller failures observed since process start.");
  out.push("# TYPE obs_auth_poll_failures_total counter");
  out.push(`obs_auth_poll_failures_total ${fmtInt(Number(poll.failuresTotal ?? 0))}`);
  out.push("");

  out.push("# HELP obs_auth_poll_inflight 1 if an auth-poller call is currently in flight, 0 otherwise.");
  out.push("# TYPE obs_auth_poll_inflight gauge");
  out.push(`obs_auth_poll_inflight ${poll.inFlight ? 1 : 0}`);

  // Trailing newline (single \n after the last value line).
  return `${out.join("\n")}\n`;
}

export function handleMetricsRoute(res: ServerResponse): void {
  const body = buildMetricsBody();
  res.writeHead(200, {
    "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  res.end(body);
}
