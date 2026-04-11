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

| table         | rows   | purpose                                  |
|---------------|--------|------------------------------------------|
| `sessions`    | ~740   | one row per (session_key, session_id) pair, fed by `auth-poller` + `recomputeSessionCounts` |
| `steps`       | ~22k   | every parsed transcript entry — MODEL_THINK, TOOL_CALL, MCP_CALL, SKILL_EXEC, REPLY, … |
| `registry`    | ~110   | every skill/script/MCP we've ever seen, with status active/observed/removed |
| `ingest_state`| ~300   | `(file_path → session_key + byte_offset)` — watcher bookkeeping |

`PRAGMA journal_mode=WAL`. The WAL file can be 1–5 MB in steady state, that
is normal.

### Round 6 — Context Length columns on `steps`

Round 6 added 4 nullable columns that power the `/api/sessions/:key/context`
view. Each is set ONLY on the row that semantically owns it:

| column              | type    | set on                                  | meaning |
|---------------------|---------|-----------------------------------------|---------|
| `input_tokens`      | INTEGER | MODEL_THINK + REPLY                     | `usage.input` from the assistant message |
| `cache_read_tokens` | INTEGER | MODEL_THINK + REPLY                     | `usage.cacheRead` from the assistant message |
| `thinking_text_len` | INTEGER | MODEL_THINK (or REPLY when text-only)   | char length of `content[].type='thinking'` blocks |
| `reply_text_len`    | INTEGER | REPLY                                   | full char length of `content[].type='text'` content |

Tool-call rows have NULL `input_tokens` and `cache_read_tokens` — the LLM
API does not break input down per tool. Existing rows ingested before
the migration also have NULL until the next service restart triggers
Round 4's first-tick reparse (which heal-backfills them in place).

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
curl http://127.0.0.1:18902/api/sessions/ENCODED_KEY/context     # Round 6 — Context Length view
curl http://127.0.0.1:18902/api/summary
curl http://127.0.0.1:18902/api/skills?range=all
curl http://127.0.0.1:18902/api/scripts?range=all
curl http://127.0.0.1:18902/api/mcps?range=all
curl http://127.0.0.1:18902/api/registry
curl http://127.0.0.1:18902/healthz
```

`/api/sessions/{key}/context?runId=<optional>` returns
`{ sessionKey, runId, breakdown, timeline, runs }`. `breakdown` is the
coarse 5-bucket decomposition; `timeline` is the fine-grained per-turn
analysis with phases, top-N spikes, cumulative aggregates, and
`loopFlags.healthVerdict ∈ {healthy, suspect, stuck}`.

When `OBS_AUTH_TOKEN` is set, all `/api/*` endpoints require
`Authorization: Bearer <token>` or `?token=<token>`. Static assets and
`/healthz` are exempt. Localhost is always exempt.

## Correctness verification from the shell

Seven one-liners, each answering a different correctness question.

### "Does the DB match the official dashboard, to the token?"

```bash
npm run test:cross-check
```

Pulls `openclaw sessions --all-agents --active 60 --json` and diffs every
returned `(session_key, sessionId)` against obs.db. Constitution §1.3.1.
Expected tail:

```
RESULT: PASS — every overlapping session matches within tolerance
```

### "Does every currently-existing transcript match what the watcher ingested?"

```bash
npm run test:replay
```

Reads every `.jsonl` on disk, reparses it from scratch, and compares
per-`run_id` step counts to obs.db. PASS = the parser and the watcher
agree, byte for byte, on everything currently stored.

### "Are the schema and value invariants holding on the live DB?"

```bash
npm run test:integrity
```

49 assertions: enum guards on `node_type / status / role / error_type`,
no NULLs in non-nullable columns, no negative durations, error rows have
`error_text`, every `source='transcript+auth'` session base key has
matching steps, `/api/sessions / /api/summary / /healthz` cross-check
against direct SQL, plus the **Round 6 Context Length live invariant**
`frameworkBaseline + Σ Δᵢ == totalLatest` (sampled across 5 runs).

### "Does our biggest live session round-trip end-to-end?"

```bash
npm run test:live-e2e
```

Picks the top 3 non-cron sessions in obs.db by step count, walks each
transcript file → clean parse → DB → `openclaw sessions --json` → HTTP
API trace. 17 assertions including step_id parity per run_id, trace-
span-set parity, and a Round 6 `observ_cli status` spawn check against
the live DB.

### "Does the Context Length view compute correct numbers?"

```bash
npm run test:context-length
```

86 hermetic assertions across 6 groups: schema migration idempotency,
parser populates all 4 new fields correctly, coarse `getContextBreakdown`
arithmetic against a hand-derived 4-turn fixture, fine-grained
`getContextTimeline` per-turn rows + cumulative aggregates + top spikes,
death-loop heuristic detection (a synthetic 12-turn read-only loop is
correctly flagged `healthVerdict='stuck'`), HTTP route shape via direct
handler call.

### "Do the channel CLI commands work?"

```bash
npm run test:cli-commands
```

86 hermetic assertions: every `/observ` subcommand handler against a
synthetic temp-DB fixture. Verifies exit codes, header format, expected
substrings, line counts, **no emojis**, **no Unicode box-drawing chars**
(Telegram strips them). Plus dispatcher edge cases.

### "Run everything"

```bash
npm test                # all 11 suites — needs live obs-v2 + transcripts
npm run test:hermetic   # only the 6 hermetic suites — runs on a clean clone
```

Any FAIL line tells you exactly which session / which step / which token
is off. See the README's **Data correctness** section for the full
catalogue.

## Useful ad-hoc queries

```sql
-- Round 6 — single biggest single-turn context jump across the whole DB
-- (the postmortem-style "where did context blow up" analysis, expressed
-- in plain SQL using the new input_tokens column)
WITH turns AS (
  SELECT
    session_key,
    run_id,
    input_tokens,
    LAG(input_tokens) OVER (PARTITION BY session_key, run_id ORDER BY seq) AS prev_input
  FROM steps
  WHERE node_type = 'MODEL_THINK' AND input_tokens IS NOT NULL
)
SELECT session_key, run_id, input_tokens - prev_input AS delta_in
FROM turns
WHERE prev_input IS NOT NULL
ORDER BY delta_in DESC
LIMIT 10;

-- Round 6 — sessions that look like they're in a death-loop
-- (high cache hit rate + many turns + tiny reply text)
SELECT session_key,
       SUM(input_tokens) AS total_in,
       SUM(cache_read_tokens) AS total_cR,
       CAST(SUM(cache_read_tokens) AS REAL) /
         NULLIF(SUM(input_tokens) + SUM(cache_read_tokens), 0) AS cache_hit,
       SUM(reply_text_len) AS reply_chars
FROM steps
WHERE input_tokens IS NOT NULL
GROUP BY session_key
HAVING cache_hit >= 0.85 AND reply_chars < 500
ORDER BY total_in DESC
LIMIT 10;

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
