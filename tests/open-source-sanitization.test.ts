/**
 * Hermetic guard for checked-in test data.
 *
 * Open-source tests must be synthetic: no personal home paths, company names,
 * live agent keys, or user/channel identifiers that look copied from a real
 * runtime. Keep this test small and strict so fixture leaks fail in CI.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const scanRoots = [join(repoRoot, "tests"), join(repoRoot, "config")].filter(existsSync);

const textExt = new Set([".ts", ".js", ".json", ".jsonl", ".md", ".sh", ".txt"]);
function ext(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot) : "";
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) out.push(...walk(path));
    else if (textExt.has(ext(path))) out.push(path);
  }
  return out;
}

const banned = [
  { name: "company/user slug", re: new RegExp("byte" + "dance", "i") },
  { name: "macOS personal home path", re: new RegExp("\\\\/Users\\\\/[^\\s\"'`]+") },
  { name: "live workspace artifact path", re: new RegExp("Documents\\/workspace|openclaw_" + "research" + "er", "i") },
  { name: "real-looking chat open id", re: new RegExp("\\bo" + "u_[a-z0-9]{3,}", "i") },
  { name: "live private agent key", re: new RegExp("agent:" + "research" + "er", "i") },
];

console.log("\n=== Open-source test fixture sanitization ===");
const files = scanRoots.flatMap(walk);
let leaks = 0;
for (const file of files) {
  const text = readFileSync(file, "utf-8");
  for (const b of banned) {
    const m = text.match(b.re);
    if (!m) continue;
    leaks++;
    assert(false, `${relative(repoRoot, file)} has no ${b.name}`, `matched ${JSON.stringify(m[0])}`);
  }
}
assert(leaks === 0, "checked-in hermetic test data has no sensitive local identifiers");
assert(files.length > 0, "sanitization scan covered checked-in test/config files", `files=${files.length}`);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
