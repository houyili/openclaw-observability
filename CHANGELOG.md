# Changelog

## 0.1.1 - 2026-05-23

- Removed private fleet naming from public source, tests, and docs while keeping
  generic legacy parsing for existing session keys and MCP tool prefixes.
- Renamed pre-release workflow-state event names to the public
  `workflow_state_*` namespace.
- Added Prompt Check projection for transcript evidence, workflow diagnostics,
  and optional hook reminder events.
- Added open-source sanitization tests for public naming, generated state, and
  secret-like fixtures.
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
