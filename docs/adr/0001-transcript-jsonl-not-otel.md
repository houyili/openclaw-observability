# 0001: Use OpenClaw transcript JSONL as the source of truth, not OTel

- Status: Accepted
- Date: 2026-04-04
- Deciders: @houyili
- Related: v0 architecture snapshot, OTel implementation audit (2026-04-04)

## Context

The first iteration of the dashboard (v1) consumed OpenTelemetry diagnostic
events emitted by OpenClaw through `onDiagnosticEvent`, written to an
`events.jsonl` file by the host plugin. After running v1 in production for
several weeks, an audit of the live data uncovered three structural defects
that no amount of plugin-side patching could repair:

1. **`diagnostic.model.usage` did not carry a `runId`.** Model token-usage
   events could not be correlated with the tool calls they belonged to,
   making any per-run cost or latency attribution impossible.
2. **`after_tool_call` did not fire for many tool kinds.** Roughly 80% of
   `operation.end` markers were silently missing, so duration and error
   columns on the dashboard were systematically wrong.
3. **MCP tool names were absent from the diagnostic event payload.** The
   `mcpServer` field was always `None`, so MCP traffic could not be
   attributed to a server.

These defects sit on the OpenClaw side and were not realistically going to
be fixed in the timeframe the dashboard needed reliable data.

Meanwhile, OpenClaw itself does not use OTel for its own per-session token
accounting. It reads the transcript JSONL files at
`~/.openclaw/agents/<agent>/sessions/<session-id>.jsonl`, which are written
synchronously by `SessionManager.appendMessage()` as part of normal message
processing. Each assistant message in the transcript carries the LLM
provider's raw `usage` field. The transcript is the same data OpenClaw
itself trusts.

## Decision

Make transcript JSONL — together with `openclaw sessions --json` for
authoritative session metadata — the primary data source for the
dashboard.

OTel events are demoted to an optional secondary signal: the parser still
reads `diagnostic.session.state` if it is available, exposing it as a
non-authoritative `diagnosticState` hint, but the dashboard does not
depend on it for any displayed value.

## Consequences

What becomes easier:

- Model calls correlate to tool calls via `runId` because both come from
  the same transcript entries.
- Tool-call returns are never lost; every assistant message records both
  the call and the matching `toolResult`.
- MCP tool names are present, so Tab 4 can attribute traffic to the right
  server.
- Token usage matches what OpenClaw itself reports, to the token (verified
  by the live `cross-check-official` suite).

What becomes harder:

- The dashboard is now coupled to the transcript file format. A breaking
  change to the transcript schema would break the dashboard.
- A naive incremental "tail the file" implementation has subtle
  failure modes when an entry that defines run boundaries has not been
  seen yet (see ADR-0004 for the full-file-reparse fix).

What we accept:

- We cannot consume OTel from agents that are not OpenClaw — the
  dashboard is OpenClaw-shaped on purpose.
- The transcript schema becomes a stability surface we have to track
  across OpenClaw releases.
