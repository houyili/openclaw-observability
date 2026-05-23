import { getDb } from "./db.ts";
import { CONFIG } from "../config.ts";
import type { ParsedStep, ParsedRun } from "../ingest/transcript-parser.ts";

export function upsertSteps(run: ParsedRun): void {
  const db = getDb();
  // Round 6 — INSERT and ON CONFLICT both carry the four new fields so a
  // re-upsert (e.g. on first-tick reparse after a parser fix) backfills
  // older rows in place.
  const stmt = db.prepare(`
    INSERT INTO steps (step_id, session_key, session_id, run_id, parent_step_id, seq, ts, ts_epoch_ms,
      role, node_type, tool_name, tool_call_id, skill_name, script_name, mcp_server, mcp_tool,
      duration_ms, total_tokens, output_tokens, input_text_len, result_text_len,
      context_token_delta, status, error_text, error_type, is_stuck, is_current,
      input_preview, result_preview,
      input_tokens, cache_read_tokens, thinking_text_len, reply_text_len)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?)
    ON CONFLICT(step_id) DO UPDATE SET
      session_id=COALESCE(excluded.session_id, steps.session_id),
      duration_ms=excluded.duration_ms, status=excluded.status, error_text=excluded.error_text,
      error_type=excluded.error_type, is_stuck=excluded.is_stuck, is_current=excluded.is_current,
      result_text_len=excluded.result_text_len, result_preview=excluded.result_preview,
      input_tokens=excluded.input_tokens, cache_read_tokens=excluded.cache_read_tokens,
      thinking_text_len=excluded.thinking_text_len, reply_text_len=excluded.reply_text_len
  `);

  for (const s of run.steps) {
    stmt.run(
      s.stepId, run.sessionKey, run.sessionId || null, run.runId, s.parentStepId, s.seq, s.ts, s.tsEpochMs,
      s.role, s.nodeType, s.toolName || null, s.toolCallId || null,
      s.skillName || null, s.scriptName || null, s.mcpServer || null, s.mcpTool || null,
      s.durationMs ?? null, s.totalTokens ?? null, s.outputTokens ?? null,
      s.inputTextLen ?? null, s.resultTextLen ?? null, s.contextTokenDelta ?? null,
      s.status, s.errorText || null, s.errorType || null,
      s.isStuck ? 1 : 0, s.isCurrent ? 1 : 0,
      s.inputPreview || null, s.resultPreview || null,
      s.inputTokens ?? null, s.cacheReadTokens ?? null,
      s.thinkingTextLen ?? null, s.replyTextLen ?? null,
    );
  }
}

export interface LatestRunInfo {
  run_id: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  model_steps: number;
  tool_steps: number;
  status: string;
}

function toBaseKey(sessionKey: string): string {
  return sessionKey.replace(/:run:[a-f0-9-]+$/, "");
}

export function getLatestRun(sessionKey: string, sessionId?: string | null): LatestRunInfo | null {
  const db = getDb();
  const baseKey = toBaseKey(sessionKey);
  // Find the latest run_id for this session (run_id = the user message entry id)
  const sql = `
    SELECT run_id, MIN(ts) as started_at, MAX(ts) as ended_at,
      MAX(ts_epoch_ms) - MIN(ts_epoch_ms) as duration_ms,
      SUM(CASE WHEN node_type = 'MODEL_THINK' THEN 1 ELSE 0 END) as model_steps,
      SUM(CASE WHEN node_type NOT IN ('MODEL_THINK', 'REPLY') AND role = 'assistant' THEN 1 ELSE 0 END) as tool_steps,
      CASE WHEN SUM(is_current) > 0 THEN 'running' ELSE 'completed' END as status
    FROM steps WHERE ${sessionId ? "session_id = ?" : "session_key = ?"}
    GROUP BY run_id
    ORDER BY MIN(ts_epoch_ms) DESC LIMIT 1
  `;
  const row = db.prepare(sql).get(sessionId || baseKey) as any;
  return row || null;
}

