/**
 * Round 6 — CLI subcommand handlers (§5).
 *
 * Each handler is a PURE function that takes the obs.db handle plus
 * positional args and returns a plain-text response. No I/O beyond DB
 * reads. This makes them trivially unit-testable against a temp DB
 * (see `tests/cli-commands.test.ts`).
 *
 * The handlers wrap existing storage repo functions — there is NO new
 * SQL in this module. Round 6 explicitly reuses Round 1's repos.
 *
 * Output formatting rules: see `format.ts`.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  header, truncateKey, fmtTok, fmtAge, keyVal, table,
} from "./format.ts";
import { getAllSessions } from "../storage/sessions-repo.ts";
import { getSkillStats, getScriptStats, getMcpStats, getSummaryStats } from "../storage/steps-repo.ts";
import { getAuthPollStatus } from "../ingest/auth-poller.ts";

export type Handler = (db: DatabaseSync, args: string[]) => string;

// ─── /observ status ─────────────────────────────────────────────

export const handleStatus: Handler = (db, _args) => {
  const sessionCount = (db.prepare("SELECT COUNT(*) as n FROM sessions").get() as any).n;
  const stepCount = (db.prepare("SELECT COUNT(*) as n FROM steps").get() as any).n;

  const auth = getAuthPollStatus();
  const ageMs = auth.lastSuccessAt != null ? Date.now() - auth.lastSuccessAt : null;
  const authLine = auth.lastError
    ? `failing · ${truncateKey(auth.lastError, 60)}`
    : auth.lastSuccessAt == null
    ? "never polled yet"
    : `ok · last success ${fmtAge(ageMs)} ago`;

  // Stuck count
  const stuckRows = getAllSessions({ state: "stuck", pageSize: 5 });
  const stuckLine = stuckRows.total === 0
    ? "0"
    : `${stuckRows.total} (${truncateKey(stuckRows.sessions[0]?.session_key || "", 50)})`;

  // Errors in the last 1h
  const oneHourAgo = Date.now() - 3_600_000;
  const errorRows = db.prepare(
    "SELECT error_type, COUNT(*) as n FROM steps WHERE status='error' AND ts_epoch_ms >= ? GROUP BY error_type ORDER BY n DESC",
  ).all(oneHourAgo) as Array<{ error_type: string; n: number }>;
  const errorTotal = errorRows.reduce((s, r) => s + r.n, 0);
  const errorBreakdown = errorRows.length > 0
    ? errorRows.map((r) => `${r.error_type}:${r.n}`).join(" ")
    : "none";

  return [
    header("observability-v2 status"),
    keyVal([
      ["service",   `up · ${stepCount.toLocaleString()} steps tracked`],
      ["db",        `${stepCount.toLocaleString()} steps · ${sessionCount.toLocaleString()} sessions`],
      ["auth-poll", authLine],
      ["stuck now", stuckLine],
      ["errors 1h", `${errorTotal} (${errorBreakdown})`],
    ]),
  ].join("\n");
};

// ─── /observ stuck ──────────────────────────────────────────────

export const handleStuck: Handler = (_db, _args) => {
  const result = getAllSessions({ state: "stuck", pageSize: 10 });
  if (result.total === 0) {
    return header("observability-v2 stuck") + "\n(no stuck sessions)";
  }
  const rows = result.sessions.map((s) => {
    const ageMs = s.last_block_ts ? Date.now() - s.last_block_ts : null;
    return [
      truncateKey(s.session_key),
      s.blocker || "—",
      fmtAge(ageMs),
      truncateKey(s.current_op || "—", 20),
    ];
  });
  return [
    header(`observability-v2 stuck (${result.total})`),
    table(["session", "blocker", "stuck", "current_op"], rows),
  ].join("\n");
};

// ─── /observ top ────────────────────────────────────────────────

export const handleTop: Handler = (db, _args) => {
  const oneDayAgo = Date.now() - 86_400_000;
  const rows = db.prepare(`
    SELECT session_key, MAX(total_tokens) as total_tokens, MAX(model) as model
    FROM sessions
    WHERE updated_at >= ? AND channel != 'cron'
    GROUP BY session_key
    ORDER BY MAX(total_tokens) DESC
    LIMIT 5
  `).all(oneDayAgo) as Array<{ session_key: string; total_tokens: number; model: string }>;
  if (rows.length === 0) {
    return header("observability-v2 top (24h)") + "\n(no sessions in the last 24h)";
  }
  const data = rows.map((r) => [
    truncateKey(r.session_key),
    fmtTok(r.total_tokens),
    r.model || "—",
  ]);
  return [
    header("observability-v2 top sessions (24h)"),
    table(["session", "tokens", "model"], data),
  ].join("\n");
};

// ─── /observ skills [day|week|month] ────────────────────────────

function parseRange(arg: string | undefined): "day" | "week" | "month" | "all" {
  if (arg === "day" || arg === "week" || arg === "month" || arg === "all") return arg;
  return "day";
}

export const handleSkills: Handler = (_db, args) => {
  const range = parseRange(args[0]);
  const rows = (getSkillStats(range) as any[])
    .filter((r) => r.call_count > 0)
    .slice(0, 5);
  if (rows.length === 0) {
    return header(`observability-v2 skills (${range})`) + "\n(no skill calls)";
  }
  const data = rows.map((r) => [
    r.name || "—",
    String(r.call_count),
    fmtTok(r.avg_duration_ms ? Math.round(r.avg_duration_ms) : 0) + "ms",
    fmtTok(r.p95_duration_ms || 0) + "ms",
    String(r.error_count || 0),
  ]);
  return [
    header(`observability-v2 skills (${range})`),
    table(["name", "calls", "avg", "p95", "err"], data),
  ].join("\n");
};

// ─── /observ scripts [day|week|month] ───────────────────────────

export const handleScripts: Handler = (_db, args) => {
  const range = parseRange(args[0]);
  const rows = (getScriptStats(range) as any[])
    .filter((r) => r.call_count > 0)
    .slice(0, 5);
  if (rows.length === 0) {
    return header(`observability-v2 scripts (${range})`) + "\n(no script calls)";
  }
  const data = rows.map((r) => [
    r.name || "—",
    String(r.call_count),
    fmtTok(r.avg_duration_ms ? Math.round(r.avg_duration_ms) : 0) + "ms",
    fmtTok(r.p95_duration_ms || 0) + "ms",
    String(r.error_count || 0),
  ]);
  return [
    header(`observability-v2 scripts (${range})`),
    table(["name", "calls", "avg", "p95", "err"], data),
  ].join("\n");
};

// ─── /observ mcps [day|week|month] ──────────────────────────────

export const handleMcps: Handler = (_db, args) => {
  const range = parseRange(args[0]);
  const rows = (getMcpStats(range) as any[]).slice(0, 5);
  if (rows.length === 0) {
    return header(`observability-v2 mcps (${range})`) + "\n(no MCP calls)";
  }
  const data = rows.map((r) => [
    r.name || "—",
    String(r.call_count),
    fmtTok(r.avg_duration_ms ? Math.round(r.avg_duration_ms) : 0) + "ms",
    fmtTok(r.p95_duration_ms || 0) + "ms",
    ((r.error_rate || 0) * 100).toFixed(1) + "%",
  ]);
  return [
    header(`observability-v2 mcps (${range})`),
    table(["name", "calls", "avg", "p95", "err%"], data),
  ].join("\n");
};

// ─── /observ errors ─────────────────────────────────────────────

export const handleErrors: Handler = (db, _args) => {
  const rows = db.prepare(`
    SELECT ts, session_key, tool_name, error_type, error_text
    FROM steps WHERE status='error'
    ORDER BY ts_epoch_ms DESC LIMIT 10
  `).all() as Array<{
    ts: string; session_key: string; tool_name: string | null;
    error_type: string | null; error_text: string | null;
  }>;
  if (rows.length === 0) {
    return header("observability-v2 errors") + "\n(no recent errors)";
  }
  const data = rows.map((r) => [
    new Date(r.ts).toLocaleTimeString(),
    truncateKey(r.session_key, 24),
    r.tool_name || "—",
    r.error_type || "—",
    truncateKey(r.error_text || "", 30),
  ]);
  return [
    header(`observability-v2 errors (latest 10)`),
    table(["time", "session", "tool", "type", "msg"], data),
  ].join("\n");
};

// ─── /observ help ───────────────────────────────────────────────

export const handleHelp: Handler = (_db, _args) => {
  return [
    header("observability-v2 commands"),
    keyVal([
      ["/observ",         "open the dashboard URL (local + remote)"],
      ["/observ status",  "1-screen service + db + auth-poll + stuck + 1h errors"],
      ["/observ stuck",   "top 10 currently stuck sessions"],
      ["/observ top",     "top 5 sessions by token usage in the last 24h"],
      ["/observ skills",  "top 5 most-used skills (day | week | month)"],
      ["/observ scripts", "top 5 most-used scripts (day | week | month)"],
      ["/observ mcps",    "top 5 MCPs with error rate (day | week | month)"],
      ["/observ errors",  "latest 10 errors with type and snippet"],
      ["/observ help",    "this list"],
    ]),
  ].join("\n");
};

// ─── Registry (used by dispatcher.ts and tests) ─────────────────

export const HANDLERS: Record<string, Handler> = {
  status:  handleStatus,
  stuck:   handleStuck,
  top:     handleTop,
  skills:  handleSkills,
  scripts: handleScripts,
  mcps:    handleMcps,
  errors:  handleErrors,
  help:    handleHelp,
};
