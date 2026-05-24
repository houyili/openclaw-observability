import { CONFIG } from "../config.ts";
import type { AuthSession } from "../ingest/auth-poller.ts";
import { getDb } from "./db.ts";

export function upsertAuthSessions(sessions: AuthSession[]): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO sessions (session_key, session_id, agent_id, channel, diag, label, kind,
      model, model_provider, input_tokens, output_tokens, total_tokens, context_tokens,
      runtime_mode, updated_at, age_ms, source, token_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'auth-only', ?)
    ON CONFLICT(session_key, session_id) DO UPDATE SET
      agent_id=excluded.agent_id,
      channel=excluded.channel, diag=excluded.diag, label=excluded.label, kind=excluded.kind,
      model=excluded.model, model_provider=excluded.model_provider,
      input_tokens=CASE WHEN COALESCE(excluded.input_tokens, 0) > 0 THEN excluded.input_tokens ELSE sessions.input_tokens END,
      output_tokens=CASE WHEN COALESCE(excluded.output_tokens, 0) > 0 THEN excluded.output_tokens ELSE sessions.output_tokens END,
      total_tokens=CASE WHEN COALESCE(excluded.total_tokens, 0) > 0 THEN excluded.total_tokens ELSE sessions.total_tokens END,
      context_tokens=CASE WHEN COALESCE(excluded.context_tokens, 0) > 0 THEN excluded.context_tokens ELSE sessions.context_tokens END,
      runtime_mode=excluded.runtime_mode,
      updated_at=excluded.updated_at, age_ms=excluded.age_ms,
      token_source=CASE
        WHEN COALESCE(excluded.total_tokens, 0) > 0
          OR COALESCE(excluded.input_tokens, 0) > 0
          OR COALESCE(excluded.output_tokens, 0) > 0
          OR COALESCE(excluded.context_tokens, 0) > 0
        THEN 'official'
        WHEN sessions.source LIKE '%transcript%' AND COALESCE(sessions.total_tokens, 0) > 0
        THEN 'transcript-backfill'
        ELSE COALESCE(sessions.token_source, excluded.token_source, 'official-zero')
      END
  `);
  for (const s of sessions) {
    const tokenSource =
      s.totalTokens || s.inputTokens || s.outputTokens || s.contextTokens ? "official" : "official-zero";
    stmt.run(
      s.sessionKey,
      s.sessionId,
      s.agentId,
      s.channel,
      s.diag,
      s.label,
      s.kind,
      s.model,
      s.modelProvider,
      s.inputTokens,
      s.outputTokens,
      s.totalTokens,
      s.contextTokens,
      s.runtimeMode,
      s.updatedAt,
      s.ageMs,
      tokenSource,
    );
  }
}

const BASE_KEY_RE = /:run:[a-f0-9-]+$/;

/** Strip the `:run:UUID` suffix that openclaw CLI emits for per-run cron session rows. */
function toBaseKey(k: string): string {
  return k.replace(BASE_KEY_RE, "");
}

/**
 * Recompute counts for ALL sessions from the steps table.
 *
 * Key insight (measured 2026-04-11): the sessions table contains ~360 rows
 * with a `:run:UUID` suffix (cron runs) but steps are ONLY stored under the
 * base key. Naively iterating every distinct sessions row wastes work.
 * We collapse to unique base keys FIRST (typically ~28), run one aggregation
 * per base key, then fan the result out to every sessions row sharing it.
 */
export function recomputeAllSessionCounts(): void {
  const db = getDb();

  // 1. Collect unique base keys present in sessions table.
  const sessionKeys = db.prepare("SELECT DISTINCT session_key FROM sessions").all() as any[];
  const baseKeys = new Set<string>();
  for (const { session_key } of sessionKeys) baseKeys.add(toBaseKey(session_key));

  const aggStmt = db.prepare(`
    SELECT
      SUM(CASE WHEN node_type = 'MODEL_THINK' THEN 1 ELSE 0 END) as llm,
      SUM(CASE WHEN role = 'assistant' AND node_type NOT IN ('MODEL_THINK','REPLY') THEN 1 ELSE 0 END) as tool,
      SUM(CASE WHEN skill_name IS NOT NULL AND role = 'assistant' THEN 1 ELSE 0 END) as skill,
      SUM(CASE WHEN mcp_tool IS NOT NULL AND role = 'assistant' THEN 1 ELSE 0 END) as mcp,
      COUNT(*) as total
    FROM steps WHERE session_key = ?
  `);
  // Token aggregation: take the last assistant turn's cumulative totals.
  // The API's usage.totalTokens on each assistant message is cumulative for
  // the session, so the MAX across all MODEL_THINK/REPLY rows is the best
  // approximation of session-level token usage.
  const tokenStmt = db.prepare(`
    SELECT
      MAX(total_tokens)  as total_tok,
      MAX(input_tokens)  as input_tok,
      SUM(CASE WHEN node_type IN ('MODEL_THINK','REPLY') THEN output_tokens ELSE 0 END) as output_tok,
      MAX(CASE WHEN node_type IN ('MODEL_THINK','REPLY') THEN input_tokens ELSE 0 END) as context_tok
    FROM steps WHERE session_key = ? AND total_tokens IS NOT NULL
  `);
  // Latest step timestamp — used to refresh updated_at for sessions that
  // fell out of auth-poller's `--active N` window but are still ingesting
  // transcript steps (otherwise they'd display with stale/ancient ages).
  const latestStepStmt = db.prepare(`
    SELECT MAX(ts_epoch_ms) as latest FROM steps WHERE session_key = ?
  `);
  // Fan-out: update both exact-match (direct sessions) AND all :run:UUID variants.
  // Token fields are only backfilled when the auth-poller left them at 0 or NULL.
  // updated_at is refreshed to MAX(current, latest_step_ts) so transcript activity
  // keeps the session fresh even when auth-poller has stopped returning it.
  const updateStmt = db.prepare(`
    UPDATE sessions SET
      llm_call_count = ?, tool_call_count = ?, skill_call_count = ?, mcp_call_count = ?,
      total_tokens   = CASE WHEN COALESCE(total_tokens, 0) = 0 THEN ? ELSE total_tokens END,
      input_tokens   = CASE WHEN COALESCE(input_tokens, 0) = 0 THEN ? ELSE input_tokens END,
      output_tokens  = CASE WHEN COALESCE(output_tokens, 0) = 0 THEN ? ELSE output_tokens END,
      context_tokens = CASE WHEN COALESCE(context_tokens, 0) = 0 THEN ? ELSE context_tokens END,
      token_source   = CASE
        WHEN COALESCE(total_tokens, 0) = 0 AND ? > 0 THEN 'transcript-backfill'
        ELSE COALESCE(token_source, 'official')
      END,
      updated_at     = MAX(COALESCE(updated_at, 0), ?),
      source = CASE WHEN ? > 0 THEN 'transcript+auth' ELSE source END
    WHERE session_key = ? OR session_key LIKE ?
  `);

  for (const baseKey of baseKeys) {
    const row = aggStmt.get(baseKey) as any;
    if (!row) continue;
    const tok = tokenStmt.get(baseKey) as any;
    const latest = latestStepStmt.get(baseKey) as any;
    updateStmt.run(
      row.llm || 0,
      row.tool || 0,
      row.skill || 0,
      row.mcp || 0,
      tok?.total_tok || 0,
      tok?.input_tok || 0,
      tok?.output_tok || 0,
      tok?.context_tok || 0,
      tok?.total_tok || 0,
      latest?.latest || 0,
      row.total || 0,
      baseKey,
      `${baseKey}:run:%`,
    );
  }
}

/**
 * Recompute session counts from the steps table (idempotent, safe on restart).
 * Accepts either a base key or a :run:UUID variant; always aggregates against
 * the base key and fans the result out to all matching sessions rows.
 *
 * Round 5 fix: only flip `source = 'transcript+auth'` when the aggregate
 * actually found at least one step. The previous version flipped source
 * unconditionally, which left orphan rows in the form
 *   { source: 'transcript+auth', llm/tool/skill/mcp counts all 0 }
 * for any session whose only transcript content was a user message with
 * no assistant response (e.g. a subagent that was spawned but never ran).
 * Now matches the gating in `recomputeAllSessionCounts`.
 */
export function recomputeSessionCounts(sessionKey: string): void {
  const db = getDb();
  const baseKey = toBaseKey(sessionKey);
  const row = db
    .prepare(`
    SELECT
      SUM(CASE WHEN node_type = 'MODEL_THINK' THEN 1 ELSE 0 END) as llm,
      SUM(CASE WHEN role = 'assistant' AND node_type NOT IN ('MODEL_THINK','REPLY') THEN 1 ELSE 0 END) as tool,
      SUM(CASE WHEN skill_name IS NOT NULL AND role = 'assistant' THEN 1 ELSE 0 END) as skill,
      SUM(CASE WHEN mcp_tool IS NOT NULL AND role = 'assistant' THEN 1 ELSE 0 END) as mcp,
      COUNT(*) as total
    FROM steps WHERE session_key = ?
  `)
    .get(baseKey) as any;
  if (!row) return;

  // Token aggregation from steps (backfill when auth-poller left values at 0).
  const tok = db
    .prepare(`
    SELECT
      MAX(total_tokens)  as total_tok,
      MAX(input_tokens)  as input_tok,
      SUM(CASE WHEN node_type IN ('MODEL_THINK','REPLY') THEN output_tokens ELSE 0 END) as output_tok,
      MAX(CASE WHEN node_type IN ('MODEL_THINK','REPLY') THEN input_tokens ELSE 0 END) as context_tok
    FROM steps WHERE session_key = ? AND total_tokens IS NOT NULL
  `)
    .get(baseKey) as any;

  // Latest step ts — refresh updated_at for sessions not covered by auth-poller
  const latest = db
    .prepare(`
    SELECT MAX(ts_epoch_ms) as latest FROM steps WHERE session_key = ?
  `)
    .get(baseKey) as any;

  db.prepare(`
    UPDATE sessions SET
      llm_call_count = ?, tool_call_count = ?, skill_call_count = ?, mcp_call_count = ?,
      total_tokens   = CASE WHEN COALESCE(total_tokens, 0) = 0 THEN ? ELSE total_tokens END,
      input_tokens   = CASE WHEN COALESCE(input_tokens, 0) = 0 THEN ? ELSE input_tokens END,
      output_tokens  = CASE WHEN COALESCE(output_tokens, 0) = 0 THEN ? ELSE output_tokens END,
      context_tokens = CASE WHEN COALESCE(context_tokens, 0) = 0 THEN ? ELSE context_tokens END,
      token_source   = CASE
        WHEN COALESCE(total_tokens, 0) = 0 AND ? > 0 THEN 'transcript-backfill'
        ELSE COALESCE(token_source, 'official')
      END,
      updated_at     = MAX(COALESCE(updated_at, 0), ?),
      source = CASE WHEN ? > 0 THEN 'transcript+auth' ELSE source END
    WHERE session_key = ? OR session_key LIKE ?
  `).run(
    row.llm || 0,
    row.tool || 0,
    row.skill || 0,
    row.mcp || 0,
    tok?.total_tok || 0,
    tok?.input_tok || 0,
    tok?.output_tok || 0,
    tok?.context_tok || 0,
    tok?.total_tok || 0,
    latest?.latest || 0,
    row.total || 0,
    baseKey,
    `${baseKey}:run:%`,
  );
}

export function updateSessionLabel(sessionKey: string, label: string): void {
  getDb().prepare("UPDATE sessions SET label = ? WHERE session_key = ?").run(label, sessionKey);
}

/** Set parent info. parent_session_key is write-once; parent_session_id can be backfilled later. */
export function updateSessionParent(
  sessionKey: string,
  parentSessionKey: string,
  parentSessionId: string | null,
): void {
  const db = getDb();
  // Set parent_session_key (write-once)
  db.prepare(`
    UPDATE sessions SET parent_session_key = ?
    WHERE session_key = ? AND parent_session_key IS NULL
  `).run(parentSessionKey, sessionKey);
  // Backfill parent_session_id (may arrive later when parent entry appears in sessions.json)
  if (parentSessionId) {
    db.prepare(`
      UPDATE sessions SET parent_session_id = ?
      WHERE session_key = ? AND parent_session_id IS NULL
    `).run(parentSessionId, sessionKey);
  }
}

/**
 * Count direct children for each parent session_id in a batch.
 * Returns a map: parentSessionId → childCount.
 */
export function getChildCounts(parentSessionIds: string[]): Map<string, number> {
  const db = getDb();
  const map = new Map<string, number>();
  if (parentSessionIds.length === 0) return map;
  const stmt = db.prepare("SELECT COUNT(DISTINCT session_key) as cnt FROM sessions WHERE parent_session_id = ?");
  for (const pid of parentSessionIds) {
    const row = stmt.get(pid) as any;
    if (row && row.cnt > 0) map.set(pid, row.cnt);
  }
  return map;
}

/**
 * Batch-fetch parent session info for display (diag, label, agentId).
 * Returns a map: parentSessionId → { diag, label, agentId }.
 */
export function getParentInfoBatch(
  parentSessionIds: string[],
): Map<string, { diag: string; label: string | null; agentId: string }> {
  const db = getDb();
  const map = new Map<string, { diag: string; label: string | null; agentId: string }>();
  if (parentSessionIds.length === 0) return map;
  const stmt = db.prepare("SELECT diag, label, agent_id FROM sessions WHERE session_id = ? LIMIT 1");
  for (const pid of parentSessionIds) {
    const row = stmt.get(pid) as any;
    if (row) map.set(pid, { diag: row.diag || "", label: row.label || null, agentId: row.agent_id || "" });
  }
  return map;
}

/**
 * Get child sessions for a given parent session_id.
 */
export function getChildSessions(parentSessionId: string): SessionRow[] {
  return getDb()
    .prepare("SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY updated_at DESC")
    .all(parentSessionId) as unknown as SessionRow[];
}

export function updateSessionBlocker(sessionKey: string, blocker: string, blockTs: number): void {
  getDb()
    .prepare("UPDATE sessions SET blocker = ?, last_block_ts = ? WHERE session_key = ?")
    .run(blocker, blockTs, sessionKey);
}

/**
 * Recompute current_op and blocker for all sessions from steps table.
 *
 *   current_op = the latest step's tool_name (or node_type)
 *   blocker    = the latest stuck step's tool_name
 *
 * Hot path: this used to iterate every `SELECT DISTINCT session_key FROM sessions`
 * row (~400) and run 2-3 `OR LIKE` queries per row (~1200 total). The `OR LIKE`
 * branch prevented the composite index from being used, forcing full scans.
 * Rewrite: dedupe to unique base keys first (~28) and use a single `=` lookup
 * with the `idx_steps_session_ts` index.
 *
 * @param onlyBaseKeys optional whitelist — when set, only these base keys are
 *                     recomputed (used after transcript-watcher ingests new steps).
 */
export function recomputeAllSessionOps(onlyBaseKeys?: Set<string>): void {
  const db = getDb();

  // 1. Collect unique base keys to process.
  let baseKeys: Set<string>;
  if (onlyBaseKeys && onlyBaseKeys.size > 0) {
    baseKeys = onlyBaseKeys;
  } else {
    baseKeys = new Set<string>();
    const sessionKeys = db.prepare("SELECT DISTINCT session_key FROM sessions").all() as any[];
    for (const { session_key } of sessionKeys) baseKeys.add(toBaseKey(session_key));
  }

  // Prepared statements reused across the loop.
  const lastStepStmt = db.prepare(`
    SELECT step_id, tool_name, node_type, is_current, is_stuck, ts_epoch_ms, status
    FROM steps WHERE session_key = ?
    ORDER BY ts_epoch_ms DESC LIMIT 1
  `);
  const prevToolStmt = db.prepare(`
    SELECT tool_name, node_type FROM steps
    WHERE session_key = ? AND node_type NOT IN ('MODEL_THINK','REPLY') AND role = 'assistant'
    ORDER BY ts_epoch_ms DESC LIMIT 1
  `);
  const stuckStepStmt = db.prepare(`
    SELECT tool_name, node_type, ts_epoch_ms
    FROM steps
    WHERE session_key = ? AND is_current = 1 AND (? - ts_epoch_ms) > ?
    ORDER BY ts_epoch_ms DESC LIMIT 1
  `);
  const markCurrentStuckStmt = db.prepare(`
    UPDATE steps SET is_stuck = 1
    WHERE session_key = ? AND is_current = 1 AND (? - ts_epoch_ms) > ?
  `);
  // Fan-out: write back to the base key AND every :run:UUID variant sharing it.
  const updateStmt = db.prepare(`
    UPDATE sessions SET
      current_op    = ?,
      blocker       = ?,
      last_block_ts = ?,
      diag_state    = ?,
      updated_at    = MAX(COALESCE(updated_at, 0), ?)
    WHERE session_key = ? OR session_key LIKE ?
  `);
  const now = Date.now();

  for (const baseKey of baseKeys) {
    const lastStep = lastStepStmt.get(baseKey) as any;
    if (!lastStep) {
      updateStmt.run(null, null, null, "idle", 0, baseKey, `${baseKey}:run:%`);
      continue;
    }

    let currentOp = lastStep.tool_name || lastStep.node_type || null;
    if (lastStep.node_type === "REPLY" || lastStep.node_type === "MODEL_THINK") {
      const prevTool = prevToolStmt.get(baseKey) as any;
      if (prevTool) currentOp = prevTool.tool_name || prevTool.node_type;
    }

    markCurrentStuckStmt.run(baseKey, now, CONFIG.STUCK_THRESHOLD_MS);
    const stuckStep = stuckStepStmt.get(baseKey, now, CONFIG.STUCK_THRESHOLD_MS) as any;
    const blocker = stuckStep ? stuckStep.tool_name || stuckStep.node_type : null;
    const blockTs = stuckStep ? stuckStep.ts_epoch_ms : null;

    let diagState = "idle";
    if (lastStep.is_current) {
      const dynamicStuck = now - lastStep.ts_epoch_ms > CONFIG.STUCK_THRESHOLD_MS;
      diagState = dynamicStuck ? "stuck" : "processing";
    }
    if (lastStep.status === "error") diagState = "stuck";

    updateStmt.run(currentOp, blocker, blockTs, diagState, lastStep.ts_epoch_ms || 0, baseKey, `${baseKey}:run:%`);
  }
}

export function updateSessionDiagState(sessionKey: string, diagState: string, currentOp?: string): void {
  getDb()
    .prepare(`
    UPDATE sessions SET diag_state = ?, current_op = ? WHERE session_key = ?
  `)
    .run(diagState, currentOp || null, sessionKey);
}

export interface SessionRow {
  session_key: string;
  session_id: string;
  agent_id: string;
  channel: string;
  diag: string;
  label: string | null;
  kind: string;
  model: string;
  model_provider: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  context_tokens: number;
  runtime_mode: string;
  llm_call_count: number;
  tool_call_count: number;
  skill_call_count: number;
  mcp_call_count: number;
  diag_state: string | null;
  current_op: string | null;
  blocker: string | null;
  last_block_ts: number | null;
  updated_at: number;
  age_ms: number;
  source: string;
  token_source: string | null;
  parent_session_key: string | null;
  parent_session_id: string | null;
}

export interface SessionListResult {
  sessions: SessionRow[];
  total: number;
  page: number;
  pageSize: number;
}

export function getAllSessions(filters?: {
  channel?: string;
  agent?: string;
  state?: string;
  q?: string;
  diag?: string;
  label?: string;
  parentKey?: string; // filter to children by parent session_key (legacy)
  parentId?: string; // filter to children by parent session_id (preferred)
  isCron?: boolean; // true = only cron, false = exclude cron, undefined = all
  page?: number;
  pageSize?: number;
}): SessionListResult {
  const db = getDb();
  let sql = "SELECT * FROM sessions WHERE 1=1";
  let countSql = "SELECT COUNT(*) as total FROM sessions WHERE 1=1";
  const p: any[] = [];

  if (filters?.isCron === true) {
    sql += " AND channel = 'cron'";
    countSql += " AND channel = 'cron'";
  } else if (filters?.isCron === false) {
    sql += " AND channel != 'cron'";
    countSql += " AND channel != 'cron'";
  }

  if (filters?.channel) {
    sql += " AND channel = ?";
    countSql += " AND channel = ?";
    p.push(filters.channel);
  }
  if (filters?.agent) {
    sql += " AND agent_id = ?";
    countSql += " AND agent_id = ?";
    p.push(filters.agent);
  }
  if (filters?.state) {
    sql += " AND diag_state = ?";
    countSql += " AND diag_state = ?";
    p.push(filters.state);
  }
  if (filters?.diag) {
    sql += " AND diag LIKE ?";
    countSql += " AND diag LIKE ?";
    p.push(`%${filters.diag}%`);
  }
  if (filters?.label) {
    sql += " AND label LIKE ?";
    countSql += " AND label LIKE ?";
    p.push(`%${filters.label}%`);
  }
  if (filters?.parentId) {
    sql += " AND parent_session_id = ?";
    countSql += " AND parent_session_id = ?";
    p.push(filters.parentId);
  } else if (filters?.parentKey) {
    sql += " AND parent_session_key = ?";
    countSql += " AND parent_session_key = ?";
    p.push(filters.parentKey);
  }
  if (filters?.q) {
    const clause = " AND (session_key LIKE ? OR label LIKE ? OR session_id LIKE ?)";
    sql += clause;
    countSql += clause;
    p.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`);
  }

  const total = (db.prepare(countSql).get(...p) as any).total;
  const page = filters?.page || 1;
  const pageSize = filters?.pageSize || 15;
  sql += " ORDER BY updated_at DESC LIMIT ? OFFSET ?";

  const rows = db.prepare(sql).all(...p, pageSize, (page - 1) * pageSize) as unknown as SessionRow[];
  return { sessions: rows, total, page, pageSize };
}

export function getSession(key: string): SessionRow | null {
  return (getDb().prepare("SELECT * FROM sessions WHERE session_key = ?").get(key) as unknown as SessionRow) || null;
}