export function getRunList(sessionKey: string, sessionId?: string | null): LatestRunInfo[] {
  const db = getDb();
  const baseKey = toBaseKey(sessionKey);
  const sql = `
    SELECT run_id, MIN(ts) as started_at, MAX(ts) as ended_at,
      MAX(ts_epoch_ms) - MIN(ts_epoch_ms) as duration_ms,
      SUM(CASE WHEN node_type = 'MODEL_THINK' THEN 1 ELSE 0 END) as model_steps,
      SUM(CASE WHEN node_type NOT IN ('MODEL_THINK', 'REPLY') AND role = 'assistant' THEN 1 ELSE 0 END) as tool_steps,
      CASE WHEN SUM(is_current) > 0 THEN 'running' ELSE 'completed' END as status
    FROM steps WHERE ${sessionId ? "session_id = ?" : "session_key = ?"}
    GROUP BY run_id
    ORDER BY MIN(ts_epoch_ms) DESC
  `;
  const rows = db.prepare(sql).all(sessionId || baseKey) as LatestRunInfo[];
  return rows;
}

export function getTraceSpans(sessionKey: string, runId?: string, sessionId?: string | null): any[] {
  const db = getDb();
  // Strip :run:UUID suffix for step lookup
  const baseKey = toBaseKey(sessionKey);
  let sql: string;
  let params: any[];
  const keyCol = sessionId ? "session_id" : "session_key";
  const keyValue = sessionId || baseKey;

  if (runId) {
    sql = `SELECT * FROM steps WHERE ${keyCol} = ? AND run_id = ? ORDER BY seq`;
    params = [keyValue, runId];
  } else {
    // Get latest run's steps
    const latestRunId = db.prepare(`
      SELECT run_id FROM steps WHERE ${keyCol} = ?
      GROUP BY run_id ORDER BY MIN(ts_epoch_ms) DESC LIMIT 1
    `).get(keyValue) as any;
    if (!latestRunId) return [];
    sql = `SELECT * FROM steps WHERE ${keyCol} = ? AND run_id = ? ORDER BY seq`;
    params = [keyValue, latestRunId.run_id];
  }
  const rows = db.prepare(sql).all(...params);
  return rows;
}

export function getActivityBars(sessionKey: string, sessionId?: string | null): number[] {
  const db = getDb();
  sessionKey = toBaseKey(sessionKey);
  const now = Date.now();
  const buckets = CONFIG.ACTIVITY_BAR_BUCKETS;        // 60
  const windowMs = CONFIG.ACTIVITY_BAR_MINUTES * 60_000; // 240 min = 4h
  const bucketMs = windowMs / buckets;                 // 4 min per bucket
  const startMs = now - windowMs;

  const rows = db.prepare(`
    SELECT ts_epoch_ms, status, is_stuck FROM steps
    WHERE ${sessionId ? "session_id" : "session_key"} = ? AND ts_epoch_ms >= ?
    ORDER BY ts_epoch_ms
  `).all(sessionId || sessionKey, startMs) as any[];

  const bars = new Array(buckets).fill(0); // 0=idle
  for (const row of rows) {
    const bucket = Math.floor((row.ts_epoch_ms - startMs) / bucketMs);
    if (bucket < 0 || bucket >= buckets) continue;
    if (row.status === "error") bars[bucket] = Math.max(bars[bucket], 3);
    else if (row.is_stuck) bars[bucket] = Math.max(bars[bucket], 2);
    else bars[bucket] = Math.max(bars[bucket], 1);
  }
  return bars;
}

// ─── Aggregation queries for Tab 2-4 ───────────────────────────

function rangeToEpoch(range: string): number {
  const now = Date.now();
  if (range === "day") return now - 86_400_000;
  if (range === "week") return now - 7 * 86_400_000;
  if (range === "month") return now - 30 * 86_400_000;
  return 0; // all
}

