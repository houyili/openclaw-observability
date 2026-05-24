# Changelog

## Unreleased

## 0.1.3 - 2026-05-25

This release is the v0.1.x "open source polish wave". It hardens the
project's marketing surface (badges, screenshots, OG image, repo
metadata, GitHub Release for v0.1.2), engineering discipline (strict
`tsc --noEmit`, Biome lint/format, c8 coverage with enforced
thresholds, dependabot for github-actions and dev npm packages), and
release engineering (release-please automation, manual release
validation workflow, SLSA build provenance attestation on source
tarballs). It also ships the first official Docker image and a
Prometheus `/metrics` endpoint.

No public HTTP API path changed; no SQLite schema change. The project
gains its first four devDependencies (`typescript`, `@types/node`,
`@biomejs/biome`, `c8`) but **runtime `dependencies` stays at 0**.

### New surfaces

- Prometheus `/metrics` endpoint emitting `obs_build_info`,
  `obs_sessions_total{state}`, `obs_steps_total{status}`,
  `obs_steps_stuck_total`, `obs_registry_entries_total{type,status}`,
  `obs_auth_poll_last_success_seconds`,
  `obs_auth_poll_last_success_age_seconds`,
  `obs_auth_poll_failures_total`, `obs_auth_poll_inflight`.
  Auth posture matches `/healthz`: localhost exempt, non-local
  requests still need `OBS_AUTH_TOKEN`. Documented in
  `docs/security.md::HTTP Auth`.
- Docker: multi-stage `Dockerfile` (node:22-alpine + tini), full
  `docker-compose.yml`, `.dockerignore`, and `docs/install/docker.md`
  guide covering 4 deployment shapes. `docs/install/linux.md` flips
  the v0.1.2 "no Docker" disclaimer; Docker is now a first-class
  install path.

### Engineering / CI

- Strict TypeScript: new `tsconfig.json` (`strict: true`,
  `noEmit: true`, `allowImportingTsExtensions: true`). `npm run
  typecheck` is now a CI gate.
- Biome lint + format: new `biome.json` with narrow opinionated
  rules. `npm run lint`, `npm run format`, `npm run format:check`.
  CI gate added.
- c8 coverage: new `.c8rc.json` scoped to `src/`. `npm run coverage`
  produces text + lcov + html. `npm run coverage:check` enforces
  `--lines 80 --functions 85 --branches 70`. ci.yml now runs
  `npm run coverage` instead of bare hermetic so every push captures
  coverage as a by-product.
- Release-please automation: `.github/workflows/release-please.yml`
  + `release-please-config.json` + `.release-please-manifest.json`.
  On push to `main`, opens / updates a "chore: release X.Y.Z" PR;
  merging tags + creates the GitHub Release from CHANGELOG.md.
- SLSA build provenance: on every release-please-created tag,
  `actions/attest-build-provenance@v1` attests the `npm pack` source
  tarball and uploads it to the GitHub Release.
- Release validation workflow:
  `.github/workflows/release-validation.yml`, manual-trigger only.
  Adds Docker build smoke, format check, fresh-clone smoke on top of
  the routine CI.
- dependabot: `.github/dependabot.yml` weekly bumps for
  `github-actions` + dev `npm` (production deps disallowed).

### Marketing / community surface

- README: CI / License / Node 22+ / Latest release badges; new
  `Screenshots` section (4 dashboard PNGs); new `How it compares`
  section vs Langfuse / Phoenix / Helicone.
- `docs/screenshots/01-summary.png` … `04-tab-mcps.png` (captured
  against demo mode).
- `CODE_OF_CONDUCT.md`: Contributor Covenant v2.1 verbatim, contact
  routed through `SECURITY.md`.
- `MAINTAINERS.md`: current maintainers, bus factor disclosure,
  "Becoming a maintainer" promotion path.
- `docs/adr/`: 9 Architecture Decision Records migrated from the
  internal round reports (transcript-JSONL, tree+waterfall,
  node:sqlite, full-file reparse, token-source tri-state,
  zero-coupling, bearer header, LEFT JOIN registry, step_id
  collision guard) plus README + template.
- GitHub repo metadata: description, homepage, 8 topics
  (`openclaw`, `observability`, `agent-monitoring`,
  `llm-observability`, `transcript`, `sqlite`, `dashboard`,
  `local-first`). Discussions enabled.
- v0.1.2 GitHub Release published (was tag-only).
- CONTRIBUTING.md: testing section updated for typecheck + lint +
  coverage; release-validation workflow documented.

### New hermetic test suites

- `metrics` (45 assertions) — Prometheus output format,
  per-state zero fallback, version label match against package.json,
  determinism.

Hermetic suite count: **23** (was 22). Hermetic assertion count
crosses ~870.

### Devs

- First four devDependencies introduced (`typescript ^6`,
  `@types/node ^25`, `@biomejs/biome ^2`, `c8 ^11`). Lock file
  (`package-lock.json`) now part of the repository.
