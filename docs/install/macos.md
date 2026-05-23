# macOS Install

## Foreground

```bash
cd ~/.openclaw/extensions/observability-v2
cp .env.example .env
npm run start
```

Open [http://127.0.0.1:18902](http://127.0.0.1:18902).

## launchd Service

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

## Optional ngrok Tunnel

```bash
python3 scripts/install_ngrok.py
./scripts/tunnel-ngrok.sh start
./scripts/tunnel-ngrok.sh url
```

Set `OBS_AUTH_TOKEN` before exposing the dashboard remotely.
