# macOS Install

## Foreground

```bash
cd ~/.openclaw/extensions/observability-v2
cp .env.example .env
npm run start
```

Open [http://127.0.0.1:18902](http://127.0.0.1:18902).

## launchd Service

Recommended:

```bash
./scripts/install.sh
./scripts/doctor.sh
```

The installer checks Node.js 22+, the OpenClaw CLI, `.env`, launchd paths,
and `/healthz`. It explains that it writes only to:

- `~/.openclaw/extensions/observability-v2/.env`
- `~/Library/LaunchAgents/com.openclaw.observability-v2.plist`
- `~/.openclaw/logs/observability-v2/`

Lower-level service commands:

```bash
./scripts/service.sh generate-plist
./scripts/service.sh check
./scripts/service.sh install
./scripts/service.sh start
./scripts/service.sh status
```

The generated plist is machine-specific and intentionally ignored by git.

Useful commands:

```bash
./scripts/service.sh restart
./scripts/service.sh logs
./scripts/service.sh uninstall
```

## Upgrade

```bash
./scripts/upgrade.sh
```

The upgrade helper requires a clean standalone git checkout, runs
`git pull --ff-only`, regenerates the launchd plist, restarts the service, and
checks `/healthz`.

## Uninstall

```bash
./scripts/uninstall.sh
```

The default removes only the launchd service. It asks before deleting `.env`,
logs, the SQLite DB, or the git checkout.

## Optional ngrok Tunnel

```bash
python3 scripts/install_ngrok.py
./scripts/tunnel-ngrok.sh start
./scripts/tunnel-ngrok.sh url
```

Set `OBS_AUTH_TOKEN` before exposing the dashboard remotely.
