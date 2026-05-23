/**
 * Hermetic tests for tests/_lib/redact.ts.
 *
 * The helper is only used by live tests so it never runs in CI
 * itself, but we still want a small unit suite so any future change
 * to the redaction format can be caught before it lands.
 *
 * Run:
 *   node --experimental-sqlite --experimental-strip-types --no-warnings \
 *     tests/redact.test.ts
 */

import { redactKey, redactId } from "./_lib/redact.ts";

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\n=== redactKey ===");
{
  // Synthetic generic key — no real chat/group/user IDs in this file.
  const k = "agent:demo:lark:direct:syntheticIdentifier1234567890abcd";
  const r = redactKey(k);
  assert(r.startsWith("agent:demo:lark:direct:"), "preserves structural prefix");
  assert(!r.includes("syntheticIdentifier1234567890"), "drops the identifying id body");
  assert(r.endsWith("abcd"), "keeps the last 4 chars for correlation");
  assert(/^<[0-9a-f]{8}>/.test(r.split(":direct:")[1]), "tail uses <hash8>... prefix");
  // Same key → same redacted form
  assert(redactKey(k) === r, "stable: same input yields same output");
}

console.log("\n=== redactKey on group / cron / subagent variants ===");
{
  // All keys here are synthetic. The point is to exercise the
  // 4-segment and 5-segment branches of `redactKey` — not to embed
  // any real local chat / group / user identifier.
  const variants: Array<[string, string, string, string]> = [
    ["lark-group",  "agent:demo:lark:group:syntheticGroupId1111aaaa",
     "agent:demo:lark:group:",  "syntheticGroupId1111aaaa"],
    ["cron-4parts", "agent:demo:cron:00000000-1111-2222-3333-44445555bbbb",
     "agent:demo:cron:",        "00000000-1111-2222-3333-44445555bbbb"],
    ["chat-direct", "agent:demo:chat:direct:syntheticUserId2222cccc",
     "agent:demo:chat:direct:", "syntheticUserId2222cccc"],
  ];
  for (const [tag, v, prefix, tail] of variants) {
    const r = redactKey(v);
    assert(r.startsWith(prefix), `${tag}: prefix preserved`);
    assert(!r.includes(tail), `${tag}: no raw id leak`);
    assert(r.endsWith(tail.slice(-4)), `${tag}: suffix 4 preserved`);
  }
}

console.log("\n=== redactKey on inline cron name (3 parts) ===");
{
  // 3-part inline cron names like `agent:<agent>:<task-name>` are
  // already visible in the official OpenClaw dashboard and are not
  // identifiers, so they are kept verbatim. We use a synthetic
  // task name here.
  const k = "agent:demo:demo-cron-task";
  assert(redactKey(k) === k, "3-part inline cron name is kept verbatim");
}

console.log("\n=== redactKey edge cases ===");
{
  assert(redactKey(null) === "(none)", "null → (none)");
  assert(redactKey(undefined) === "(none)", "undefined → (none)");
  assert(redactKey("") === "(none)", "empty → (none)");
  // 1- and 2-part keys do not match any known OpenClaw shape; hash them.
  const r1 = redactKey("foo");
  assert(r1.startsWith("<") && r1.endsWith("...foo"),
    "1-part non-structured key is hashed");
  const r2 = redactKey("foo:bar");
  assert(!r2.includes("foo:bar") || r2.startsWith("<"),
    "2-part non-structured key is hashed");
}

console.log("\n=== redactId ===");
{
  const id = "188f5830-305b-42ee-be30-cefd5a848e28";
  const r = redactId(id);
  assert(r.startsWith("<"), "starts with <hash>");
  assert(r.endsWith("8e28"), "keeps last 4 chars");
  assert(!r.includes("188f5830"), "drops full id");
  assert(redactId(id) === r, "stable");
  assert(redactId(null) === "(none)", "null → (none)");
  assert(redactId("") === "(none)", "empty → (none)");
}

console.log("\n=== correlation: same input → same output ===");
{
  // Synthetic generic keys — not real local IDs.
  const k1 = "agent:demo:lark:direct:syntheticUserAlphaXXXXXXXXXXXX1234";
  const k2 = "agent:demo:lark:direct:syntheticUserAlphaXXXXXXXXXXXX1234";
  const k3 = "agent:demo:lark:direct:syntheticUserBetaYYYYYYYYYYYYY1234";
  assert(redactKey(k1) === redactKey(k2), "two messages about the same key match");
  assert(redactKey(k1) !== redactKey(k3),
    "two different keys with the same prefix and suffix-4 don't collide");
}

console.log(`\nredact: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
