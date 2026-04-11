#!/usr/bin/env bash
# Runs the full observability-v2 test suite.
#
#   unit         — existing tool/error/parser unit tests (run-tests.ts)
#   invariants   — parser correctness invariants (parser-invariants.test.ts)
#   replay       — clean-room reparse vs live obs.db aggregates (replay-verify.ts)
#   cross-check  — obs.db sessions vs `openclaw sessions --json` (cross-check-official.ts)
#
# Use TEST_FILTER env var to run a subset:  TEST_FILTER=invariants ./run-all.sh
#
# Exit 0 = all passed; non-zero = at least one suite failed.

set -u
cd "$(dirname "$0")/.."

NODE_BIN="${NODE_BIN:-$HOME/.local/bin/node}"
[ -x "$NODE_BIN" ] || NODE_BIN="node"
NODE_FLAGS="--experimental-sqlite --experimental-strip-types --no-warnings"

FILTER="${TEST_FILTER:-unit invariants replay cross-check perf}"

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

run_suite "unit"        "tests/run-tests.ts"
run_suite "invariants"  "tests/parser-invariants.test.ts"
run_suite "replay"      "tests/replay-verify.ts"
run_suite "cross-check" "tests/cross-check-official.ts"
run_suite "perf"        "tests/perf-bench.ts"

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