/**
 * Single-query P95 computation.
 *
 * Replaces the old N+1 pattern (one SELECT per row to grab sorted durations).
 * SQLite's result is already sorted by `(bucket, duration_ms)` so we can
 * stream-group and pick the P95 index in one pass without a second round
 * trip per entry.
 */
function computeP95ByBucket(
  db: ReturnType<typeof getDb>,
  table: string,
  bucketCol: string,
  since: number,
  extraWhere = "",
): Map<string, number> {
  const sql = `
    SELECT ${bucketCol} as bucket, duration_ms FROM ${table}
    WHERE ${bucketCol} IS NOT NULL
      AND duration_ms IS NOT NULL
      AND ts_epoch_ms >= ?
      ${extraWhere}
    ORDER BY ${bucketCol}, duration_ms
  `;
  const rows = db.prepare(sql).all(since) as Array<{ bucket: string; duration_ms: number }>;
  const p95 = new Map<string, number>();
  let current = "";
  let list: number[] = [];
  const emit = () => {
    if (list.length > 0) {
      p95.set(current, list[Math.floor(list.length * 0.95)]);
    }
  };
  for (const r of rows) {
    if (r.bucket !== current) {
      emit();
      current = r.bucket;
      list = [];
    }
    list.push(r.duration_ms);
  }
  emit();
  return p95;
}

export function getSkillStats(range: string, q?: string) {
  const db = getDb();
  const since = rangeToEpoch(range);
  let sql = `
    SELECT r.name, r.path, r.status as reg_status,
      COUNT(s.step_id) as call_count,
      AVG(s.duration_ms) as avg_duration_ms,
      SUM(s.output_tokens) as total_tokens,
      SUM(CASE WHEN s.status = 'error' THEN 1 ELSE 0 END) as error_count,
      SUM(CASE WHEN s.is_stuck = 1 THEN 1 ELSE 0 END) as stuck_count
    FROM registry r
    LEFT JOIN steps s ON s.skill_name = r.name AND s.ts_epoch_ms >= ?
    WHERE r.type = 'skill'
  `;
  const params: any[] = [since];
  if (q) { sql += " AND r.name LIKE ?"; params.push(`%${q}%`); }
  sql += " GROUP BY r.name, r.path ORDER BY call_count DESC";
  const rows = db.prepare(sql).all(...params) as any[];

  const p95 = computeP95ByBucket(db, "steps", "skill_name", since);
  for (const row of rows) {
    row.p95_duration_ms = p95.get(row.name) ?? null;
  }
  return rows;
}

export function getScriptStats(range: string, q?: string) {
  const db = getDb();
  const since = rangeToEpoch(range);
  let sql = `
    SELECT r.name, r.path,
      COUNT(s.step_id) as call_count,
      AVG(s.duration_ms) as avg_duration_ms,
      SUM(CASE WHEN s.status = 'error' THEN 1 ELSE 0 END) as error_count,
      SUM(CASE WHEN s.is_stuck = 1 THEN 1 ELSE 0 END) as stuck_count
    FROM registry r
    LEFT JOIN steps s ON s.script_name = r.name AND s.ts_epoch_ms >= ?
    WHERE r.type = 'script'
  `;
  const params: any[] = [since];
  if (q) { sql += " AND r.name LIKE ?"; params.push(`%${q}%`); }
  sql += " GROUP BY r.name, r.path ORDER BY call_count DESC";
  const rows = db.prepare(sql).all(...params) as any[];

  const p95 = computeP95ByBucket(db, "steps", "script_name", since);
  for (const row of rows) {
    row.p95_duration_ms = p95.get(row.name) ?? null;
  }
  return rows;
}