- Runtime `dependencies` remain 0.

### Skipped this round (carried to v0.1.4 or v0.2)

- §1.2.16 workflow ↔ context length toggle (UX decision)
- §1.3.2 official-dashboard superset assert (test infra work)
- §5.2 `/observ open` handler (1h follow-up)
- §约束.14 stale skill removed runtime trigger (1h follow-up)
- R4 real composite step-identity migration (v0.2 hardening)
- Apt / rpm / snap / Homebrew tap packaging (v0.2+ decision)

## 0.1.2 - 2026-05-24

This release closes a batch of risks from the 0.1.1 risk register and
adds a self-contained demo mode so users without an OpenClaw install
can see what the dashboard does. No public API path changed; the
SQLite schema is unchanged.

- Public user manual at `docs/user-manual.md` distilled from older
  internal operator notes and updated for the standalone installer,
  Prompt Check, Workflow Graph, current test suites, and the
  remote-access security model. Linked from `README.md`.
- Optional Cloudflare Named Tunnel guide at
  `docs/install/cloudflare.md` with public-safe paths and
  fragment-token sharing URLs.

- Security: frontend `authFetch` now sends `Authorization: Bearer
  <token>` instead of appending `?token=...` to every API URL. The
  server still accepts `?token=` for compatibility with manual curl
  and legacy links. Sharing URLs continue to use `#token=...` in the
  fragment so the token is not in the initial HTTP request line.
  Documentation in `docs/security.md`, `docs/user-manual.md`,
  `docs/install/macos.md`, `docs/install/linux.md` and `README.md`
  has been updated.
- Tab 4 (`/api/mcps`): the MCP scanner now reads
  `~/.openclaw/openclaw.json::mcp.servers` (OpenClaw native) and any
  mcporter-style `~/.openclaw/mcp/*.json::mcpServers`, dedupe by
  name; `getMcpStats` switched to `FROM registry LEFT JOIN steps` so
  installed-but-unused MCPs surface with `call_count = 0` instead of
  being invisible. Restores the constitution §4.3.1 contract.
- Demo mode: new `scripts/demo.sh` + `scripts/seed-demo-home.ts`
  + `tests/fixtures/demo/` stand up a synthetic OpenClaw home and
  launch the dashboard against it on a configurable port. The user's
  real `~/.openclaw/` and the live obs-v2 service are untouched.
  `OBS_PORT` and `OBS_HOST` env vars are now honored so the demo can
  run side-by-side with the canonical service.
- Live test output is redacted via new `tests/_lib/redact.ts`:
  `data-integrity`, `live-e2e`, `cross-check-official`, `replay-verify`
  now print `agent:<agent>:<transport>:<kind>:<hash8>...<suffix4>` and
  `<hash8>...<suffix4>` for session keys and ids respectively.
- Live integrity now asserts `step_id` uniqueness across
  `(session_key, run_id)` scopes as a deferral guard for the
  composite step identity migration planned for v0.2.
- Added `CONTRIBUTING.md`, `SECURITY.md`,
  `.github/PULL_REQUEST_TEMPLATE.md`, three
  `.github/ISSUE_TEMPLATE/` (bug / feature / data correctness), and
  `docs/api-stability.md`.
- CI: hermetic job gets `timeout-minutes: 20`, a cancel-in-progress
  `concurrency` group, and a shallow `actions/checkout@v4` to reduce
  exposure to transient checkout failures.
- `docs/install/linux.md` now explicitly states v0 does not ship apt /
  rpm / brew / snap packages and lists the likely v0.2 candidates.
- New hermetic suites added: `mcp-registry-coverage`, `redact`,
  `demo-seed` (3 suites, 118 new assertions).

## 0.1.1 - 2026-05-23

- Removed private fleet naming from public source, tests, and docs while keeping
  generic legacy parsing for existing session keys and MCP tool prefixes.
- Renamed pre-release workflow-state event names to the public
  `workflow_state_*` namespace.
- Added deterministic Prompt Check projection and hook reminder ingest.
- Added local transcript consistency E2E coverage for trace, context,
  workflow, prompt-check, hook reminders, and idempotent replay.
- Added open-source sanitization checks for checked-in test fixtures.
- Hardened public tunnel URL handling: tunnel scripts now require
  `OBS_AUTH_TOKEN` by default and use `#token=...` sharing links.
- Preserved existing trace, context, workflow payload, token source, sidecar
  filtering, and stale-state semantics.

## 0.1.0 - 2026-05-23

- Initial standalone public release.
- Added local SQLite-backed transcript ingest, session summary, raw trace,
  Context Length, and Workflow Graph dashboard views.
- Added interactive install, upgrade, uninstall, and doctor scripts for macOS
  launchd, Linux user systemd, and foreground/manual operation.
- Added public docs for architecture, security, data access, installation,
  compatibility, workflow graph behavior, and release checks.
- Added Node 22 hermetic CI, live validation suites, replay checks, and
  Apache-2.0 licensing.
