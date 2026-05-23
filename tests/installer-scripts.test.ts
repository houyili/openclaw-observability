/**
 * Hermetic checks for public install/uninstall/upgrade/doctor scripts.
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

const tmpHome = mkdtempSync(join(tmpdir(), "obs-installer-"));
const scripts = ["common.sh", "install.sh", "uninstall.sh", "upgrade.sh", "doctor.sh", "service.sh"];
const baseEnv = {
  ...process.env,
  HOME: tmpHome,
  OPENCLAW_HOME: tmpHome,
  OBS_SERVICE_PLIST: join(tmpHome, "service.plist"),
  OBS_SYSTEMD_SERVICE: join(tmpHome, "openclaw-observability.service"),
};

function run(args: string[], env = baseEnv): string {
  return execFileSync(args[0], args.slice(1), { env, encoding: "utf-8" });
}

console.log("\n=== Group 1: shell syntax ===");
for (const script of scripts) {
  run(["bash", "-n", `scripts/${script}`]);
  assert(true, `bash -n ${script}`);
}

console.log("\n=== Group 2: dry-run public entrypoints ===");
{
  const install = run(["bash", "scripts/install.sh", "--dry-run", "--yes", "--no-start"]);
  assert(install.includes("OpenClaw Observability installer"), "install dry-run starts");
  assert(install.includes("Permission note:"), "install explains service permissions");
  assert(install.includes("DRY-RUN:"), "install dry-run avoids writes");

  const uninstall = run(["bash", "scripts/uninstall.sh", "--dry-run", "--yes"]);
  assert(uninstall.includes("remove service only"), "uninstall states conservative default");
  assert(uninstall.includes("Remove local .env config? [y/N] no"), "--yes preserves default-no destructive prompts");
  assert(!uninstall.includes("rm -rf"), "uninstall --yes dry-run does not purge data/repo by default");

  const upgrade = run(["bash", "scripts/upgrade.sh", "--dry-run", "--yes"]);
  assert(upgrade.includes("git pull --ff-only"), "upgrade dry-run describes fast-forward pull");
  assert(upgrade.includes("DRY-RUN:"), "upgrade dry-run avoids service mutation");
}

console.log("\n=== Group 3: doctor is read-only and tolerant ===");
{
  const doctor = run(["bash", "scripts/doctor.sh"]);
  assert(doctor.includes("Dependencies"), "doctor checks dependencies");
  assert(doctor.includes("Configuration"), "doctor checks configuration");
  assert(doctor.includes("Summary"), "doctor prints summary");
}

console.log(`\n${passed} passed, ${failed} failed`);
rmSync(tmpHome, { recursive: true, force: true });
if (failed) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
