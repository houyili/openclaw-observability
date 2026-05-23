# Linux Install

Linux support in v0.1 is a portable startup path, not a full distribution
package.

## Foreground

```bash
cd ~/.openclaw/extensions/observability-v2
cp .env.example .env
npm run start
```

Open [http://127.0.0.1:18902](http://127.0.0.1:18902).

## systemd User Service

Recommended:

```bash
./scripts/install.sh
./scripts/doctor.sh
```

The installer checks Node.js 22+, the OpenClaw CLI, `.env`, and the user
systemd path. It explains that it writes only to:

- `~/.openclaw/extensions/observability-v2/.env`
- `~/.config/systemd/user/openclaw-observability.service`
- `~/.openclaw/logs/observability-v2/`

The generated user unit is equivalent to:

```ini
[Unit]
Description=OpenClaw Observability
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/.openclaw/extensions/observability-v2
ExecStart=/usr/bin/env node --experimental-sqlite --experimental-strip-types --no-warnings src/index.ts
Restart=always
RestartSec=5
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
```

Then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now openclaw-observability
systemctl --user status openclaw-observability
```

Lower-level service commands:

```bash
./scripts/service.sh generate-systemd
./scripts/service.sh check-systemd
./scripts/service.sh install
./scripts/service.sh restart
./scripts/service.sh logs
./scripts/service.sh uninstall
```

## Upgrade

```bash
./scripts/upgrade.sh
```

The upgrade helper requires a clean standalone git checkout, runs
`git pull --ff-only`, regenerates the user unit, restarts the service, and
checks `/healthz`.

## Uninstall

```bash
./scripts/uninstall.sh
```

The default removes only the systemd user service. It asks before deleting
`.env`, logs, the SQLite DB, or the git checkout.

## Optional ngrok Token

Use either:

```bash
export OBS_NGROK_AUTHTOKEN=...
```

or:

```bash
mkdir -p ~/.config/openclaw
printf '%s\n' 'YOUR_TOKEN' > ~/.config/openclaw/ngrok-authtoken
chmod 600 ~/.config/openclaw/ngrok-authtoken
```

Then run:

```bash
python3 scripts/install_ngrok.py
./scripts/tunnel-ngrok.sh start
./scripts/tunnel-ngrok.sh url
```

Set `OBS_AUTH_TOKEN` before exposing the dashboard remotely. Sharing URLs use
`#token=...`, so the initial token is kept out of the browser request line. For
a temporary unauthenticated demo, set `OBS_ALLOW_UNAUTH_TUNNEL=1` explicitly;
otherwise tunnel scripts refuse to return a public URL without auth. Do not use
unauthenticated tunnels for shared or long-lived access.

## Distribution Packaging

OpenClaw Observability v0 does **not** ship as a distribution package.
There is no `apt` package, no `rpm`, no `snap`, no Homebrew formula, and
no Docker image in this release.

The supported install paths on Linux are:

- `./scripts/install.sh` — sets up a user systemd service
- `npm run start` — foreground mode
- `./scripts/demo.sh` — synthetic dataset demo without OpenClaw

This is a deliberate scope choice for v0.1.x: distribution packaging
multiplies the release surface (signing, distro-specific service
managers, distro-specific Node policies) and we want to learn from real
user installs first.

If you would like a packaging format added, please open a
[feature request](../../.github/ISSUE_TEMPLATE/feature_request.md) and
describe your deployment context (single host vs fleet, base distro,
update cadence, signing requirements). Likely candidates for v0.2 or
v0.3, in order of demand we have heard:

1. A multi-arch Docker image plus a `docker-compose.yml` example.
2. A Homebrew tap covering both macOS and Linux.
3. A `deb` package for Debian/Ubuntu user systemd installs.

None of the above is committed work; this list exists so the v0
disclaimer is paired with a concrete forward path.
