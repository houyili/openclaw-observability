# 0003: Use `node:sqlite` instead of `better-sqlite3` for storage

- Status: Accepted
- Date: 2026-04-05
- Deciders: @houyili
- Related: v0 architecture snapshot

## Context

The dashboard needs a small, embedded, transactional store. SQLite is the
right shape — it is what Phoenix and several similar tools use, and it
matches the local-first, zero-hosted-service posture of OpenClaw
Observability.

There are two practical SQLite bindings available to a Node 22 program:

- `better-sqlite3`: the long-standing, well-known third-party module.
  Native code, distributed via prebuilt platform binaries with a
  `node-gyp` fallback. Requires `npm install` and a working compiler /
  Python toolchain on any platform that does not have a prebuild.
- `node:sqlite`: a builtin module shipped with Node 22 itself. Synchronous
  API, WAL mode, prepared statements, transactions. No native module, no
  install step, no compiler needed.

The project has two hard constraints that make this choice asymmetric:

1. Zero npm runtime dependencies. The published `package.json` carries
   no `dependencies`.
2. Zero build step. There is no bundler and no `node_modules` is shipped.

Adding `better-sqlite3` would break both constraints — even with prebuilds
it pulls in install-time machinery and platform-specific binaries.

## Decision

Use `node:sqlite` for all storage. Run Node with `--experimental-sqlite`
on Node 22 and stop passing the flag once the runtime moves to Node 23+,
where the module is stable.

WAL mode is enabled at startup. All queries use prepared statements.
Schema migration is idempotent and uses an `ensureColumn` helper so the
DB heals across version bumps without manual intervention.

## Consequences

What becomes easier:

- `git clone && node src/index.ts` works on any platform that has Node 22
  installed. No native compile step, no Python, no node-gyp.
- The publish surface is just TypeScript files plus a `package.json` with
  zero dependencies. Audit is trivial.
- Operators on hardened environments don't need to allow native binary
  downloads.

What becomes harder:

- The project pins to Node 22+. We cannot run on Node 20 LTS.
- `node:sqlite` is currently marked experimental on Node 22. The API has
  been stable across Node 22 patch releases, but a regression upstream
  would land directly on us.
- Some niche features that `better-sqlite3` exposes (custom collations,
  loadable extensions) are not yet exposed by `node:sqlite`. We have not
  needed any of them.

What we accept:

- Coupling to Node version cadence. If `node:sqlite` ever regresses or
  is removed, we will fall back to `better-sqlite3` behind a thin
  wrapper, which is the only place in `src/storage/` that calls SQLite
  directly.
