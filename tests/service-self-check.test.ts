/**
 * Hermetic checks for launchd plist generation/self-check.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

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

const tmpHome = mkdtempSync(join(tmpdir(), "obs-service-"));
const service = join(process.cwd(), "scripts/service.sh");
const nodeBin = process.execPath;

console.log("\n=== Group 1: launchd plist generation ===");
{
  const env = { ...process.env, HOME: tmpHome, NODE_BIN: nodeBin, OBS_SERVICE_PLIST: join(tmpHome, "service.plist") };
  const generated = execFileSync("bash", [service, "generate-plist"], { env, encoding: "utf-8" });
  const check = execFileSync("bash", [service, "check"], { env, encoding: "utf-8" });
  assert(generated.includes("Generated:"), "generate-plist reports generated file");
  assert(check.includes("Service plist OK"), "check accepts generated plist");
  assert(!check.includes("__HOME__") && !check.includes("__NODE__"), "check output has no template placeholders");
}

console.log("\n=== Group 2: systemd user unit generation ===");
{
  const env = { ...process.env, HOME: tmpHome, NODE_BIN: nodeBin, OBS_SYSTEMD_SERVICE: join(tmpHome, "openclaw-observability.service") };
  const generated = execFileSync("bash", [service, "generate-systemd"], { env, encoding: "utf-8" });
  const check = execFileSync("bash", [service, "check-systemd"], { env, encoding: "utf-8" });
  assert(generated.includes("Generated:"), "generate-systemd reports generated file");
  assert(check.includes("Systemd unit OK"), "check-systemd accepts generated unit");
  assert(!check.includes("__HOME__") && !check.includes("__NODE__"), "systemd check output has no template placeholders");
}

console.log(`\n${passed} passed, ${failed} failed`);
rmSync(tmpHome, { recursive: true, force: true });
if (failed) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
