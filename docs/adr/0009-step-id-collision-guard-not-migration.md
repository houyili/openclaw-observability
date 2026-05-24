# 0009: Use a runtime collision guard instead of doing the composite step-identity migration in v0.1.x

- Status: Accepted
- Date: 2026-05-24
- Deciders: @houyili
- Related: Round 8 R4 (deferred), `tests/data-integrity.test.ts §C.1`

## Context

The `steps` table currently uses `step_id TEXT PRIMARY KEY` — a single
global identity column. The `step_id` is short, derived from a
combination of run-local fields, and a risk audit flagged that as the
database grows, two different runs could in principle generate the same
`step_id` and silently overwrite each other on `INSERT ... ON CONFLICT`.

The structurally clean fix is a composite primary key:
`PRIMARY KEY (session_key, step_id)` (or
`(session_key, run_id, step_id)`). With composite identity, two runs
that happen to mint the same `step_id` are stored as distinct rows.

SQLite does not support an in-place primary-key change. Migrating means
creating a new table with the desired primary key, copying every row
across, dropping the old table, and renaming. On the live
`~/.openclaw/logs/observability-v2/obs.db`, which contains the operator's
historical observability data and which the running service holds open,
that is an irreversible operation. If anything goes wrong mid-migration
the operator loses history and there is no rollback.

A second consideration: the live database had **zero observed
collisions** in audited samples. Every existing query in `src/storage/`
already does its lookups by composite shape — `WHERE session_key = ? AND
run_id = ? AND seq = ?` is the dominant pattern; no production query
relies on `step_id` alone. The risk is real but currently latent.

## Decision

Defer the composite-key migration to v0.2 of the database schema.

Add a runtime collision assertion to the live `data-integrity` test
suite, in section C.1:

```sql
SELECT step_id, COUNT(DISTINCT (session_key || '|' || run_id)) AS scopes
FROM steps
GROUP BY step_id
HAVING scopes > 1
LIMIT 5;
```

The query runs against the operator's actual `obs.db` and fails the
suite the moment any `step_id` shows up under more than one
`(session_key, run_id)` scope. The failure message points the developer
straight at the v0.2 composite-identity migration plan.

## Consequences

What becomes easier:

- v0.1.x ships without an irreversible schema migration against the
  operator's historical database.
- The risk is observable rather than silent: any real collision lands
  in a CI failure, not in lost data.
- The migration can be designed and tested in v0.2 with the benefit of
  knowing whether it ever actually triggers in the field.

What becomes harder:

- The risk remains latent until v0.2. If a collision happens between
  integrity-test runs, the on-conflict update will overwrite a row.
  In practice the test runs at install time, on every release gate, and
  on any live correctness sweep, so the window is narrow.

What we accept:

- Status: Accepted, with the explicit understanding that this ADR will
  be **superseded** by a future ADR when v0.2 ships the composite
  primary-key migration. The supersession ADR will reference this one
  in its header.
