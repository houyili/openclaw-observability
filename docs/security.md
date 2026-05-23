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

The tunnel scripts are optional. For ngrok, macOS uses Keychain. Linux/other
hosts may use `OBS_NGROK_AUTHTOKEN` or
`~/.config/openclaw/ngrok-authtoken` with mode `0600`.

Never paste tunnel tokens into committed files.
