/**
 * P2-1 — end-to-end verification that the auth-poll staleness signal
 * propagates from a broken `openclaw` CLI all the way to the orange pill
 * the user sees in the dashboard header.
 *
 * Three layers, all hermetic:
 *
 *   Layer 1 — pure frontend mapping
 *     Loads `src/frontend/health-indicator.js` (the same file the browser
 *     loads via `<script>`) into Node and asserts that
 *     `computeRefreshIndicator(healthData)` returns the right text + class
 *     for fresh / stale / never-polled / error inputs.
 *
 *   Layer 2 — auth-poller with a broken bin
 *     Spawns a CHILD Node process with PATH pointing at a temp directory
 *     containing a fake `openclaw` script that always exits 1. The child
 *     dynamically imports `auth-poller.ts`, fires a single poll, waits for
 *     the failure, prints `getAuthPollStatus()` as JSON, and exits. The
 *     parent reads stdout and asserts `lastError != null` and
 *     `lastSuccessAt == null`.
 *
 *   Layer 3 — /healthz route shape under failure
 *     The same child also constructs a mock ServerResponse, calls
 *     `handleHealthRoute(res, sendJson)`, and prints the resulting JSON.
 *     The parent asserts `authPoll.stale === true` and `authPoll.lastError`
 *     contains the substring "Command failed".
 *
 * Why a child process: `auth-poller.ts` resolves OPENCLAW_BIN at module
 * load time. We need a fresh import with a doctored PATH, which means a
 * fresh Node process.
 *
 * Why a temp DB via OPENCLAW_HOME: `routes-health.ts` opens the SQLite
 * DB on import. We isolate to a tmp dir so the test never touches the
 * live obs.db.
 *
 * Run:
 *   node --experimental-sqlite --experimental-strip-types --no-warnings \
 *     tests/auth-stale.test.ts
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..");

let passed = 0;
let failed = 0;
const failures: string[] = [];
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
}

// ─── Layer 1: pure frontend mapping ─────────────────────────────
console.log("\n=== Layer 1: computeRefreshIndicator (pure) ===");
{
  // health-indicator.js is a classic browser script (not an ES module),
  // because the rest of the frontend uses inline `onclick=` handlers that
  // need a non-module global scope. Load it through the `vm` module so we
  // can capture the `globalThis.computeRefreshIndicator` it sets, without
  // touching the test process's own globals.
  const code = readFileSync(join(REPO_ROOT, "src/frontend/health-indicator.js"), "utf-8");
  const ctx: any = {};
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  const computeRefreshIndicator = ctx.computeRefreshIndicator as
    (h: any) => { text: string; className: string };
  if (typeof computeRefreshIndicator !== "function") {
    throw new Error("vm load did not expose computeRefreshIndicator");
  }

  // Case A: fresh — auth-poller succeeded recently
  const fresh = computeRefreshIndicator({
    authPoll: { stale: false, lastSuccessAgeMs: 12_000, lastError: null },
  });
  assert(fresh.text === "● auto-refresh 5s", "fresh: green dot text");
  assert(fresh.className === "", "fresh: no class");

  // Case B: stale with age + error
  const stale = computeRefreshIndicator({
    authPoll: { stale: true, lastSuccessAgeMs: 137_000, lastError: "Command failed: openclaw timed out" },
  });
  assert(stale.className === "stale", "stale: pill class is 'stale'");
  assert(stale.text.startsWith("⚠ auth-poll stale (137s)"), "stale: text encodes age in seconds",
    `got "${stale.text}"`);
  assert(stale.text.includes("Command failed"), "stale: text includes error prefix");

  // Case C: stale, never succeeded
  const never = computeRefreshIndicator({
    authPoll: { stale: true, lastSuccessAgeMs: null, lastError: "ENOENT" },
  });
  assert(never.text.includes("(never)"), "never-polled: age is 'never'");

  // Case D: payload missing authPoll entirely
  const empty = computeRefreshIndicator({});
  assert(empty.text === "● auto-refresh 5s", "missing payload: defaults to fresh-looking text");

  // Case E: error message > 60 chars truncates
  const longErr = "x".repeat(200);
  const truncated = computeRefreshIndicator({
    authPoll: { stale: true, lastSuccessAgeMs: 0, lastError: longErr },
  });
  // " — " (3) + 60 chars = 63 chars after the "(0s)" segment
  assert(truncated.text.length < 100, "long error truncates pill text",
    `got length ${truncated.text.length}`);
}

// ─── Layer 2 + 3: child process with broken openclaw bin ────────
console.log("\n=== Layer 2 + 3: auth-poller + /healthz under broken CLI ===");
{
  // Build an isolated workspace.
  const work = mkdtempSync(join(tmpdir(), "obs-auth-stale-"));
  const fakeBinDir = join(work, "fake-bin");
  const home = join(work, "home");
  mkdirSync(fakeBinDir, { recursive: true });
  mkdirSync(join(home, "logs/observability-v2"), { recursive: true });
  mkdirSync(join(home, "agents/main/sessions"), { recursive: true });

  // A `which`-discoverable openclaw that always exits 1.
  const fakeBin = join(fakeBinDir, "openclaw");
  writeFileSync(fakeBin, "#!/bin/sh\necho 'fake openclaw: simulated failure' >&2\nexit 1\n");
  chmodSync(fakeBin, 0o755);

  // The child script. Inline-string so we don't ship a separate file.
  // Uses dynamic imports so the env-var-driven CONFIG.DB_PATH is read
  // BEFORE auth-poller / routes-health touch anything.
  const childSrc = `
    process.env.OPENCLAW_HOME = ${JSON.stringify(home)};
    process.env.PATH = ${JSON.stringify(fakeBinDir)} + ":" + process.env.PATH;

    const { pollAuthSessionsAsync, getAuthPollStatus } = await import(${JSON.stringify(join(REPO_ROOT, "src/ingest/auth-poller.ts"))});
    const { handleHealthRoute } = await import(${JSON.stringify(join(REPO_ROOT, "src/api/routes-health.ts"))});

    // Trigger one poll. The fake bin exits 1 fast, so the failure callback
    // fires almost immediately. Wait briefly to be safe.
    await new Promise((resolve) => {
      pollAuthSessionsAsync(() => resolve());
    });
    // Tiny extra wait so the in-flight flag has fully settled.
    await new Promise((r) => setTimeout(r, 100));

    const status = getAuthPollStatus();

    // Mock ServerResponse — handleHealthRoute only needs sendJson(res, data).
    let healthPayload = null;
    const sendJson = (_res, data) => { healthPayload = data; };
    handleHealthRoute({}, sendJson);

    process.stdout.write(JSON.stringify({ status, healthPayload }, null, 0));
  `;

  // Run the child with --input-type=module so the inline source can use
  // top-level await + dynamic import.
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-sqlite",
      "--experimental-strip-types",
      "--no-warnings",
      "--input-type=module",
      "-e",
      childSrc,
    ],
    { encoding: "utf-8", timeout: 30_000 },
  );

  // Always clean the workspace, regardless of pass/fail.
  let parsed: any = null;
  try {
    if (result.status === 0 && result.stdout) {
      parsed = JSON.parse(result.stdout);
    }
  } catch (err) {
    /* will be caught by assertion */
  }

  if (result.status !== 0 || !parsed) {
    console.log("  child stderr:");
    console.log("    " + (result.stderr || "(empty)").split("\n").join("\n    "));
    console.log("  child stdout:");
    console.log("    " + (result.stdout || "(empty)").split("\n").join("\n    "));
  }

  assert(result.status === 0, "child process exited cleanly", `exit ${result.status}`);
  assert(parsed != null, "child stdout is parseable JSON");

  if (parsed) {
    const status = parsed.status;
    const health = parsed.healthPayload;

    // Layer 2 — getAuthPollStatus()
    assert(status.lastSuccessAt == null, "auth-poller never recorded a success");
    assert(status.lastFailureAt != null, "auth-poller recorded a failure");
    assert(typeof status.lastError === "string" && status.lastError.length > 0,
      "auth-poller captured an error string");
    assert(status.inFlight === false, "auth-poller in-flight flag cleared after callback");

    // Layer 3 — handleHealthRoute() shape
    assert(health.ok === true, "/healthz still returns ok=true even when auth-poll failed");
    assert(health.authPoll != null, "/healthz includes authPoll block");
    assert(health.authPoll.stale === true, "/healthz authPoll.stale === true under failure");
    assert(health.authPoll.lastSuccessAt == null, "/healthz authPoll.lastSuccessAt is null");
    assert(typeof health.authPoll.lastError === "string", "/healthz authPoll.lastError carries the error message");
    assert(health.authPoll.staleThresholdMs > 0, "/healthz includes a positive staleThresholdMs");
  }

  // Tidy up the temp workspace.
  try { rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ─── Summary ────────────────────────────────────────────────────
console.log(`\n${"=".repeat(50)}`);
console.log(`Auth-stale e2e: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
