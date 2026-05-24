# Docker Install

OpenClaw Observability ships a small Docker image so operators can run the
dashboard without touching their host Node toolchain. This guide covers
the four common shapes:

1. Inspect a real OpenClaw home (most common)
2. Inspect a synthetic demo home (no OpenClaw needed)
3. Run alongside an existing host-native obs-v2 service
4. Multi-host / CI use cases

## Image overview

| Layer | Size hint | Contents |
| --- | --- | --- |
| Base | `node:22-alpine`, ~140 MB | Node 22.x runtime |
| App  | ~5 MB | `src/`, `scripts/`, `config/`, `docs/`, `tests/`, package metadata |
| Init | small | `tini` for clean PID 1 signal handling |

No build step runs inside the image; `src/*.ts` is read directly via
`--experimental-strip-types`. Zero npm install. No production
dependencies.

The image deliberately does NOT contain the `openclaw` CLI. The
auth-poller will fail each cycle, `/healthz` will report
`authPoll.stale=true`, and Tab 1 token totals stay at whatever the
transcript provides via the `transcript-backfill` path. Transcript
ingest, Workflow Graph, Prompt Check, Context Length, and the
`/observ` channel CLI all still work.

## 1. Inspect a real OpenClaw home

If you already have `~/.openclaw/agents/<agent>/sessions/*.jsonl` data
on this host:

```bash
cd ~/.openclaw/extensions/observability-v2
docker compose up -d
```

Open <http://127.0.0.1:18902/>. The compose file mounts:

- `~/.openclaw/agents` (read-only)
- `~/.openclaw/logs/observability-v2` (read-write — where obs.db lives)
- `~/.openclaw/openclaw.json` (read-only — for MCP registry §4.3.1)
- `~/.openclaw/mcp/` (read-only — same)

Logs:

```bash
docker compose logs -f observability
```

Stop:

```bash
docker compose down
```

## 2. Inspect a synthetic demo home (no OpenClaw needed)

Seed a synthetic home first, then start the container against it:

```bash
cd ~/.openclaw/extensions/observability-v2
./scripts/demo.sh --target /tmp/obs-v2-docker-demo --seed-only
docker run --rm \
  -p 18902:18902 \
  -e OPENCLAW_HOME=/openclaw \
  -e OBS_HOST=0.0.0.0 \
  -e OBS_PORT=18902 \
  -v /tmp/obs-v2-docker-demo:/openclaw \
  openclaw-observability:local
```

This gives a brand-new tester something to look at without installing
OpenClaw. Once you stop the container, just `rm -rf /tmp/obs-v2-docker-demo`.

## 3. Run alongside an existing host obs-v2 service

If you already have a host-native obs-v2 running on port 18902, do NOT
mount the same `obs.db` into the container — SQLite WAL would conflict.
Either:

**a) Use a separate port and a separate database**:

```bash
docker run --rm \
  -p 18903:18903 \
  -e OBS_PORT=18903 \
  -e OBS_HOST=0.0.0.0 \
  -e OPENCLAW_HOME=/openclaw \
  -v ~/.openclaw/agents:/openclaw/agents:ro \
  -v /tmp/obs-v2-docker-db:/openclaw/logs/observability-v2 \
  openclaw-observability:local
```

This gives the container its own derived obs.db; transcript source is
still the live host directory.

**b) Or stop the host service first**:

```bash
./scripts/service.sh stop
docker compose up -d
```

## 4. Multi-host / CI

The image is single-arch (linux/amd64 by default; build with
`docker buildx --platform linux/amd64,linux/arm64` for both). It is
suitable for one-off CI smoke tests or for hosting on a single shared
inspection host that mounts session data over NFS / SSHFS / a sync
tool.

The image is intentionally not designed for k8s-style scale-out — the
dashboard is local-first by design.

## Configuration

All standard `.env` knobs work; pass them as `-e` flags or compose
`environment:` entries:

| Var | Default | Purpose |
| --- | --- | --- |
| `OBS_HOST` | `0.0.0.0` (Docker) / `127.0.0.1` (native) | bind host |
| `OBS_PORT` | `18902` | bind port |
| `OBS_AUTH_TOKEN` | empty | required for non-local API access |
| `OBS_ALLOW_UNAUTH_TUNNEL` | `0` | safety valve for demo tunnels |
| `OBS_NGROK_DOMAIN` | empty | fixed ngrok domain (not relevant inside container) |
| `OBS_FIXED_URL` | empty | external integrations |
| `OBS_WORKFLOW_ADAPTERS` | `auto` | managed workflow allowlist |
| `OPENCLAW_HOME` | `/openclaw` (Docker) / `$HOME/.openclaw` (native) | obs.db + transcript root |

## Build

```bash
cd ~/.openclaw/extensions/observability-v2
docker build -t openclaw-observability:local .
```

Multi-arch:

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t openclaw-observability:local \
  .
```

## Security notes

The image runs as root by default (Node 22-alpine base) to keep
first-run friction low. For long-running deployments you should add a
non-root user via a wrapper Dockerfile or `--user` flag, and ensure the
mounted `~/.openclaw/logs/observability-v2` directory has matching
ownership.

`OBS_AUTH_TOKEN` is read from environment at startup; the image does
not bake any token in. Mount your `.env` file or pass tokens via
`-e OBS_AUTH_TOKEN=…` and never put tokens into a published image.

For tunnel exposure, prefer the host-native install path — `ngrok` and
Cloudflare tunnels run alongside the dashboard process, not inside it.

## Troubleshooting

### "Cannot find module 'node:sqlite'"

Image base is `node:22-alpine`. `node:sqlite` is part of Node 22+; if
the image runs an older Node binary (custom base), the experimental
flag is ignored and the module is missing. Confirm with
`docker run --rm openclaw-observability:local node -v`.

### `/healthz` shows `authPoll.stale=true`

Expected — the image does not contain the `openclaw` CLI, so
auth-poller has nothing to call. Transcript ingest still works.

### Permissions denied on `/openclaw/logs/observability-v2`

The container writes obs.db as root. If your host mount is owned by a
non-root user, either run the container with `--user $(id -u):$(id -g)`
or `chmod 0777` the directory (less secure).

### SQLite "database is locked"

You probably mounted the same obs.db into multiple processes (host
service + container, or two containers). Pick one writer per database
or give each container its own derived database — see Section 3.
