# OpenClaw Observability v2

A self-hosted observability dashboard for the
[OpenClaw](https://github.com/) agent runtime. Shows every running session,
its current operation, blockers, token usage, skill / script / MCP
statistics, and a per-run execution trace — all derived from the raw
transcript JSONL that OpenClaw writes to disk.

**Design goals**

1. **Zero invasion.** Does not touch the OpenClaw process, its config, or
   any agent workspace. Runs as a standalone Node service that reads
   `~/.openclaw/agents/*/sessions/*.jsonl` and the `openclaw sessions --json`
   CLI output.
2. **Canonical correctness.** Token numbers must match the OpenClaw
   official dashboard exactly. This is enforced by an automated
   `cross-check` regression suite, not just asserted.
3. **Frugal on CPU.** Designed to sit on a laptop indefinitely. Steady
   state is < 2 % of one core on a 19 000-step database.
4. **Persist everything, prune nothing.** All ingested steps stay in SQLite
   forever; history from deleted transcripts is intentionally preserved.

The architectural rationale and iteration history live in
`agents_design_doc/observability/` (see `round1_...md`, `round2_...md`,
`round3_...md`).

---

## Requirements

| Thing                         | Version             |
|-------------------------------|---------------------|
| Node.js                       | ≥ 22 (uses `node:sqlite`) |
| OpenClaw CLI on PATH          | any                 |
| macOS / Linux                 | both tested         |

No npm dependencies — the service uses only the Node standard library
(`node:sqlite`, `node:http`, `node:child_process`). Browser UI is vanilla
HTML + CSS + JS, no build step.

## Install

```bash
# 1. Put the extension where OpenClaw expects it
git clone ... ~/.openclaw/extensions/observability-v2
cd ~/.openclaw/extensions/observability-v2

# 2. Bootstrap the local config files that are not checked in
cp .env.example .env
# edit .env to set OBS_AUTH_TOKEN (or leave empty to disable auth)

# 3. Run it once in the foreground to make sure your Node + OpenClaw are OK
npm run start
# → [observability-v2] http://127.0.0.1:18902

# 4. (macOS only) build the launchd plist from the template
cp com.openclaw.observability-v2.plist.template com.openclaw.observability-v2.plist
sed -i '' "s|__HOME__|$HOME|g"       com.openclaw.observability-v2.plist
sed -i '' "s|__NODE__|$(which node)|g" com.openclaw.observability-v2.plist

# 5. Install as a launchd service (macOS) for always-on
./scripts/service.sh install
./scripts/service.sh start
```

`.env` and `*.plist` are git-ignored — every checkout has to regenerate
them. The template files (`*.plist.template`, `.env.example`) are versioned
and are the source of truth for what keys exist.

### Optional: remote access via ngrok

```bash
python3 scripts/install_ngrok.py          # prompts for authtoken, stores in Keychain
./scripts/service.sh install-tunnel       # launchd KeepAlive for the tunnel
```

Both `com.openclaw.observability-v2` and `com.openclaw.ngrok-tunnel` are
KeepAlive launchd services. They survive laptop reboots.

## Configure

All configuration lives in `src/config.ts`:

| constant                   | default    | meaning                                 |
|----------------------------|------------|-----------------------------------------|
| `PORT`                     | 18902      | HTTP listener                            |
| `AUTH_POLL_MS`             | 30 000     | cadence for `openclaw sessions --json`  |
| `AUTH_ACTIVE_MINUTES`      | 240        | window passed to the CLI                |
| `TRANSCRIPT_POLL_MS`       | 2 000      | how often we scan transcript files      |
| `OTEL_POLL_MS`             | 15 000     | read tail of `events.jsonl`             |
| `RECOMPUTE_OPS_MS`         | 30 000     | current-op / blocker recompute cadence  |
| `EXTERNAL_TIMEOUT_MS`      | 30 000     | hard timeout on every external call     |
| `STUCK_THRESHOLD_MS`       | 60 000     | a step stuck longer than this is "stuck" (constitution §3.1) |

Authentication is opt-in via `.env`:

```
OBS_AUTH_TOKEN=<some-random-string>
```

When set, every non-local HTTP request must supply
`Authorization: Bearer <token>` or `?token=<token>`. Localhost is exempt
so the launchd service can always hit `/healthz`.

## Run the tests

```bash
npm test                   # all 9 suites — needs a live obs-v2 + transcripts
npm run test:hermetic      # only the 4 hermetic suites — clean clone, no live deps
npm run test:cross-check   # just the ground-truth diff vs openclaw CLI
```

`npm test` runs **9 suites with ~437 assertions** against the live obs-v2
service and the user's actual `~/.openclaw/agents/` transcripts.
`npm run test:hermetic` runs the 4 suites that have no host dependencies
(`unit + invariants + fixture + auth-stale`, ~119 assertions) — a fresh
`git clone` on a machine with only Node 22 installed can run these and
verify the parser + storage + auth-stale handling all work end-to-end.

See the **Data correctness** section below for what each suite proves.

## Data correctness

Nine test suites enforce correctness automatically. The four hermetic
ones run anywhere; the five live ones run against the user's real obs-v2
install.

### Hermetic suites (run on a clean clone)

#### 1. `unit` — `tests/run-tests.ts`

Hand-written assertions on the tool classifier, error classifier, and
basic `parseTranscript` output. **42 cases.**

#### 2. `invariants` — `tests/parser-invariants.test.ts`

Structural invariants on `parseTranscript`. **35 cases.**

- Run splitting on user messages
- MODEL_THINK duration = assistant_ts − prev_entry_ts
- **FIFO back-linking with parallel tool calls** (the one most likely
  to silently corrupt)
- Tool duration = result_ts − call_ts
- `context_token_delta = this.usage.input − prev.usage.input`
- Per-tool token approximation + bounded rounding drift
- Idempotent parse (same input → same output)
- Error propagation from `toolResult` → `toolCall`
- Step ordering: dense seq, monotone ts_epoch_ms, unique step_ids
- Edge cases: empty assistant, thinking-only, orphan-entries-before-user

#### 3. `fixture` — `tests/fixture-ingest.test.ts`

Hermetic end-to-end: a 9-entry synthetic transcript checked into
`tests/fixtures/transcripts/` is parsed, upserted into a temp SQLite DB
at `OPENCLAW_HOME=$tmpdir`, and verified with **22 assertions**:

- correct number of runs and per-run step counts
- parallel tool-call FIFO back-linking duration is correct
- MCP classification (server, tool name)
- token totals match the last assistant's `usage.totalTokens`
- 12 step rows after first upsert; **still 12** after re-upsert
  (`ON CONFLICT DO UPDATE` is idempotent)
- `EXPLAIN QUERY PLAN` confirms the latest-step query uses
  `idx_steps_session_ts`

#### 4. `auth-stale` — `tests/auth-stale.test.ts`

End-to-end verification of the `/healthz` + frontend "auth-poll stale"
pill, **20 assertions** in three layers, all hermetic:

- **Layer 1** (pure): loads `src/frontend/health-indicator.js` via
  Node's `vm` module and asserts `computeRefreshIndicator(healthData)`
  returns the right pill text + class for fresh / stale / never-polled
  / missing-payload / long-error inputs. Same file the browser loads
  via `<script>`, so one source of truth.
- **Layer 2** (auth-poller under broken CLI): spawns a child Node
  process with `PATH=$tmpdir/fake-bin:$PATH` where `fake-bin/openclaw`
  is a 3-line script that exits 1. The child dynamically imports
  `auth-poller.ts`, fires one poll, asserts `getAuthPollStatus()`
  captured the failure.
- **Layer 3** (`/healthz` shape): same child constructs a mock
  `ServerResponse`, calls `handleHealthRoute`, asserts
  `authPoll.stale === true` and `lastError` carries the message.

### Live suites (run against the user's real obs-v2)

#### 5. `integrity` — `tests/data-integrity.test.ts`

Schema + value invariants over the live `obs.db`. **44 assertions.**
Found and fixed 1 real bug on its first run.

- **Whole-table sanity**: no NULLs in non-nullable columns; `node_type
  / status / role / error_type` are members of the enumerated sets;
  every `status='error'` row has an `error_text`; `duration_ms ≥ 0`;
  `step_id` globally unique; every `skill_name` referenced in steps
  exists in registry.
- **Per-run integrity** (top 5 longest runs): step_ids unique within
  run; `seq` monotone; `ts_epoch_ms` monotone in seq order; first step
  has `role='assistant'`.
- **Cross-table integrity**: every `source='transcript+auth'` session
  base key MUST have steps (this is the invariant that caught the
  Round 5 bug); session base keys overlap with step base keys.
- **HTTP API consistency** (when service up): `/api/sessions` totals
  match SQL; `/api/summary tools` count matches SQL aggregate;
  `/healthz steps` matches SQL.

#### 6. `live-e2e` — `tests/live-e2e.test.ts`

End-to-end correctness against the user's actual production sessions.
**14 assertions.**

- Picks the top 3 non-cron sessions by current step count, locates each
  underlying transcript via `ingest_state`, clean-parses it, and
  verifies per-run-id parity: same `run_id` set, same step count, same
  `step_id` set, same first/last `ts_epoch_ms`.
- Picks the largest active session from `openclaw sessions --json` and
  asserts obs.db's tokens match the CLI's tokens **to the token**, plus
  obs.db's latest step is within 10 minutes of the CLI's `updatedAt`.
- HTTP API roundtrip on the same top session: `GET /api/sessions/{key}`
  detail consistent with SQL, `GET /api/sessions/{key}/trace` span
  count = assistant-row count for that run (toolResult rows are folded
  into their matching toolCall in the trace view), every span's `id`
  exists in obs.db as an assistant row, `GET /api/summary` `runs`
  matches `COUNT(DISTINCT run_id)`.

#### 7. `replay` — `tests/replay-verify.ts`

For every transcript file that currently exists on disk, clean-parse it
from scratch with the current parser and compare per-`run_id` step counts
to what is in `obs.db`. The test respects the "persist everything" design:
historical steps from deleted transcripts are ignored because we scope by
`run_id` (a globally-unique UUID of the user-message entry) rather than
by session_key aggregates.

Failure modes distinguished:

- `MISSING` — run_id exists in a current file but has 0 rows in DB
- `DROPPED` — DB has fewer steps than the clean parse
- `EXTRA`   — DB has more steps than the clean parse

DROPPED runs whose source-file mtime is within `RACE_MTIME_GRACE_MS`
(8 s) of "now" are forgiven as live-write races. There is no per-run
cap, so N concurrent active sessions all race-forgiven correctly.

#### 8. `cross-check` — `tests/cross-check-official.ts`

The **ground truth** suite. Runs `openclaw sessions --all-agents --active
N --json` and diffs `input_tokens`, `output_tokens`, `total_tokens` against
`obs.db` for every returned `(session_key, sessionId)` composite. This is
the concrete enforcement of constitution §1.3.1 ("主表数值必须与 OpenClaw
官方 Dashboard 保持一致").

Has a `--retry-wait 35` option: if the first pass sees a mismatch, sleep
past one auth-poll cycle and re-check. Only fail if drift persists.

#### 9. `perf` — `tests/perf-bench.ts`

Wall-clock + CPU budget for the hot paths. Current measurements on a
~22 000-step DB:

```
recomputeAllSessionOps       ~5 ms   (budget 250)
recomputeAllSessionCounts    ~5 ms   (budget 500)
getSkillStats('week')        ~1 ms   (budget 100)
getScriptStats('week')       ~1 ms   (budget 100)
getMcpStats('week')          ~2 ms   (budget 100)
getSummaryStats             ~20 ms   (budget 200)
```

## Troubleshooting

### The service is at 90 % CPU

This was the Round 1 baseline — the hot loop did 1 164 full-index-scan
aggregates every 5 s. Fix landed in Round 1. If you see it again:

```bash
sqlite3 ~/.openclaw/logs/observability-v2/obs.db \
  "EXPLAIN QUERY PLAN SELECT tool_name FROM steps WHERE session_key = ? ORDER BY ts_epoch_ms DESC LIMIT 1;"
# Should show:  SEARCH steps USING INDEX idx_steps_session_ts (session_key=?)
```

If the plan says `SCAN`, the index is missing — re-run the service once
to trigger `migrate()`.

### `auth-poller` keeps logging "Failed"

The CLI itself is broken on your box. Check:

```bash
openclaw sessions --all-agents --active 240 --json | head
```

If that hangs or errors, the openclaw gateway is unhealthy — restart it
before expecting the cross-check suite to pass.

### obs.db disagrees with the official dashboard on a newly-spawned session

Run the cross-check with the retry-wait option (it's the default):

```bash
npm run test:cross-check
```

The first pass + 35 s retry will absorb any natural lag between the CLI
and the 30 s auth-poll cadence.

### Clean-room replay needed after a parser bug fix

A process restart automatically triggers a first-tick full reparse of
every currently-existing file, which heals historical data without
touching older (deleted-file) history:

```bash
./scripts/service.sh restart
./scripts/run-all.sh    # should be green
```

## Design philosophy

- **Transcript JSONL is ground truth.** OTel events are advisory. If the
  two disagree, the transcript wins.
- **Parser output is the only place correctness is asserted.** Everything
  downstream (sessions-repo, HTTP API, frontend) treats `ParsedStep` as
  trusted and renders what it's given.
- **Every external call has a hard timeout.** Per the constitution.
- **No feature flags.** Config is a single `src/config.ts` and it stays
  readable.
- **Historical data is never pruned** from `steps`. The schema has no
  TTL. If you want to trim, do it manually with `DELETE FROM steps WHERE
  ts_epoch_ms < ?` and vacuum.

## HTTP API

See `DATA_ACCESS.md` for direct-SQL access patterns and the endpoint
catalogue.

## License

TBD — no license file yet. Do not redistribute until this is resolved.
