/**
 * Hermetic checks for public install/uninstall/upgrade/doctor scripts.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const tmpHome = mkdtempSync(join(tmpdir(), "obs-installer-"));
const scripts = [
  "common.sh",
  "install.sh",
  "uninstall.sh",
  "upgrade.sh",
  "doctor.sh",
  "service.sh",
  "tunnel.sh",
  "tunnel-ngrok.sh",
];
const baseEnv = {
  ...process.env,
  HOME: tmpHome,
  OPENCLAW_HOME: tmpHome,
  OBS_SERVICE_PLIST: join(tmpHome, "service.plist"),
  OBS_SYSTEMD_SERVICE: join(tmpHome, "openclaw-observability.service"),
  OBS_AUTH_TOKEN: "",
  OBS_ALLOW_UNAUTH_TUNNEL: "",
  OBS_NGROK_DOMAIN: "",
  OBS_FIXED_URL: "",
  OBS_ENV_FILE: join(tmpHome, ".env"),
};

function run(args: string[], env = baseEnv): string {
  return execFileSync(args[0], args.slice(1), { env, encoding: "utf-8" });
}

function runMaybe(args: string[], env = baseEnv): { ok: boolean; out: string } {
  try {
    return { ok: true, out: run(args, env) };
  } catch (err: any) {
    return { ok: false, out: String(err.stdout || "") + String(err.stderr || "") };
  }
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

console.log("\n=== Group 4: tunnel URL safety ===");
{
  const cloudflareNoToken = runMaybe(["bash", "scripts/tunnel.sh", "url"]);
  assert(!cloudflareNoToken.ok, "cloudflare tunnel refuses URL without token");
  assert(cloudflareNoToken.out.includes("OBS_AUTH_TOKEN"), "cloudflare tunnel explains token requirement");

  const ngrokNoToken = runMaybe(["bash", "scripts/tunnel-ngrok.sh", "url"]);
  assert(!ngrokNoToken.ok, "ngrok tunnel refuses URL without token");
  assert(ngrokNoToken.out.includes("OBS_AUTH_TOKEN"), "ngrok tunnel explains token requirement");

  const tunnelSource = run(["sed", "-n", "1,220p", "scripts/tunnel.sh"]);
  const ngrokSource = run(["sed", "-n", "1,180p", "scripts/tunnel-ngrok.sh"]);
  assert(tunnelSource.includes("#token="), "cloudflare tunnel uses URL fragment token");
  assert(ngrokSource.includes("#token="), "ngrok tunnel uses URL fragment token");
  assert(!tunnelSource.includes("?token="), "cloudflare tunnel does not put token in query string");
  assert(!ngrokSource.includes("?token="), "ngrok tunnel does not put token in query string");
}

console.log(`\n${passed} passed, ${failed} failed`);
rmSync(tmpHome, { recursive: true, force: true });
if (failed) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
