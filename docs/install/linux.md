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

Create `~/.config/systemd/user/openclaw-observability.service`:

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
