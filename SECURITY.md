# Security Policy

OpenClaw Observability is a local-first dashboard that reads OpenClaw
transcripts and the `openclaw sessions --json` output. By default it
binds to `127.0.0.1:18902`. There is no hosted service, no telemetry,
and no LLM in the observability path.

This file describes how to report a vulnerability and what we do with
it.

## Supported Versions

| Version | Supported |
| --- | --- |
| `0.1.x` | Yes (current) |
| `< 0.1.0` | No |

`0.1.x` is the pre-1.0 series. We will fix security issues on
`0.1.latest` and announce them in `CHANGELOG.md`. Older `0.1.x` tags
will not receive backported fixes; upgrade to the latest `0.1.x` first.

## Reporting a Vulnerability

Please open a GitHub security advisory at:

```text
https://github.com/houyili/openclaw-observability/security/advisories/new
```

This routes the report privately to the maintainers. If GitHub security
advisories are not available to you, open a regular issue saying
"security report — please contact me privately" without details, and we
will follow up.

Please include:

- A concise description of the issue.
- Steps to reproduce, or a minimal proof of concept.
- Versions affected (tag or commit SHA).
- Whether you have already disclosed elsewhere.

Please do not disclose publicly until we have had a chance to release
a fix.

## Scope

In scope:

- The HTTP server (`src/api/`) — authn, input validation, path
  traversal, response leakage.
- The ingest layer (`src/ingest/`) — file system access, command
  execution surface.
- Storage (`src/storage/`) — SQL injection, schema integrity, write
  amplification.
- Scripts in `scripts/` that touch the file system or network.
- Default install / service / tunnel paths under `~/.openclaw/`.

Out of scope:

- Issues in OpenClaw itself (report there).
- Issues that require the operator to install a malicious skill or
  patch obs-v2 source (any code that ships with `--experimental-strip-types`
  is, by definition, trusted by the operator).
- Issues that only occur when `OBS_ALLOW_UNAUTH_TUNNEL=1` is set —
  that mode is documented as "demo only" in `docs/security.md`.

## Sensitive Files

Do not commit:

- `.env`
- generated `*.plist`
- `~/.openclaw/logs/observability-v2/*`
- `~/.openclaw/agents/*`
- `openclaw.json`
- browser state, caches, or runtime state

`docs/security.md` covers the routine operator-facing security model
(token rotation, tunnel safety, `#token=...` sharing URLs).
`docs/release-checklist.md` covers the audit gate before a release.

## Disclosure Timeline

- **Day 0** — Report received.
- **≤ 7 days** — Initial triage and acknowledgement.
- **≤ 30 days** — Fix or mitigation released, or a written timeline
  with the reporter.
- **≤ 60 days** — Public disclosure with credit (unless the reporter
  requests anonymity).

We do not currently offer a bug bounty.
