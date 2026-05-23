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
```
