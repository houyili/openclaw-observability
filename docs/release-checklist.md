# Release Checklist

Use this before publishing a public release.

## Local Tests

```bash
npm run test:hermetic
npm run test:integrity
npm run test:live-e2e
npm run test:replay
npm run test:cross-check -- --retry-wait 0
npm run test:perf
```

## Open Source Audit

```bash
rg -n "bytedance|openclaw\\.json|agents_design_doc|Documents/group|ngrok.*token|sk-|secret|password" .
git log --all --format=fuller
git status --short
```

Confirm the repo does not include:

- `.env`
- generated `*.plist`
- logs or SQLite DB files
- OpenClaw runtime state
- browser state or local caches

Expected adapter-related matches should be reviewed manually before release.

## Fresh Clone Smoke

```bash
git clone <repo> /tmp/openclaw-observability-smoke
cd /tmp/openclaw-observability-smoke
npm run test:hermetic
cp .env.example .env
npm run start
curl http://127.0.0.1:18902/healthz
```

## Extract From A Monorepo

When cutting the first standalone repository from a larger OpenClaw checkout,
start from a committed baseline, then extract only this extension path:

```bash
git clone <openclaw-repo> /tmp/openclaw-observability-extract
cd /tmp/openclaw-observability-extract
git filter-repo --path extensions/observability-v2/ --path-rename extensions/observability-v2/:
```

After extraction, rerun the audit and fresh-clone smoke before creating the
public repository. If commit messages contain private project references, do a
minimal message rewrite in the extracted clone before pushing.

## Tag

```bash
git tag v0.1.0
git push origin main --tags
```
