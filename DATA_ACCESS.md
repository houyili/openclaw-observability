# Data Access

All observability data is persisted in SQLite and can be queried directly
from the shell. This is the operator runbook for reading the local store.

## Database Location

```text
~/.openclaw/logs/observability-v2/obs.db
~/.openclaw/logs/observability-v2/obs.db-wal
~/.openclaw/logs/observability-v2/obs.db-shm
```

SQLite runs in WAL mode. Keep the `-wal` and `-shm` files next to the DB.

## Schema At A Glance

| table | purpose |
| --- | --- |
| `sessions` | one row per `(session_key, session_id)` pair |
| `steps` | parsed transcript steps: model, tool, MCP, skill, reply, errors |
| `registry` | observed skills, scripts, and MCP tools |
| `ingest_state` | transcript watcher bookkeeping |

Important `sessions` fields:

- `token_source`: `official`, `official-zero`, or `transcript-backfill`.
- `parent_session_key` / `parent_session_id`: runtime lineage.
- `diag_state`, `current_op`, `blocker`: live diagnostic projection.

Important `steps` fields:

- `step_id`, `session_key`, `session_id`, `run_id`, `seq`.
- `node_type`, `tool_name`, `status`, `error_type`.
- `input_tokens`, `cache_read_tokens`, `thinking_text_len`,
  `reply_text_len` for Context Length analysis.

## Quick Queries

```bash
sqlite3 ~/.openclaw/logs/observability-v2/obs.db

sqlite3 ~/.openclaw/logs/observability-v2/obs.db \
  "SELECT session_key, session_id, diag_state, token_source, updated_at
   FROM sessions ORDER BY updated_at DESC LIMIT 10"
```

Current or stuck work:

```sql
SELECT session_key, session_id, node_type, tool_name, ts, error_text
FROM steps
WHERE is_current = 1 OR is_stuck = 1
ORDER BY ts_epoch_ms DESC;
```

Parent-child runtime lineage:

```sql
SELECT session_key, session_id, parent_session_key, parent_session_id, label
FROM sessions
WHERE parent_session_key IS NOT NULL OR parent_session_id IS NOT NULL
ORDER BY updated_at DESC;
```

Token backfill audit:

```sql
SELECT token_source, COUNT(*)
FROM sessions
GROUP BY token_source;
```

## HTTP API

```bash
curl http://127.0.0.1:18902/healthz
curl http://127.0.0.1:18902/api/summary
curl http://127.0.0.1:18902/api/sessions
curl http://127.0.0.1:18902/api/sessions/ENCODED_KEY/prompt-check
curl http://127.0.0.1:18902/api/sessions/ENCODED_KEY/workflow
curl http://127.0.0.1:18902/api/sessions/ENCODED_KEY/trace
curl http://127.0.0.1:18902/api/sessions/ENCODED_KEY/context
curl http://127.0.0.1:18902/api/skills?range=all
curl http://127.0.0.1:18902/api/scripts?range=all
curl http://127.0.0.1:18902/api/mcps?range=all
curl http://127.0.0.1:18902/api/registry
```

`/prompt-check`, `/workflow`, `/trace`, and `/context` accept optional `runId` and
`sessionId` query parameters.

## Correctness Checks

```bash
npm run test:hermetic
npm run test:integrity
npm run test:live-e2e
npm run test:replay
npm run test:cross-check -- --retry-wait 0
npm run test:perf
```

The live checks compare clean transcript replays, the SQLite store, HTTP
API output, and official OpenClaw CLI session data.
