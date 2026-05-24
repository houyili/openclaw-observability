# Architecture Decision Records

This directory captures decisions about why OpenClaw Observability is
the way it is, in a form that survives the original design discussion.

Each ADR is a single Markdown file numbered `NNNN-short-slug.md` and
follows the template at [`template.md`](template.md).

## Conventions

- New ADRs use the next sequential 4-digit number.
- Once an ADR has been merged, its content is immutable — supersede it
  with a new ADR (referencing the old one) rather than editing in place.
- The status header is one of: `Proposed`, `Accepted`, `Superseded`,
  `Deprecated`.

## Index

| # | Title | Status |
| --- | --- | --- |
| [0001](0001-transcript-jsonl-not-otel.md) | Use OpenClaw transcript JSONL as the source of truth, not OTel | Accepted |
| [0002](0002-tree-waterfall-not-dag.md) | Render execution as tree + waterfall Gantt, not DAG | Accepted |
| [0003](0003-node-sqlite-not-better-sqlite3.md) | Use `node:sqlite` instead of `better-sqlite3` for storage | Accepted |
| [0004](0004-fullfile-reparse-not-byte-offset.md) | Reparse whole transcript files on size change instead of byte-offset increments | Accepted |
| [0005](0005-token-source-tristate.md) | Make token-source provenance explicit with a tri-state column | Accepted |
| [0006](0006-zero-coupling-schema-driven-compatibility.md) | Keep zero coupling to private fleets via schema-driven compatibility | Accepted |
| [0007](0007-bearer-header-with-fragment-token.md) | Use fragment-token sharing URLs + bearer header for API auth | Accepted |
| [0008](0008-leftjoin-registry-for-tab4-coverage.md) | LEFT JOIN registry in `getMcpStats` so installed-but-unused MCPs surface | Accepted |
| [0009](0009-step-id-collision-guard-not-migration.md) | Use a runtime collision guard instead of doing the composite step-identity migration in v0.1.x | Accepted |
