# 0005: Make token-source provenance explicit with a tri-state column

- Status: Accepted
- Date: 2026-04-11
- Deciders: @houyili
- Related: ADR-0001, Round 5 data-correctness depth, Round 7 token backfill

## Context

By design (and per the OpenClaw observability constitution §1.3.1), the
authoritative source of truth for per-session token totals is the
`openclaw sessions --json` CLI. Whatever number the CLI returns is the
number the dashboard must show, because that is what the rest of OpenClaw
will agree with.

In practice, the CLI returns **zero** for some sessions even when the
transcript on disk clearly contains assistant messages with non-zero
`usage` fields. This happens most reliably for short-lived subagent
sessions whose lifecycle ends before the CLI's accounting window closes.
The Round 7 audit found multiple subagent rows in production where the
CLI reported `0/0/0` while the transcript carried tens of thousands of
tokens of real activity.

Two failure modes had to be avoided:

1. Silently overwriting the CLI value with a transcript-derived value.
   That breaks the constitution promise that the CLI is authoritative
   when it is non-zero.
2. Silently leaving zero on display. That breaks the dashboard's job —
   the user has no way to know whether the row is genuinely idle or has
   simply been miscounted.

## Decision

Sessions carry an explicit `token_source` column with three values:

- `official` — CLI returned a non-zero count. Display unchanged.
- `official-zero` — CLI returned zero, transcript also contains no usage
  data. Display zero (truthful absence).
- `transcript-backfill` — CLI returned zero (or NULL), transcript has
  non-zero usage. Fall back to the transcript-derived total and tag the
  row visibly so the operator knows it is a fallback.

`recomputeSessionCounts` aggregates the transcript-side total, then a
gated `UPDATE` only writes back when the existing CLI value is `0` or
`NULL`. The CLI value, when non-zero, is never overwritten.

The frontend renders the badge directly off `token_source`. The live
`cross-check-official` test allow-lists `transcript-backfill` rows so
the suite stays green when the dashboard and CLI disagree for the
documented, expected reason.

## Consequences

What becomes easier:

- Subagent token counts are no longer silently zero. The dashboard tells
  an honest story: "this number came from the transcript because the
  CLI was empty".
- Operators can tell at a glance whether they are looking at canonical
  data or a fallback.
- Future changes that affect token accounting (e.g. an OpenClaw fix that
  removes the zero-on-subagent failure mode) are observable as a drop in
  `transcript-backfill` rows.

What becomes harder:

- The query path for "what is the total token count" has to read the
  source column to know how to format and cross-check.
- The cross-check test has to keep its allow-list narrow so genuine
  drift is not masked.

What we accept:

- A small permanent surface-area cost (one column, one badge, one
  allow-list path) in exchange for not lying.
