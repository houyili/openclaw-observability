# Contributing to OpenClaw Observability

Thanks for taking the time to look at this project. The notes below
describe how the codebase is laid out, how tests are organized, and what
to expect from a pull request.

## What kind of changes fit

OpenClaw Observability is intentionally narrow. Changes that help it stay
fast, correct, and easy to install are welcome. Examples:

- Bug fixes with a regression test.
- Performance improvements with a `perf-bench` budget update.
- New transcript-derived views that fit into the existing tab/section
  layout without introducing build-time dependencies.
- Documentation improvements (especially install paths, troubleshooting,
  data correctness reasoning).
- Tests that close a real gap in correctness coverage.

Changes that probably do not fit without an issue first:

- New runtime dependencies (we deliberately have zero npm `dependencies`
  and zero build step).
- LLM-driven views (Workflow Graph / Prompt Check stay deterministic).
- Hosted-service features.
- Coupling back to a private OpenClaw fleet (private agent names,
  private workspaces, private prompt paths). See `docs/compatibility.md`.

## Repository layout

```text
src/
  config.ts            poll intervals, paths, port, stuck threshold
  index.ts             startup wiring + graceful shutdown
  api/                 HTTP server + route handlers
  cli/                 /observ channel CLI bridge
  frontend/            zero-dependency vanilla JS dashboard
  ingest/              transcript watcher, parser, classifiers,
                       auth poller, registry scanner, hook reader
  storage/             SQLite schema + repository functions
tests/
  fixtures/            checked-in synthetic transcripts and demo data
  _lib/                shared test utilities (redaction etc.)
  *.test.ts            hermetic suites (run on clean clone)
  data-integrity.test.ts / live-e2e.test.ts / replay-verify.ts /
    cross-check-official.ts / perf-bench.ts   live suites
scripts/
  install.sh upgrade.sh uninstall.sh doctor.sh service.sh
  demo.sh seed-demo-home.ts
  tunnel.sh tunnel-ngrok.sh install_ngrok.py
docs/
  user-manual.md architecture.md workflow-graph.md prompt-check.md
  security.md compatibility.md api-stability.md release-checklist.md
  install/{macos,linux,cloudflare}.md
```

The dashboard runs on Node 22 with `--experimental-sqlite` and
`--experimental-strip-types`. There is no bundler, no transpiler, and no
`node_modules`. Adding either is a meaningful change and needs an issue
first.

## Setup

```bash
git clone https://github.com/houyili/openclaw-observability.git \
  ~/.openclaw/extensions/observability-v2
cd ~/.openclaw/extensions/observability-v2
./scripts/install.sh --dry-run --yes --no-start
```

Hermetic tests run without any OpenClaw install:

```bash
npm run test:hermetic
```

If you have a real OpenClaw runtime, the live correctness sweeps also
work:

```bash
npm run test:integrity
npm run test:live-e2e
npm run test:replay
npm run test:cross-check -- --retry-wait 0
npm run test:perf
```

To see the dashboard without an OpenClaw install:

```bash
./scripts/demo.sh
```

## Commit and PR guidelines

- Keep commits focused. One bug fix per commit. Refactors and unrelated
  cleanups belong in separate commits.
- Commit subject is imperative (`fix: ...`, `feat: ...`, `docs: ...`,
  `test: ...`, `chore: ...`, `ci: ...`).
- Commit body explains the why, not just the what.
- Reference the relevant constitution section if the change implements
  one of `design_doc_read_only/observablity_design_doc.md`'s
  requirements.
- Reference the relevant risk ID (e.g. `R6`, `R11`) if the change
  closes a known risk from
  `agents_design_doc/opensource/08_..._risk_register.md`.
- Add or extend a hermetic test for any code change. Live tests are
  great when relevant, but cannot replace hermetic coverage.

## Testing requirements for a PR

Before opening a PR:

```bash
npm install               # one-time per clone, pulls dev deps
npm run typecheck         # tsc --noEmit (strict)
npm run lint              # biome check
npm run test:hermetic
npm run test:open-source-sanitization
bash -n scripts/*.sh
python3 -m py_compile scripts/install_ngrok.py
git diff --check
```

If your change touches ingest, storage, or the HTTP API, also run:

```bash
npm run test:integrity
npm run test:replay
npm run test:cross-check -- --retry-wait 0
```

To see coverage numbers locally:

```bash
npm run coverage          # writes coverage/index.html + lcov.info
npm run coverage:check    # enforces the current thresholds
```

CI runs hermetic + typecheck + lint + coverage on every push/PR.
Before cutting a release, maintainers also trigger the
`Release validation` workflow manually
(`.github/workflows/release-validation.yml`) which adds Docker build
smoke, format check, and a fresh-clone smoke pass on top.

## Code style

- TypeScript only for `src/` and `tests/`.
- No emojis in code, comments, or test output.
- Comments explain non-obvious intent, trade-offs, or constraints — not
  what the next line does.
- SQL stays inline at the call site so future readers can `grep` for
  table names.
- New columns must use `ensureColumn` in `src/storage/db.ts::migrate` so
  the migration stays idempotent across restarts.

## Security disclosures

See [SECURITY.md](SECURITY.md).

## License

By contributing you agree your contributions are licensed under the
Apache License 2.0 (see [LICENSE](LICENSE)).

## Becoming a Maintainer

See [MAINTAINERS.md](MAINTAINERS.md) for the current maintainers list,
bus factor disclosure, and the path from contributor to maintainer.
