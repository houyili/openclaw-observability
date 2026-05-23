# Architecture

OpenClaw Observability is a local read-only projection over OpenClaw runtime
state. It does not instrument the agent process and does not require hosted
infrastructure.

## Data Sources

1. Transcript JSONL files under `~/.openclaw/agents/<agent>/sessions/`.
2. `openclaw sessions --json` for session inventory and official token totals.
3. Optional local hook reminder events for prompt/workflow diagnostics.
4. Optional local event streams such as `events.jsonl` for diagnostic hints.
5. Optional managed workflow artifacts referenced by transcript steps.

Sidecar transcript files are ignored: `.acp-stream`, `.checkpoint.*.jsonl`,
and `.trajectory.jsonl`.

## Runtime Loop

- `auth-poller` refreshes session inventory from the OpenClaw CLI.
- `transcript-watcher` scans canonical transcript files and reparses changed
  files into deterministic step rows.
- `registry-scanner` discovers local skills, scripts, and MCP tools.
- storage repos recompute session counters, token backfill, current operation,
  and blocker state.
- prompt/workflow projections read hook reminders and managed workflow blocks
  without mutating runtime state.
- the HTTP server serves static UI assets and JSON API routes.

## Storage

SQLite is the durable store. `sessions` is keyed by `(session_key, session_id)`.
`steps` stores parsed transcript steps and currently keeps `step_id` as the
primary key for v0.1 compatibility. A composite step identity migration is
reserved for a later schema hardening release.

## Token Contract

Official nonzero token values from `openclaw sessions --json` are authoritative.
If official totals are zero but transcript usage exists, session counters are
backfilled from transcript steps and marked with
`token_source = 'transcript-backfill'`.

## Workflow Graph

Workflow Graph is a deterministic projection over existing rows and referenced
artifacts. It produces lanes, events, edges, diagnostics, and provenance. No
LLM-generated summary is used to create graph edges.

## Prompt Check

Prompt Check is a deterministic rule projection over transcript steps, Workflow
Graph events, and optional local hook reminders. The public rule pack lives in
`config/prompt-rules.json`. It can warn about missing checkpoints before yield,
missing child-session evidence after spawn, or workflow-state gaps, but it never
rewrites session state and never calls an LLM.
