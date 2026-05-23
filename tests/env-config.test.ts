/**
 * Hermetic checks for .env parsing shared by the HTTP server and scripts.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { getEnvValue, parseEnvFile, parseEnvValue } from "../src/env.ts";

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

const tmp = mkdtempSync(join(tmpdir(), "obs-env-"));
const envPath = join(tmp, ".env");
writeFileSync(envPath, [
  "# comment",
  "OBS_AUTH_TOKEN='quoted-token'",
  'OBS_NGROK_DOMAIN="demo.ngrok-free.app"',
  "export OBS_FIXED_URL = https://example.test",
  "EMPTY=",
].join("\n"));

console.log("\n=== Group 1: TypeScript env parser ===");
{
  assert(parseEnvValue(" 'abc' ") === "abc", "single quotes stripped");
  assert(parseEnvValue(' "abc" ') === "abc", "double quotes stripped");
  const parsed = parseEnvFile(`OBS_AUTH_TOKEN="token"\nexport OBS_FIXED_URL = https://x.test\n`);
  assert(parsed.OBS_AUTH_TOKEN === "token", "quoted token parsed");
  assert(parsed.OBS_FIXED_URL === "https://x.test", "export assignment parsed");
  assert(getEnvValue("OBS_AUTH_TOKEN", envPath, {}) === "quoted-token", "file token loaded");
  assert(getEnvValue("OBS_AUTH_TOKEN", envPath, { OBS_AUTH_TOKEN: '"from-process"' }) === "from-process", "process env wins and is unquoted");
  assert(getEnvValue("EMPTY", envPath, {}) === null, "empty value returns null");
}

console.log("\n=== Group 2: shell env helper ===");
{
  const script = join(process.cwd(), "scripts/env.sh");
  const token = execFileSync("sh", ["-c", `. "${script}"; obs_read_env_value OBS_AUTH_TOKEN "${envPath}"`], { encoding: "utf-8" });
  const domain = execFileSync("sh", ["-c", `. "${script}"; obs_read_env_value OBS_NGROK_DOMAIN "${envPath}"`], { encoding: "utf-8" });
  assert(token === "quoted-token", "shell helper strips single quotes");
  assert(domain === "demo.ngrok-free.app", "shell helper strips double quotes");
}

console.log(`\n${passed} passed, ${failed} failed`);
rmSync(tmp, { recursive: true, force: true });
if (failed) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
