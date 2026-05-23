# API Stability Policy

This document describes which parts of OpenClaw Observability are
treated as stable contracts and which are not. It applies to the public
HTTP API, the SQLite schema, the `/observ` channel CLI, and the
configuration surface.

## Version channels

| Series | Stability stance |
| --- | --- |
| `0.1.x` (current) | Pre-1.0. The shape of the API and schema is stabilising but not frozen. Breaking changes will land in a new minor (`0.x → 0.(x+1)`) and will always be called out in `CHANGELOG.md`. |
| `0.2.x` (planned) | Will introduce composite step identity migration (see `agents_design_doc/opensource/08_..._risk_register.md` R4) and may renumber `steps.step_id` lookup paths. We will document any incompatible change in the release notes. |
| `1.0.0+` (future) | Strict semver. Public API and schema only change in MAJOR releases. |

## What is stable in `0.1.x`

The following surfaces will not break in a `0.1.patch` release:

### HTTP API paths

```text
GET /healthz
GET /api/summary
GET /api/sessions
GET /api/sessions/:key
GET /api/sessions/:key/prompt-check
GET /api/sessions/:key/workflow
GET /api/sessions/:key/trace
GET /api/sessions/:key/context
GET /api/skills
GET /api/scripts
GET /api/mcps
GET /api/registry
```

Existing JSON keys keep their meaning. New keys may be added.

### Workflow Graph contract

`{ lanes, events, edges, diagnostics, runs }` shape is stable.

Public event type names (frozen as of `v0.1.1`):

```text
user_message
skill_or_source_step
checkpoint_write
sessions_spawn_requested
sessions_spawn_accepted
sessions_yield
child_started
child_artifact_written
child_final
parent_resumed
workflow_state_snapshot
workflow_state_child_bound
workflow_state_gap
```

Adding a new event type is a minor change. Renaming or removing one is
a breaking change.

### Token-source taxonomy

`sessions.token_source` is one of:

```text
official
official-zero
transcript-backfill
```

These three values are stable. New values may be added in a minor.

### Channel CLI

`/observ status`, `/observ stuck`, `/observ top`,
`/observ skills [day|week|month]`, `/observ scripts ...`,
`/observ mcps ...`, `/observ errors`, `/observ help` will continue to
exist with the same arguments. Output formatting may improve; the
column count and column meanings stay backward compatible inside a
minor.

### Auth model

- Localhost, static assets, and `/healthz` never require auth.
- When `OBS_AUTH_TOKEN` is set, non-local API requests need
  `Authorization: Bearer <token>` (preferred) or `?token=<token>`
  (compatibility).
- Tunnel sharing URLs use `#token=...` in the fragment.

## What is not stable in `0.1.x`

### SQLite schema columns

`PRAGMA table_info(sessions)` and `PRAGMA table_info(steps)` can grow
new columns within a `0.1.x` release. We use `ensureColumn` in
`src/storage/db.ts::migrate` so existing data keeps working without a
manual migration. Removing or renaming an existing column requires a
new minor.

### Internal helpers

Anything under `src/storage/*-repo.ts` exports is internal. Other
consumers should go through the HTTP API or `/observ` CLI.

### Test fixtures and the demo dataset

`tests/fixtures/` content can change between any two releases. The
`scripts/demo.sh` payload may grow new agents / MCPs / skills.

### `config/prompt-rules.json`

The shipped rule pack will grow new rules over time. Existing rule
`ruleId`s will not be renamed within a minor.

## Migration commitments

When a `0.1.patch` release modifies behavior, we will:

1. Document the change in `CHANGELOG.md` under that version's entry.
2. Keep the previous behavior as a runtime fallback for at least one
   `0.1.patch` release whenever this is feasible.
3. Mention any operator-visible change at the top of the release notes
   (token contract, schema, install path).

When a `0.1.x → 0.2.0` cut happens, the release notes will list every
breaking change and include a manual migration recipe where needed.

## Reporting drift

If you see a `0.1.x` release that breaks one of the stable surfaces
listed above without a `CHANGELOG.md` entry, please open a
[data correctness issue](.github/ISSUE_TEMPLATE/data_correctness_concern.md)
or a regular bug report.