export function getMcpStats(range: string, q?: string) {
  const db = getDb();
  const since = rangeToEpoch(range);
  let sql = `
    SELECT mcp_tool as name, mcp_server as server,
      COUNT(*) as call_count,
      AVG(duration_ms) as avg_duration_ms,
      CAST(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as error_rate,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
      SUM(CASE WHEN is_stuck = 1 THEN 1 ELSE 0 END) as stuck_count,
      AVG(result_text_len) as avg_result_bytes,
      AVG(context_token_delta) as avg_context_token_delta
    FROM steps
    WHERE node_type = 'MCP_CALL' AND ts_epoch_ms >= ?
  `;
  const params: any[] = [since];
  if (q) { sql += " AND mcp_tool LIKE ?"; params.push(`%${q}%`); }
  sql += " GROUP BY mcp_tool, mcp_server ORDER BY call_count DESC";
  const rows = db.prepare(sql).all(...params) as any[];

  const p95 = computeP95ByBucket(db, "steps", "mcp_tool", since, "AND node_type = 'MCP_CALL'");
  for (const row of rows) {
    row.p95_duration_ms = p95.get(row.name) ?? null;
  }
  return rows;
}

export function getMcpErrorTypeRanking(range: string) {
  const since = rangeToEpoch(range);
  return getDb().prepare(`
    SELECT error_type as type, COUNT(*) as count
    FROM steps WHERE node_type = 'MCP_CALL' AND status = 'error' AND ts_epoch_ms >= ?
    GROUP BY error_type ORDER BY count DESC LIMIT 10
  `).all(since);
}

function buildRankings(rows: any[], field: string) {
  const sorted = [...rows].filter(r => r.call_count > 0);
  return {
    topUsed: sorted.sort((a, b) => b.call_count - a.call_count).slice(0, 10).map(r => ({ name: r.name, count: r.call_count })),
    topErrors: sorted.filter(r => r.error_count > 0).sort((a, b) => b.error_count - a.error_count).slice(0, 10).map(r => ({ name: r.name, count: r.error_count })),
    topStuck: sorted.filter(r => r.stuck_count > 0).sort((a, b) => b.stuck_count - a.stuck_count).slice(0, 10).map(r => ({ name: r.name, count: r.stuck_count })),
  };
}

export { buildRankings };

// ─── Summary stats (v1 feature: top cards) ──────────────────────

export function getSummaryStats() {
  const db = getDb();
  const runs = db.prepare(`
    SELECT run_id, session_key, MIN(ts_epoch_ms) as start_ms, MAX(ts_epoch_ms) as end_ms,
      CASE WHEN SUM(is_current) > 0 THEN 'running' ELSE 'completed' END as status,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors
    FROM steps GROUP BY run_id
  `).all() as any[];

  const completed = runs.filter(r => r.status === "completed");
  const failed = completed.filter(r => r.errors > 0);
  const running = runs.filter(r => r.status === "running");
  const durations = completed.map(r => r.end_ms - r.start_ms).filter(d => d > 0).sort((a, b) => a - b);
  const avgDur = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  const p95Dur = durations.length > 0 ? durations[Math.floor(durations.length * 0.95)] : 0;

  const toolCount = (db.prepare("SELECT COUNT(*) as n FROM steps WHERE role = 'assistant' AND node_type NOT IN ('MODEL_THINK','REPLY')").get() as any).n;
  const toolErrors = (db.prepare("SELECT COUNT(*) as n FROM steps WHERE status = 'error'").get() as any).n;
  const subagents = (db.prepare("SELECT COUNT(*) as n FROM steps WHERE node_type = 'SUBAGENT_SPAWN'").get() as any).n;
  const stalled = (db.prepare("SELECT COUNT(*) as n FROM steps WHERE is_stuck = 1").get() as any).n;
  const timeouts = (db.prepare("SELECT COUNT(*) as n FROM steps WHERE error_type = 'timeout'").get() as any).n;

  return {
    runs: runs.length,
    success: completed.length - failed.length,
    failed: failed.length,
    running: running.length,
    avgDurationMs: Math.round(avgDur),
    p95DurationMs: Math.round(p95Dur),
    tools: toolCount,
    toolErrors,
    subagents,
    stalled,
    timeouts,
  };
}
