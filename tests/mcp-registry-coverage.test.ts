/**
 * Hermetic coverage test for the MCP registry contract.
 *
 * Constitution §4.3.1 requires every installed MCP to surface on Tab 4
 * even if it has never been called, and §约束.13 requires the first
 * scan to be limited to `~/.openclaw`. This test pins both promises:
 *
 *   1. `openclaw.json::mcp.servers` produces registry entries.
 *   2. `~/.openclaw/mcp/*.json::mcpServers` produces registry entries
 *      and example/template files are skipped.
 *   3. `getMcpStats()` returns those entries with call_count = 0 even
 *      when there are zero `node_type = 'MCP_CALL'` rows.
 *   4. When some MCPs have been called and some have not, both groups
 *      appear in the result (used at the top, unused at the bottom).
 *   5. `/api/mcps` mirrors the same set via `handleMcpsRoute`.
 *
 * The test is hermetic: it creates a temp `$OPENCLAW_HOME` with a
 * synthetic `openclaw.json` and `mcp/*.json` files BEFORE importing
 * any obs-v2 module so `CONFIG` resolves to the temp dir.
 *
 * Run:
 *   node --experimental-sqlite --experimental-strip-types --no-warnings \
 *     tests/mcp-registry-coverage.test.ts
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

// ─── Hermetic OPENCLAW_HOME ─────────────────────────────────────
const tmpHome = mkdtempSync(join(tmpdir(), "obs-mcp-registry-"));
mkdirSync(join(tmpHome, "logs/observability-v2"), { recursive: true });
mkdirSync(join(tmpHome, "mcp"), { recursive: true });
process.env.OPENCLAW_HOME = tmpHome;

// openclaw.json: central config with one mcp server
writeFileSync(
  join(tmpHome, "openclaw.json"),
  JSON.stringify({
    agents: {},
    mcp: {
      servers: {
        notion: {
          command: "npx",
          args: ["-y", "@notionhq/notion-mcp-server"],
          env: { NOTION_API_KEY: "fake" },
        },
      },
    },
  }),
);

// mcp/research-search.json: mcporter-style file with three servers
writeFileSync(
  join(tmpHome, "mcp/research-search.json"),
  JSON.stringify({
    mcpServers: {
      exa: { baseUrl: "https://mcp.exa.ai/mcp?tools=web_search_exa" },
      reddit: { command: "reddit-mcp-buddy" },
      hf: { baseUrl: "https://huggingface.co/mcp" },
    },
    imports: [],
  }),
);

// mcp/research-search-auth.example.json: example file that must be skipped
writeFileSync(
  join(tmpHome, "mcp/research-search-auth.example.json"),
  JSON.stringify({
    mcpServers: {
      "fake-auth-leak": { command: "should-not-appear" },
    },
  }),
);

// Now safe to import obs-v2 modules
const { scanAll, scanMcps, scanMcpFromOpenclawConfig, scanMcpFromMcpDir } = await import(
  "../src/ingest/registry-scanner.ts"
);
const { upsertRegistryEntries } = await import("../src/storage/registry-repo.ts");
const { getMcpStats } = await import("../src/storage/steps-repo.ts");
const { getDb, closeDb } = await import("../src/storage/db.ts");
const { handleMcpsRoute } = await import("../src/api/routes-mcps.ts");

// ─── 1. scanMcpFromOpenclawConfig ───────────────────────────────
console.log("\n=== 1. scanMcpFromOpenclawConfig ===");
const central = scanMcpFromOpenclawConfig();
assert(central.length === 1, "openclaw.json yields 1 entry");
assert(central[0]?.name === "notion", "name is 'notion'");
assert(central[0]?.path === "npx", "path falls back to command");
assert(central[0]?.type === "mcp", "type is mcp");

// ─── 2. scanMcpFromMcpDir ───────────────────────────────────────
console.log("\n=== 2. scanMcpFromMcpDir ===");
const perTool = scanMcpFromMcpDir();
const perToolNames = new Set(perTool.map((e) => e.name));
assert(perTool.length === 3, "per-tool dir yields 3 entries (example file skipped)");
assert(perToolNames.has("exa"), "exa is present");
assert(perToolNames.has("reddit"), "reddit is present");
assert(perToolNames.has("hf"), "hf is present");
assert(!perToolNames.has("fake-auth-leak"), "example file is excluded");

// ─── 3. scanMcps dedupe ─────────────────────────────────────────
console.log("\n=== 3. scanMcps dedupe ===");
const all = scanMcps();
const allNames = new Set(all.map((e) => e.name));
assert(all.length === 4, "scanMcps merges 1 + 3 = 4 unique names");
assert(
  allNames.has("notion") && allNames.has("exa") && allNames.has("reddit") && allNames.has("hf"),
  "all four names survive merge",
);

// ─── 4. scanAll includes mcps ───────────────────────────────────
console.log("\n=== 4. scanAll includes mcps ===");
const everything = scanAll();
const mcpsInAll = everything.filter((e) => e.type === "mcp");
assert(mcpsInAll.length === 4, "scanAll() returns the 4 MCPs alongside skills/scripts");

// ─── 5. registry + getMcpStats unused MCPs ──────────────────────
console.log("\n=== 5. getMcpStats lists installed-but-unused MCPs ===");
upsertRegistryEntries(everything);
const stats = getMcpStats("all");
const statsByName = new Map(stats.map((r: any) => [r.name, r]));
assert(stats.length === 4, "getMcpStats returns all 4 installed MCPs (none used)");
for (const name of ["notion", "exa", "reddit", "hf"]) {
  const row = statsByName.get(name);
  assert(!!row, `row for ${name} is present`);
  assert(row?.call_count === 0, `${name}.call_count is 0 when unused`);
  assert(row?.error_count === 0, `${name}.error_count is 0 when unused`);
  assert(row?.error_rate === 0, `${name}.error_rate is 0 when unused`);
}

// ─── 6. mix of used and unused ──────────────────────────────────
console.log("\n=== 6. mix of used and unused MCPs ===");
const db = getDb();
// Simulate 2 successful + 1 errored call for `exa`
db.prepare(`
  INSERT INTO steps (step_id, session_key, run_id, seq, ts, ts_epoch_ms,
    role, node_type, tool_name, mcp_server, mcp_tool, status)
  VALUES
    ('s1', 'agent:demo:chat:direct:u1', 'r1', 0, '2026-05-24T00:00:00Z', ${Date.now() - 10_000},
     'assistant', 'MCP_CALL', 'exa_web_search', 'exa', 'exa', 'ok'),
    ('s2', 'agent:demo:chat:direct:u1', 'r1', 1, '2026-05-24T00:00:01Z', ${Date.now() - 5_000},
     'assistant', 'MCP_CALL', 'exa_web_search', 'exa', 'exa', 'ok'),
    ('s3', 'agent:demo:chat:direct:u1', 'r1', 2, '2026-05-24T00:00:02Z', ${Date.now() - 1_000},
     'assistant', 'MCP_CALL', 'exa_web_search', 'exa', 'exa', 'error')
`).run();

const stats2 = getMcpStats("all");
const stats2ByName = new Map(stats2.map((r: any) => [r.name, r]));
assert(stats2.length === 4, "all 4 MCPs still listed");
assert(stats2ByName.get("exa")?.call_count === 3, "exa.call_count = 3");
assert(stats2ByName.get("exa")?.error_count === 1, "exa.error_count = 1");
assert(Math.abs((stats2ByName.get("exa")?.error_rate || 0) - 1 / 3) < 1e-9, "exa.error_rate ≈ 1/3");
assert(stats2ByName.get("notion")?.call_count === 0, "notion (unused) still call_count = 0");
assert(stats2ByName.get("reddit")?.call_count === 0, "reddit (unused) still call_count = 0");

// Used MCP should sort ahead of unused ones (ORDER BY call_count DESC, name ASC)
const firstName = (stats2[0] as any).name;
assert(firstName === "exa", "exa appears first because it has the most calls");

// ─── 7. handleMcpsRoute mirrors the registry ────────────────────
console.log("\n=== 7. handleMcpsRoute mirrors the registry ===");
let httpPayload: any = null;
const fakeSendJson = (_res: any, data: unknown) => {
  httpPayload = data;
};
handleMcpsRoute({ range: "all" }, {} as any, fakeSendJson as any);

assert(httpPayload != null, "handleMcpsRoute responded");
assert(Array.isArray(httpPayload?.mcps), "payload has mcps array");
assert(httpPayload?.mcps?.length === 4, "payload lists all 4 installed MCPs");
const httpByName = new Map((httpPayload.mcps as any[]).map((m) => [m.name, m]));
assert(httpByName.get("notion")?.installed === true, "notion is installed=true");
assert(httpByName.get("notion")?.status === "active", "notion status is active");
assert(httpByName.get("notion")?.callCount === 0, "notion callCount = 0 in payload");
assert(httpByName.get("exa")?.callCount === 3, "exa callCount = 3 in payload");
assert(httpByName.get("exa")?.errorRate > 0, "exa errorRate > 0 in payload");

// ─── 8. rankings don't include unused MCPs ──────────────────────
console.log("\n=== 8. rankings exclude unused MCPs ===");
const topUsedNames = (httpPayload.rankings?.topUsed || []).map((r: any) => r.name);
assert(topUsedNames.includes("exa"), "topUsed includes exa");
assert(!topUsedNames.includes("notion"), "topUsed excludes unused notion");
assert(!topUsedNames.includes("reddit"), "topUsed excludes unused reddit");

closeDb();

console.log(`\nMCP registry coverage: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
