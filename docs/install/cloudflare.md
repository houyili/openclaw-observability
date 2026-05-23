# Cloudflare Named Tunnel

Cloudflare Named Tunnel is an optional remote-access path for users who want a
stable HTTPS URL on their own domain. The default public quick start uses local
access, and the install guides document ngrok as the lightweight tunnel option.

Use this guide only when you already have a domain or want to manage one
through Cloudflare.

## Prerequisites

- A domain managed through Cloudflare DNS.
- `cloudflared` installed and available on `PATH`.
- OpenClaw Observability running locally on `127.0.0.1:18902`.
- `OBS_AUTH_TOKEN` set in `.env` before exposing the dashboard remotely.

## 1. Authenticate cloudflared

```bash
cloudflared tunnel login
```

Authorize the domain in the browser window that opens. The command writes
Cloudflare credentials under `~/.cloudflared/`.

## 2. Create a Named Tunnel

```bash
cloudflared tunnel create openclaw-observability
```

This creates a tunnel ID and a credential JSON file under `~/.cloudflared/`.

## 3. Route A Subdomain

```bash
cloudflared tunnel route dns openclaw-observability obs.example.com
```

Replace `obs.example.com` with your desired hostname.

## 4. Configure The Tunnel

Create or update `~/.cloudflared/config.yml`:

```yaml
tunnel: openclaw-observability
credentials-file: /home/YOUR_USER/.cloudflared/TUNNEL_ID.json

ingress:
  - hostname: obs.example.com
    service: http://127.0.0.1:18902
  - service: http_status:404
```

On macOS the home path usually starts with `/Users/YOUR_USER`. On Linux it
usually starts with `/home/YOUR_USER`. Use the real path printed by
`cloudflared tunnel create`.

## 5. Test Foreground Mode

```bash
cloudflared tunnel run openclaw-observability
```

Open:

```text
https://obs.example.com/#token=YOUR_OBS_AUTH_TOKEN
```

Stop foreground mode with `Ctrl+C`.

## 6. Run As A User Service

Cloudflare can install its own user service:

```bash
cloudflared service install
```

If you prefer to manage the service yourself on macOS, create a launchd user
agent that runs:

```bash
cloudflared tunnel run openclaw-observability
```

If you prefer to manage it yourself on Linux, create a user systemd service that
runs the same command.

## 7. Expose The URL To Local Helpers

Add the fixed URL to `.env`:

```bash
OBS_FIXED_URL=https://obs.example.com
```

Then restart Observability:

```bash
./scripts/service.sh restart
```

## Security Notes

- Keep `OBS_AUTH_TOKEN` enabled for remote access.
- Share URLs as `https://host/#token=...`; avoid `?token=...` in public tunnel
  links so the token is not sent in the HTTP request line.
- Do not commit `.env`, Cloudflare credential JSON files, generated service
  files, logs, DB files, or local caches.
- Rotate the token by editing `.env` and restarting Observability.
- The dashboard API is read-only, but transcripts and session metadata can still
  be sensitive.

## Troubleshooting

### DNS has not propagated

Use:

```bash
dig obs.example.com
```

DNS changes can take time depending on your registrar and resolver cache.

### 502 Bad Gateway

Make sure Observability is running:

```bash
curl http://127.0.0.1:18902/healthz
./scripts/service.sh status
```

### Tunnel credentials cannot be found

List local tunnel credentials:

```bash
ls ~/.cloudflared/*.json
```

If none exist, rerun:

```bash
cloudflared tunnel create openclaw-observability
```

### Changing the hostname

```bash
cloudflared tunnel route dns openclaw-observability new.example.com
```

Then update `~/.cloudflared/config.yml` and `OBS_FIXED_URL`.
