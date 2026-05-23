#!/usr/bin/env bash
# Runs the full observability-v2 test suite.
#
#   unit            — existing tool/error/parser unit tests (run-tests.ts)
#   invariants      — parser correctness invariants (parser-invariants.test.ts)
#   fixture         — hermetic fixture ingest end-to-end (fixture-ingest.test.ts)
#   auth-stale      — /healthz + frontend pill under broken openclaw CLI
#                     (auth-stale.test.ts)
#   context-length  — Round 6 §1.2 #16 Context Length view (coarse + fine)
#                     (context-length.test.ts) — hermetic
#   cli-commands    — Round 6 §5 channel CLI subcommand handlers
#                     (cli-commands.test.ts) — hermetic
#   frontend-detail — Round 6 follow-up: stacked trace+context detail view
#                     (frontend-detail-view.test.ts) — hermetic
#   workflow-projection — deterministic Workflow Graph backend projection
#                     (workflow-projection.test.ts) — hermetic
#   workflow-frontend — native HTML/CSS Workflow Graph rendering
#                     (workflow-frontend.test.ts) — hermetic
#   watcher-rehome  — transcript-watcher sessionIdToKeyMap TTL refresh +
#                     raw-UUID re-homing (watcher-rehome.test.ts) — hermetic
#   token-backfill  — recomputeSessionCounts token backfill from steps
#                     (token-backfill.test.ts) — hermetic
#   parent-child    — parent-child session relationship from sessions.json
#                     spawnedBy (parent-child.test.ts) — hermetic
#   integrity       — schema + value invariants over LIVE obs.db
#                     (data-integrity.test.ts)
#   live-e2e        — top-N live sessions: transcript → clean parse → DB
#                     → openclaw CLI → HTTP API end-to-end (live-e2e.test.ts)
#   replay          — clean-room reparse vs live obs.db aggregates (replay-verify.ts)
#   cross-check     — obs.db sessions vs `openclaw sessions --json` (cross-check-official.ts)
#   perf            — wall-clock + CPU budgets for hot paths (perf-bench.ts)
#
# Hermetic suites (no live obs-v2 service or live transcripts needed):
#   unit, invariants, fixture, auth-stale, context-length, cli-commands, frontend-detail, workflow-projection, workflow-frontend, watcher-rehome, token-backfill, parent-child
#
# Live suites (need a running obs-v2 + ~/.openclaw/agents/<agent>/sessions/):
#   integrity, live-e2e, replay, cross-check, perf
#
# Use TEST_FILTER env var to run a subset:
#   TEST_FILTER=invariants                       ./run-all.sh
#   TEST_FILTER="unit invariants fixture auth-stale" ./run-all.sh   # CI / clean-clone
#
# Exit 0 = all passed; non-zero = at least one suite failed.

set -u
cd "$(dirname "$0")/.."

NODE_BIN="${NODE_BIN:-$HOME/.local/bin/node}"
[ -x "$NODE_BIN" ] || NODE_BIN="node"
NODE_FLAGS="--experimental-sqlite --experimental-strip-types --no-warnings"

FILTER="${TEST_FILTER:-unit invariants fixture auth-stale context-length cli-commands frontend-detail workflow-projection workflow-frontend watcher-rehome token-backfill parent-child integrity live-e2e replay cross-check perf}"

total_fail=0
run_suite() {
  local name="$1"; local path="$2"
  if [[ " $FILTER " != *" $name "* ]]; then
    echo "[skip] $name"
    return
  fi
  echo ""
  echo "======================================================================"
  echo "  Suite: $name"
  echo "======================================================================"
  if "$NODE_BIN" $NODE_FLAGS "$path"; then
    echo "[ok] $name"
  else
    echo "[FAIL] $name"
    total_fail=$((total_fail + 1))
  fi
}

run_suite "unit"            "tests/run-tests.ts"
run_suite "invariants"      "tests/parser-invariants.test.ts"
run_suite "fixture"         "tests/fixture-ingest.test.ts"
run_suite "auth-stale"      "tests/auth-stale.test.ts"
run_suite "context-length"  "tests/context-length.test.ts"
run_suite "cli-commands"    "tests/cli-commands.test.ts"
run_suite "frontend-detail" "tests/frontend-detail-view.test.ts"
run_suite "workflow-projection" "tests/workflow-projection.test.ts"
run_suite "workflow-frontend" "tests/workflow-frontend.test.ts"
run_suite "watcher-rehome"  "tests/watcher-rehome.test.ts"
run_suite "token-backfill"  "tests/token-backfill.test.ts"
run_suite "parent-child"   "tests/parent-child.test.ts"
run_suite "integrity"       "tests/data-integrity.test.ts"
run_suite "live-e2e"        "tests/live-e2e.test.ts"
run_suite "replay"          "tests/replay-verify.ts"
run_suite "cross-check"     "tests/cross-check-official.ts"
run_suite "perf"            "tests/perf-bench.ts"

echo ""
if [ "$total_fail" -eq 0 ]; then
  echo "=========================================="
  echo "  All suites passed."
  echo "=========================================="
  exit 0
else
  echo "=========================================="
  echo "  $total_fail suite(s) FAILED."
  echo "=========================================="
  exit 1
fi
