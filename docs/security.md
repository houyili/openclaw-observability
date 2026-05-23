# Security

OpenClaw Observability is local-first. By default it binds to
`127.0.0.1:18902` and reads local OpenClaw runtime files.

## Sensitive Files

Do not commit:

- `.env`
- generated `*.plist`
- `~/.openclaw/logs/observability-v2/*`
- `~/.openclaw/agents/*`
- `openclaw.json`
- browser state, caches, or runtime state

Only `.env.example` and `*.plist.template` should be versioned.

Run `./scripts/doctor.sh` after installation to check for accidentally
tracked local config, generated service files, or runtime data.

## HTTP Auth

Set `OBS_AUTH_TOKEN` in `.env` before exposing the dashboard through a tunnel
or reverse proxy. Non-local API requests require either:

```text
Authorization: Bearer <token>
```

or:

```text
?token=<token>
```

Localhost, static assets, and `/healthz` remain accessible for service health
checks.

## Remote Tunnels

The tunnel scripts are optional and default-safe:

- `scripts/tunnel.sh` starts a Cloudflare Quick Tunnel.
- `scripts/tunnel-ngrok.sh` uses a fixed ngrok domain.
- Both refuse to expose or return a public URL unless `OBS_AUTH_TOKEN` is set.
- Returned sharing URLs use `#token=...`, not `?token=...`, so the token stays
  in the browser fragment and is not sent in HTTP request lines.

For local-only demos you may explicitly set `OBS_ALLOW_UNAUTH_TUNNEL=1`, but
do not use that for shared, public, or long-lived tunnels.

For ngrok, macOS uses Keychain. Linux/other hosts may use
`OBS_NGROK_AUTHTOKEN` or `~/.config/openclaw/ngrok-authtoken` with mode `0600`.

Never paste tunnel tokens into committed files.
