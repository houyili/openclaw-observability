# Changelog

## Unreleased

- Added a public user manual distilled from older internal operator notes and
  updated for the standalone installer, Prompt Check, Workflow Graph, current
  test suites, and remote-access security model.
- Added an optional Cloudflare Named Tunnel guide with public-safe paths and
  fragment-token sharing URLs.
- Linked the migrated user-facing docs from the README.

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
