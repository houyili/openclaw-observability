# Changelog

## Unreleased

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
