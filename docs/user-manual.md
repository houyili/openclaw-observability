# User Manual

This is the public operating manual for OpenClaw Observability. It is written
for a fresh clone of the standalone `openclaw-observability` repository and
for the standard extension path:

```text
~/.openclaw/extensions/observability-v2
```

The dashboard is local-first. It reads OpenClaw transcript JSONL files,
combines them with `openclaw sessions --json`, stores a derived SQLite view,
and serves a browser UI for session health, token usage, Prompt Check,
Workflow Graph, raw trace, and Context Length.

It does not send telemetry to a hosted service and does not call an LLM while
building observability views.

## Quick Start

Clone the repository into the standard OpenClaw extension path:

```bash
git clone https://github.com/houyili/openclaw-observability.git \
  ~/.openclaw/extensions/observability-v2
cd ~/.openclaw/extensions/observability-v2
```

Run the interactive installer:

```bash
./scripts/install.sh
```

Open [http://127.0.0.1:18902](http://127.0.0.1:18902).

To preview the installer without writing files or starting a service:

```bash
./scripts/install.sh --dry-run --yes --no-start
```

Foreground mode is available when you do not want a user service:

```bash
cp .env.example .env
npm run start
```

## Requirements

| Requirement | Notes |
| --- | --- |
| Node.js | 22 or newer; required for `node:sqlite` and TypeScript stripping |
| OpenClaw CLI | `openclaw` must be on `PATH` for live session inventory |
| curl | used by installer and health checks |
| git | required for normal clone and upgrade flow |
| macOS | primary service path uses user launchd |
| Linux | supported through foreground mode or user systemd |

The project has no npm package dependencies and no build step.

## Installer Flow

`scripts/install.sh` is the recommended entry point. It:

1. Checks Node.js, `openclaw`, `curl`, and `git`.
2. Creates `.env` from `.env.example` when missing.
3. Optionally prompts for `OBS_AUTH_TOKEN`.
4. Explains the service file it will write.
5. Installs a user-level service on macOS or Linux.
6. Starts the service unless `--no-start` is provided.
7. Checks `http://127.0.0.1:18902/healthz`.

Installer options:

| Option | Effect |
| --- | --- |
| `--dry-run` | prints actions without writing files or starting services |
| `--yes` | accepts recommended prompts; skips the token prompt |
| `--no-start` | writes config/service files but does not start the service |
| `--help` | prints the script help |

The installer only writes user-owned files:

| Platform | Files |
| --- | --- |
| macOS | `.env`, `~/Library/LaunchAgents/com.openclaw.observability-v2.plist`, `~/.openclaw/logs/observability-v2/` |
| Linux | `.env`, `~/.config/systemd/user/openclaw-observability.service`, `~/.openclaw/logs/observability-v2/` |

It does not require root permissions.

## Service Management

Use the high-level lifecycle scripts for normal operation:

```bash
./scripts/doctor.sh
./scripts/upgrade.sh
./scripts/uninstall.sh
```

Use the lower-level service helper when you need direct control:

```bash
./scripts/service.sh status
./scripts/service.sh restart
./scripts/service.sh logs
./scripts/service.sh stop
./scripts/service.sh start
```

macOS service file:

```text
~/Library/LaunchAgents/com.openclaw.observability-v2.plist
```

Linux service file:

```text
~/.config/systemd/user/openclaw-observability.service
```

Both generated service files are machine-specific runtime files and must not be
committed.

## Upgrade

Run:

```bash
./scripts/upgrade.sh
```

The upgrade helper:

1. Verifies that this directory is a standalone git checkout.
2. Refuses to continue when the working tree is dirty.
3. Runs `git pull --ff-only`.
4. Regenerates the launchd plist or systemd user unit.
5. Restarts the user service after confirmation.
6. Checks `/healthz`.

Preview mode:

```bash
./scripts/upgrade.sh --dry-run
```

If you keep local edits, commit or stash them before upgrading.

## Uninstall

Run:

```bash
./scripts/uninstall.sh
```

By default this removes only the user-level service. It preserves `.env`,
logs, the SQLite database, source transcripts, and the git checkout.

Optional destructive choices are always prompted unless you pass explicit
flags:

| Option | Effect |
| --- | --- |
| `--remove-env` | removes local `.env` |
| `--purge-data` | removes `~/.openclaw/logs/observability-v2/` |
| `--remove-repo` | removes this git checkout |
| `--dry-run` | prints actions without deleting files |

The SQLite database is a derived cache. Source transcripts live under
`~/.openclaw/agents/<agent>/sessions/` and are not deleted by the default
uninstall flow.

## Doctor

Run:

```bash
./scripts/doctor.sh
```

`doctor.sh` is read-only. It checks:

- Node.js version
- `git`, `curl`, and `openclaw` on `PATH`
- `.env` presence and git tracking status
- whether generated plist, DB, or log files are tracked by git
- user service status
- local `/healthz`
- port listener on `18902` when `lsof` is available

Use this first when installation, upgrade, or remote access feels wrong.

## Configuration

Runtime configuration lives in `.env`, which is copied from `.env.example` and
is intentionally ignored by git.

Common keys:

| Key | Purpose |
| --- | --- |
| `OBS_AUTH_TOKEN` | Optional bearer token for non-local API requests |
| `OBS_ALLOW_UNAUTH_TUNNEL` | Defaults to `0`; set to `1` only for a temporary unauthenticated tunnel demo |
| `OBS_NGROK_DOMAIN` | Optional fixed ngrok domain |
| `OBS_FIXED_URL` | Optional public URL shown by tunnel helpers |

Values may be quoted or unquoted.

Localhost access, static files, and `/healthz` do not require a token. When
`OBS_AUTH_TOKEN` is set, non-local `/api/*` requests require authentication.
Prefer one of these forms:

```text
Authorization: Bearer <token>
https://example.example/#token=<token>
```

The frontend reads `#token=...` from the browser fragment and uses it for API
calls. Query-string `?token=...` remains accepted for compatibility, but avoid
it for shared tunnel URLs because query strings can appear in logs and history.

Tunnel helpers refuse to expose or return a public URL without
`OBS_AUTH_TOKEN` unless `OBS_ALLOW_UNAUTH_TUNNEL=1` is set explicitly.

## Dashboard Views

### Summary

The top row shows fleet-wide counts, token totals, current operations, stuck
sessions, recent errors, registry statistics, and auth-poll freshness.

The health indicator is green when the OpenClaw session inventory has refreshed
recently. It turns stale when `openclaw sessions --json` has not succeeded
within the configured threshold. Transcript-derived trace data can still be
fresh while inventory fields such as model or official token totals are stale.

### Sessions

The Sessions table shows one row per `(session_key, session_id)` with:

- agent and channel
- label and kind
- parent/child lineage
- diagnostic state
- current operation and blocker
- token source and token totals
- model and activity timeline

Filters support agent, channel, state, diagnostic state, label, and text
search.

Expanding a session renders stacked detail sections:

1. Prompt Check
2. Workflow Graph
3. Workflow trace
4. Context length

The run selector lets you switch between recent runs for the same session.

### Prompt Check

Prompt Check evaluates generic workflow rules from `config/prompt-rules.json`
against transcript evidence, Workflow Graph events, and optional hook reminder
events. It can warn about missing checkpoints before yield, missing child
visibility after spawn, or workflow-state gaps.

Prompt Check does not call an LLM and does not mutate runtime state.

### Workflow Graph

Workflow Graph is a deterministic swimlane projection over:

- user messages
- parent session steps
- OpenClaw runtime coordination
- child session summaries
- optional managed workflow state

Each graph event carries provenance such as `step_id`, `run_id`,
`childSessionKey`, `flow_id`, or `artifact_path` when available. Missing
managed workflow evidence is rendered as an explicit gap instead of being
inferred.

Public labels are generic: `User`, `Parent Session`, `OpenClaw Runtime`,
`Child Session`, and `Workflow State`. Older transcript or compatibility
signals may still be parsed, but private agent names are not part of the public
UI contract.

### Workflow Trace

Workflow trace is the raw per-run waterfall from transcript-derived steps. It
is useful when you need to inspect exact tool calls, durations, result
previews, errors, and token usage.

### Context Length

Context Length explains how prompt context changed across a run. It includes:

- coarse buckets for baseline, assistant output, tool-result inflow, MCP
  inflow, and unaccounted context
- per-turn timeline with input, cache-read, output, previous tool-result
  characters, and thinking characters
- phase labels and top single-point spikes
- health verdicts for suspected repetitive loops

The endpoint is:

```text
GET /api/sessions/:key/context?runId=<optional>&sessionId=<optional>
```

## Remote Access

The dashboard is local-first. Keep it on `127.0.0.1:18902` unless you need
remote access.

Before opening a tunnel, configure an auth token:

```bash
$EDITOR .env
./scripts/service.sh restart
```

Then choose one tunnel option.

Cloudflare Quick Tunnel:

```bash
./scripts/tunnel.sh start
./scripts/tunnel.sh url
```

ngrok fixed domain:

```bash
python3 scripts/install_ngrok.py
./scripts/tunnel-ngrok.sh start
./scripts/tunnel-ngrok.sh url
```

Both tunnel helpers refuse to expose or return a public URL unless
`OBS_AUTH_TOKEN` is set. For a temporary unauthenticated demo, explicitly set
`OBS_ALLOW_UNAUTH_TUNNEL=1`; do not use that for shared, public, or long-lived
tunnels.

The returned sharing URL uses `#token=...`, not `?token=...`, so the token
stays in the browser fragment instead of the HTTP request line.

For managed Cloudflare Named Tunnels, see [Cloudflare tunnel](install/cloudflare.md).
For ngrok token/domain setup details, see [macOS install](install/macos.md) or
[Linux install](install/linux.md). For other tunnel providers, set
`OBS_FIXED_URL` in `.env`.

## CLI Bridge

The `scripts/observ_cli.ts` bridge exposes compact status commands that can be
called from shells or chat-channel integrations:

| Command | Purpose |
| --- | --- |
| `/observ status` | service, DB, auth-poll, stuck count, recent errors |
| `/observ stuck` | currently stuck sessions |
| `/observ top` | highest-token sessions in the recent window |
| `/observ skills [day\|week\|month]` | top skills |
| `/observ scripts [day\|week\|month]` | top scripts |
| `/observ mcps [day\|week\|month]` | top MCP tools with error rates |
| `/observ errors` | recent errors |
| `/observ help` | command list |

The bridge reads the same local SQLite store as the dashboard. It does not call
an LLM.

## Data Access

Main data locations:

| Path | Purpose |
| --- | --- |
| `~/.openclaw/agents/<agent>/sessions/*.jsonl` | transcript source files |
| `~/.openclaw/logs/observability-v2/obs.db` | local SQLite projection |
| `~/.openclaw/logs/observability-v2/stdout.log` | service output |
| `~/.openclaw/logs/observability-v2/stderr.log` | service errors |

Canonical transcript files are ingested. Sidecar files such as `.acp-stream`,
`.checkpoint.*.jsonl`, and `.trajectory.jsonl` are skipped so replay and live
counts share the same source-of-truth boundary.

Official nonzero token totals from `openclaw sessions --json` are treated as
authoritative. If official totals are zero but transcript `usage` fields exist,
session rows use `tokenSource: "transcript-backfill"` so the fallback is
visible instead of silently changing the contract.

Direct SQLite access is documented in [DATA_ACCESS.md](../DATA_ACCESS.md).

## Public API

Common local API calls:

```bash
curl http://127.0.0.1:18902/healthz
curl http://127.0.0.1:18902/api/summary
curl http://127.0.0.1:18902/api/sessions
curl http://127.0.0.1:18902/api/sessions/ENCODED_KEY/prompt-check
curl http://127.0.0.1:18902/api/sessions/ENCODED_KEY/workflow
curl http://127.0.0.1:18902/api/sessions/ENCODED_KEY/trace
curl http://127.0.0.1:18902/api/sessions/ENCODED_KEY/context
```

For remote API calls with auth:

```bash
curl -H "Authorization: Bearer $OBS_AUTH_TOKEN" \
  https://example.example/api/sessions
```

Encode session keys before placing them in the URL path. The workflow endpoint
returns:

```text
{ lanes, events, edges, diagnostics, runs }
```

## Tests

Clean-clone and CI checks:

```bash
npm run test:hermetic
npm run test:open-source-sanitization
bash -n scripts/*.sh
python3 -m py_compile scripts/install_ngrok.py
```

Live checks, run on a machine with OpenClaw transcripts and the dashboard
service available:

```bash
npm run test:integrity
npm run test:live-e2e
npm run test:replay
npm run test:cross-check -- --retry-wait 0
npm run test:perf
```

`npm test` runs both hermetic and live suites. Use `npm run test:hermetic` for
CI and fresh clones.

## Troubleshooting

### Dashboard does not open

```bash
./scripts/doctor.sh
./scripts/service.sh status
./scripts/service.sh logs
./scripts/service.sh restart
curl http://127.0.0.1:18902/healthz
```

If foreground mode works but the service does not, check the generated service
file with:

```bash
./scripts/service.sh check
```

On Linux use:

```bash
./scripts/service.sh check-systemd
```

### Installer says Node.js is too old

Install Node.js 22 or newer and make sure the service environment can find it.
For launchd/systemd, regenerate the service file after updating Node:

macOS:

```bash
./scripts/service.sh generate-plist
./scripts/service.sh restart
```

Linux:

```bash
./scripts/service.sh generate-systemd
./scripts/service.sh restart
```

### OpenClaw CLI is missing

The dashboard can start without live inventory, but session metadata and
official token totals will be stale until `openclaw` is available on `PATH`.
Fix the OpenClaw CLI first, then restart the service.

### Health indicator is stale

Run the OpenClaw inventory command directly:

```bash
openclaw sessions --all-agents --active 240 --json | head
```

If that command fails, fix the OpenClaw CLI or gateway first. If it succeeds
but the dashboard remains stale, inspect:

```bash
tail -30 ~/.openclaw/logs/observability-v2/stderr.log
```

### Data looks wrong

Run the correctness suites:

```bash
npm run test:integrity
npm run test:replay
npm run test:cross-check -- --retry-wait 0
```

Use `npm run test:hermetic` first if you want to rule out parser, storage, and
UI regressions without touching live data.

### Context is growing unexpectedly

Open the session detail and inspect Context Length. For a direct query:

```sql
SELECT session_key,
       SUM(input_tokens) AS total_in,
       CAST(SUM(cache_read_tokens) AS REAL) /
         NULLIF(SUM(input_tokens) + SUM(cache_read_tokens), 0) AS cache_hit,
       SUM(reply_text_len) AS reply_chars
FROM steps
WHERE input_tokens IS NOT NULL
GROUP BY session_key
HAVING cache_hit >= 0.85 AND reply_chars < 500
ORDER BY total_in DESC
LIMIT 10;
```

### CPU is high

Check the latest-step query plan:

```bash
sqlite3 ~/.openclaw/logs/observability-v2/obs.db \
  "EXPLAIN QUERY PLAN SELECT * FROM steps WHERE session_key = ? ORDER BY ts_epoch_ms DESC LIMIT 1;"
```

The plan should use `idx_steps_session_ts`. Then run:

```bash
npm run test:perf
```

### Remote URL shows an empty or unauthorized page

Make sure the URL includes the current token when remote auth is enabled:

```text
https://example.example/#token=YOUR_TOKEN
```

Rotate the token by editing `.env` and restarting the service:

```bash
$EDITOR .env
./scripts/service.sh restart
```

### Upgrade refuses to run

`scripts/upgrade.sh` requires a clean standalone checkout. Check:

```bash
git status --short
```

Commit, stash, or discard local edits, then rerun the upgrade.

## Runtime Files

Tracked source files live in the repository. Runtime files stay local:

| Runtime file | Tracked by git |
| --- | --- |
| `.env` | no |
| generated service files | no |
| SQLite DB | no |
| logs | no |
| local caches | no |

The open-source release checklist verifies that these files are not committed.

## Compatibility Boundary

OpenClaw Observability is a generic OpenClaw session observability tool. Public
docs and UI labels do not depend on a private agent, workspace, or design
document.

Some parser paths keep backwards compatibility with older transcript field
names and historical workflow markers. Those compatibility paths are internal
implementation details and are covered by tests so existing data continues to
render without changing the public product language.
