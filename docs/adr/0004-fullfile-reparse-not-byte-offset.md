# 0004: Reparse whole transcript files on size change instead of byte-offset increments

- Status: Accepted
- Date: 2026-04-11
- Deciders: @houyili
- Related: ADR-0001, Round 2 perf + correctness work

## Context

Transcript watching started out as a classic incremental tail: store the
last byte offset for each file, on each tick read only the new bytes since
that offset, parse them, and `INSERT` the resulting steps.

A correctness sweep against the live database (`replay-verify`) found
that **138 of 231 runs** had step counts that disagreed with a clean-room
reparse of the same transcript file. The drift had a sharp signature:
almost every dropped run terminated at exactly three steps
(MODEL_THINK + TOOL_CALL + REPLY), which is the size of the first
assistant batch in a typical run.

The cause was structural, not a bug in any one place. The transcript
parser is defensive: it drops every entry that appears before the first
`role: user` message in its input, because such entries can only be
orphans from an incomplete read. That defense is correct on its own. But
combined with byte-offset incremental parsing, it became a silent
data-loss path: any tick whose chunk happened to start partway through a
run would have its leading entries (including the user message that
defines the run boundary) dropped, and every step after it discarded.

## Decision

On any tick where a transcript file's `stat.size` differs from the last
observed size, read the entire file with `readFileSync`, JSON-parse line
by line, and feed the full entry list to the parser. Use `upsertSteps`
with `ON CONFLICT(step_id) DO UPDATE` so re-ingesting already-known rows
is idempotent.

A bounded 50 MB hard cap per file guards against runaway transcripts.
A per-file in-memory size cache short-circuits files that have not grown
since the last tick, so the steady-state cost is one `stat` call per
tracked file.

The size cache is intentionally not seeded from the on-disk
`ingest_state` table at process start, so a restart forces a one-time
full reparse of every transcript. This is how parser bug-fixes heal
historical data without a manual database wipe.

## Consequences

What becomes easier:

- Correctness is provable: `replay-verify` went from 138 drifted runs to
  0 across 231 / 757+ runs and stays at 0.
- Parser bug fixes self-heal historical data on the next process
  restart.
- The file watcher has no "where did I leave off" state to corrupt.

What becomes harder:

- Per-tick CPU is higher than true incremental parsing on the file that
  is currently growing. In practice it is bounded — transcripts are
  almost all under 1 MB and the hard cap is 50 MB — and the steady-state
  CPU cost measured against the live 21,538-step database stayed at
  0.1–1.7%.

What we accept:

- A trade of bounded per-tick CPU for provable correctness and
  self-healing. The `perf-bench` suite locks in the budget so any
  regression that pushes this past the comfort zone fails CI.
- If transcripts ever grow significantly beyond the 50 MB cap, a more
  sophisticated approach (e.g. checkpointing on user-message boundaries
  rather than byte offsets) will be needed. We do not have a use case
  for that yet.
