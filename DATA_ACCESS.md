# Data Access — CLI & Direct Query

All observability data is persisted in SQLite and can be queried directly
from the shell. This file is the canonical operator runbook for reading the
historical data store. See `README.md` for install / run instructions and
the correctness test suites, and
`agents_design_doc/observability/round*.md` for architectural history.

## Database Location

```
~/.openclaw/logs/observability-v2/obs.db
~/.openclaw/logs/observability-v2/obs.db-wal     # SQLite WAL — do not move
~/.openclaw/logs/observability-v2/obs.db-shm     # SQLite shared memory — do not move
```

## Schema at a glance

| table         | rows  | purpose                                  |
|---------------|-------|------------------------------------------|
| `sessions`    | ~700  | one row per (session_key, session_id) pair, fed by `auth-poller` + `recomputeSessionCounts` |
| `steps`       | ~20k  | every parsed transcript entry — MODEL_THINK, TOOL_CALL, MCP_CALL, SKILL_EXEC, REPLY, ... |
| `registry`    | ~110  | every skill/script/MCP we've ever seen, with status active/observed/removed |
| `ingest_state`| ~300  | `(file_path → session_key + byte_offset)` — watcher bookkeeping |

`PRAGMA journal_mode=WAL`. The WAL file can be 1–5 MB in steady state, that
is normal.

## Quick Access

```bash
# Open interactive shell
sqlite3 ~/.openclaw/logs/observability-v2/obs.db

# One-liner queries
sqlite3 ~/.openclaw/logs/observability-v2/obs.db "SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 10"
```

## Tables

### sessions
Session inventory. Token values match the official OpenClaw dashboard.

```sql
-- All active sessions
SELECT session_key, label, channel, kind, model, total_tokens, context_tokens,
       llm_call_count, tool_call_count, skill_call_count, mcp_call_count,
       diag_state, current_op, runtime_mode
FROM sessions ORDER BY updated_at DESC;

-- Sessions by channel
SELECT * FROM sessions WHERE channel = 'feishu-group';
```

### steps
Every execution step from transcript parsing. This is the raw data for traces, P95 calculations, and all Tab 2-4 aggregations.

```sql
-- Latest run for a session
SELECT * FROM steps
WHERE session_key = 'agent:main:feishu:group:oc_6da432...'
ORDER BY ts_epoch_ms DESC LIMIT 50;

-- All errors
SELECT ts, session_key, tool_name, error_type, error_text
FROM steps WHERE status = 'error' ORDER BY ts_epoch_ms DESC;

-- P95 duration for MCP calls
SELECT mcp_tool, COUNT(*) as calls,
       AVG(duration_ms) as avg_ms
FROM steps WHERE node_type = 'MCP_CALL' AND duration_ms IS NOT NULL
GROUP BY mcp_tool ORDER BY calls DESC;

-- Stuck operations (>60s)
SELECT * FROM steps WHERE is_stuck = 1 ORDER BY ts_epoch_ms DESC;
```

### registry
All known skills, scripts, and MCP tools. Includes removed/stale entries for history.

```sql
-- All registered items
SELECT type, name, status, path FROM registry ORDER BY type, name;

-- Removed skills (historical)
SELECT * FROM registry WHERE status = 'removed';
```

### ingest_state
Transcript file read offsets (internal bookkeeping).

```sql
SELECT file_path, byte_offset, session_key FROM ingest_state;
```

## HTTP API

All data is also available via HTTP at `http://127.0.0.1:18902`:

```bash
curl http://127.0.0.1:18902/api/sessions
curl http://127.0.0.1:18902/api/sessions/ENCODED_KEY/trace
curl http://127.0.0.1:18902/api/summary
curl http://127.0.0.1:18902/api/skills?range=all
curl http://127.0.0.1:18902/api/scripts?range=all
curl http://127.0.0.1:18902/api/mcps?range=all
curl http://127.0.0.1:18902/api/registry
curl http://127.0.0.1:18902/healthz
```

When `OBS_AUTH_TOKEN` is set, all `/api/*` endpoints require
`Authorization: Bearer <token>` or `?token=<token>`. Static assets and
`/healthz` are exempt. Localhost is always exempt.

## Correctness verification from the shell

Two one-liners you can run any time to prove the DB is trustworthy.

### "Does the DB match the official dashboard, to the token?"

```bash
./tests/run-all.sh          # runs every suite, exits non-zero on any drift
# or just the ground-truth diff:
node --experimental-sqlite --experimental-strip-types --no-warnings \
  tests/cross-check-official.ts
```

Expected output ends with

```
RESULT: PASS — every overlapping session matches within tolerance
```

### "Does every currently-existing transcript match what the watcher ingested?"

```bash
node --experimental-sqlite --experimental-strip-types --no-warnings \
  tests/replay-verify.ts
```

Reads every `.jsonl` on disk, reparses it from scratch, and compares
per-`run_id` step counts to `obs.db`. PASS = the parser and the watcher
agree, byte for byte, on everything currently stored.

## Useful ad-hoc queries

```sql
-- Top 10 longest-running tool calls ever
SELECT tool_name, duration_ms / 1000 AS seconds,
       session_key, datetime(ts_epoch_ms / 1000, 'unixepoch', 'localtime') AS when_
FROM steps WHERE duration_ms IS NOT NULL ORDER BY duration_ms DESC LIMIT 10;

-- Error breakdown over the last day
SELECT error_type, COUNT(*) AS n
FROM steps WHERE ts_epoch_ms >= (strftime('%s','now')*1000 - 86400000) AND status = 'error'
GROUP BY error_type ORDER BY n DESC;

-- Total tokens ingested per agent, this week
SELECT agent_id, SUM(total_tokens) AS tokens
FROM sessions GROUP BY agent_id ORDER BY tokens DESC;

-- Sessions the dashboard thinks are stuck
SELECT session_key, blocker,
       (strftime('%s','now')*1000 - last_block_ts) / 1000 AS stuck_seconds
FROM sessions WHERE diag_state = 'stuck' ORDER BY stuck_seconds DESC;
```

## Health signals

```bash
curl -s http://127.0.0.1:18902/healthz
# {"ok":true,"updatedAt":"...","sessions":N,"steps":M}
```

If `sessions` or `steps` is 0, either the DB is empty or the service just
restarted — wait 5 seconds and retry. If still 0 on a live machine, check
`~/.openclaw/logs/observability-v2/stderr.log` for auth-poller failures.
