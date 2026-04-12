import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CONFIG } from "../config.ts";

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (_db) return _db;
  mkdirSync(dirname(CONFIG.DB_PATH), { recursive: true });
  _db = new DatabaseSync(CONFIG.DB_PATH);
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec("PRAGMA busy_timeout=5000");
  migrate(_db);
  return _db;
}

/**
 * Idempotent column add. SQLite's `ALTER TABLE ADD COLUMN` is not natively
 * idempotent — running it twice errors. Guard with PRAGMA table_info so the
 * migration is safe across every restart.
 */
function ensureColumn(db: DatabaseSync, table: string, col: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === col)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_key       TEXT NOT NULL,
      session_id        TEXT,
      agent_id          TEXT,
      channel           TEXT,
      diag              TEXT,    -- who/which group: extracted from session_key
      label             TEXT,
      kind              TEXT,
      model             TEXT,
      model_provider    TEXT,
      input_tokens      INTEGER,
      output_tokens     INTEGER,
      total_tokens      INTEGER,
      context_tokens    INTEGER,
      runtime_mode      TEXT,    -- merged thinking/fast/verbose/reasoning
      llm_call_count    INTEGER DEFAULT 0,
      tool_call_count   INTEGER DEFAULT 0,
      skill_call_count  INTEGER DEFAULT 0,
      mcp_call_count    INTEGER DEFAULT 0,
      diag_state        TEXT,
      current_op        TEXT,
      blocker           TEXT,
      last_block_ts     INTEGER,
      updated_at        INTEGER,
      age_ms            INTEGER,
      source            TEXT DEFAULT 'auth-only',
      PRIMARY KEY (session_key, session_id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS steps (
      step_id             TEXT PRIMARY KEY,
      session_key         TEXT NOT NULL,
      run_id              TEXT NOT NULL,
      parent_step_id      TEXT,
      seq                 INTEGER,
      ts                  TEXT NOT NULL,
      ts_epoch_ms         INTEGER NOT NULL,
      role                TEXT NOT NULL,
      node_type           TEXT NOT NULL,
      tool_name           TEXT,
      tool_call_id        TEXT,
      skill_name          TEXT,
      script_name         TEXT,
      mcp_server          TEXT,
      mcp_tool            TEXT,
      duration_ms         INTEGER,
      total_tokens        INTEGER,
      output_tokens       INTEGER,
      input_text_len      INTEGER,
      result_text_len     INTEGER,
      context_token_delta INTEGER,
      status              TEXT DEFAULT 'ok',
      error_text          TEXT,
      error_type          TEXT,
      is_stuck            INTEGER DEFAULT 0,
      is_current          INTEGER DEFAULT 0,
      input_preview       TEXT,
      result_preview      TEXT
    )
  `);

  // Round 6 — additive columns for the Context Length view. Each is
  // nullable so the migration is backward-compatible: existing rows stay
  // NULL until the next service restart triggers Round 2's first-tick
  // full-file reparse, at which point they get backfilled in place.
  // Round 7 — parent-child session relationship from sessions.json spawnedBy.
  ensureColumn(db, "sessions", "parent_session_key", "TEXT");
  ensureColumn(db, "sessions", "parent_session_id", "TEXT");

  ensureColumn(db, "steps", "input_tokens",       "INTEGER");  // usage.input on MODEL_THINK / REPLY
  ensureColumn(db, "steps", "cache_read_tokens",  "INTEGER");  // usage.cacheRead on MODEL_THINK / REPLY
  ensureColumn(db, "steps", "thinking_text_len",  "INTEGER");  // chars in content[].type='thinking'
  ensureColumn(db, "steps", "reply_text_len",     "INTEGER");  // full chars of REPLY text content

  // Indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_key) WHERE parent_session_key IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_parent_sid ON sessions(parent_session_id) WHERE parent_session_id IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_steps_session_run ON steps(session_key, run_id, seq)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_steps_ts ON steps(ts_epoch_ms)`);
  // Covers `WHERE session_key = ? ORDER BY ts_epoch_ms DESC LIMIT 1` which powers
  // recomputeAllSessionOps (hot loop). Without this, the OR-LIKE ancestor query
  // degraded to a full index scan and pegged CPU — see round-1 design doc.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_steps_session_ts ON steps(session_key, ts_epoch_ms DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_steps_skill ON steps(skill_name) WHERE skill_name IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_steps_script ON steps(script_name) WHERE script_name IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_steps_mcp ON steps(mcp_tool) WHERE mcp_tool IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_steps_error_type ON steps(error_type) WHERE error_type IS NOT NULL`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS registry (
      type            TEXT NOT NULL,
      name            TEXT NOT NULL,
      path            TEXT,
      discovered_at   TEXT,
      last_seen_at    TEXT,
      status          TEXT DEFAULT 'active',  -- active / stale / removed
      PRIMARY KEY (type, name)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ingest_state (
      file_path       TEXT PRIMARY KEY,
      byte_offset     INTEGER DEFAULT 0,
      session_key     TEXT,
      updated_at      TEXT
    )
  `);
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
