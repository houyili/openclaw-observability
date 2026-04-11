/**
 * Performance micro-benchmark for obs.db hot paths.
 *
 * Runs each hot-path function against the live DB, records wall-clock and
 * CPU time, and fails if any single call exceeds its budget. These budgets
 * are chosen to detect regressions, NOT to enforce an absolute SLO.
 *
 *   recomputeAllSessionOps (full pass)     : ≤ 250 ms
 *   recomputeAllSessionCounts              : ≤ 500 ms
 *   getSkillStats('week')                  : ≤ 100 ms
 *   getScriptStats('week')                 : ≤ 100 ms
 *   getMcpStats('week')                    : ≤ 100 ms
 *   getSummaryStats()                      : ≤ 200 ms
 *
 * Run:
 *   node --experimental-sqlite --experimental-strip-types --no-warnings \
 *     tests/perf-bench.ts
 */

import { recomputeAllSessionOps, recomputeAllSessionCounts } from "../src/storage/sessions-repo.ts";
import { getSkillStats, getScriptStats, getMcpStats, getSummaryStats } from "../src/storage/steps-repo.ts";

const BUDGETS: Record<string, number> = {
  recomputeAllSessionOps: 250,
  recomputeAllSessionCounts: 500,
  getSkillStats_week: 100,
  getScriptStats_week: 100,
  getMcpStats_week: 100,
  getSummaryStats: 200,
};

interface Result { name: string; wallMs: number; cpuMs: number; budget: number; ok: boolean; }

function bench(name: string, fn: () => unknown): Result {
  const wallStart = process.hrtime.bigint();
  const cpuStart = process.cpuUsage();
  fn();
  const wallEnd = process.hrtime.bigint();
  const cpuEnd = process.cpuUsage(cpuStart);
  const wallMs = Number(wallEnd - wallStart) / 1_000_000;
  const cpuMs = (cpuEnd.user + cpuEnd.system) / 1_000;
  const budget = BUDGETS[name] ?? Infinity;
  return { name, wallMs, cpuMs, budget, ok: wallMs <= budget };
}

const results: Result[] = [];

// Warm the page cache (first call reads from disk).
recomputeAllSessionCounts();

results.push(bench("recomputeAllSessionOps", () => recomputeAllSessionOps()));
results.push(bench("recomputeAllSessionCounts", () => recomputeAllSessionCounts()));
results.push(bench("getSkillStats_week", () => getSkillStats("week")));
results.push(bench("getScriptStats_week", () => getScriptStats("week")));
results.push(bench("getMcpStats_week", () => getMcpStats("week")));
results.push(bench("getSummaryStats", () => getSummaryStats()));

console.log("\n=== Perf benchmark ===");
console.log("  name                              wall     cpu    budget   ok");
console.log("  ".padEnd(68, "─"));
for (const r of results) {
  const mark = r.ok ? "✅" : "❌";
  console.log(
    `  ${r.name.padEnd(32)}  ${r.wallMs.toFixed(1).padStart(6)}ms  ${r.cpuMs.toFixed(1).padStart(6)}ms  ${r.budget.toString().padStart(5)}ms  ${mark}`,
  );
}

const failed = results.filter(r => !r.ok);
if (failed.length > 0) {
  console.log(`\n  RESULT: FAIL — ${failed.length}/${results.length} over budget`);
  process.exit(1);
}
console.log("\n  RESULT: PASS — all hot paths inside budget");
process.exit(0);
