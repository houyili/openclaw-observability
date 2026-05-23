import { readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "../config.ts";

export interface RegistryEntry {
  type: "skill" | "script" | "mcp";
  name: string;
  path: string | null;
  discoveredAt: string;
}

/** All directories under OPENCLAW_HOME that may contain skills. */
function getSkillSearchDirs(): string[] {
  const home = CONFIG.OPENCLAW_HOME;
  const dirs = [join(home, "skills")];
  if (!existsSync(home)) return [];
  for (const entry of readdirSync(home, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "workspace" || entry.name.startsWith("workspace-")) {
      dirs.push(join(home, entry.name, "skills"));
    }
  }
  return dirs.filter(d => existsSync(d));
}

export function scanSkills(): RegistryEntry[] {
  const entries: RegistryEntry[] = [];
  for (const skillsDir of getSkillSearchDirs()) {
    for (const d of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const skillPath = join(skillsDir, d.name);
      if (existsSync(join(skillPath, "SKILL.md"))) {
        entries.push({ type: "skill", name: d.name, path: skillPath, discoveredAt: new Date().toISOString() });
      }
    }
  }
  return entries;
}

export function scanScripts(): RegistryEntry[] {
  const entries: RegistryEntry[] = [];
  for (const skillsDir of getSkillSearchDirs()) {
    for (const d of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const scriptsDir = join(skillsDir, d.name, "scripts");
      if (!existsSync(scriptsDir)) continue;
      for (const f of readdirSync(scriptsDir)) {
        if (f.endsWith(".py") || f.endsWith(".sh") || f.endsWith(".mjs")) {
          entries.push({ type: "script", name: f, path: join(scriptsDir, f), discoveredAt: new Date().toISOString() });
        }
      }
    }
  }
  return entries;
}

/**
 * Extract MCP server entries from a parsed JSON-like config object.
 *
 * Two recognised shapes (both are dicts of name -> body):
 *   1. OpenClaw central config:  cfg.mcp.servers
 *   2. mcporter-style files:     cfg.mcpServers
 *
 * Each body can carry `command` (stdio MCP), `args`, `env`, or
 * `baseUrl` / `url` / `endpoint` (HTTP/SSE MCP). The first of those
 * fields, if present, becomes the registry `path` value.
 */
function entriesFromConfigObject(cfg: any, sourcePath: string, now: string): RegistryEntry[] {
  const buckets: Array<Record<string, any>> = [];
  const central = cfg?.mcp?.servers;
  if (central && typeof central === "object" && !Array.isArray(central)) buckets.push(central);
  const mcporter = cfg?.mcpServers;
  if (mcporter && typeof mcporter === "object" && !Array.isArray(mcporter)) buckets.push(mcporter);

  const seen = new Set<string>();
  const out: RegistryEntry[] = [];
  for (const bucket of buckets) {
    for (const [name, body] of Object.entries(bucket)) {
      if (!name || typeof name !== "string") continue;
      if (seen.has(name)) continue;
      seen.add(name);
      const b = body && typeof body === "object" ? body as Record<string, unknown> : {};
      const path = (typeof b.command === "string" && b.command)
        || (typeof b.baseUrl === "string" && b.baseUrl)
        || (typeof b.url === "string" && b.url)
        || (typeof b.endpoint === "string" && b.endpoint)
        || sourcePath;
      out.push({
        type: "mcp",
        name,
        path: typeof path === "string" ? path : sourcePath,
        discoveredAt: now,
      });
    }
  }
  return out;
}

function safeReadJson(path: string): any | null {
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Scan MCP definitions from `~/.openclaw/openclaw.json` (central config).
 *
 * Reads `mcp.servers` (OpenClaw native) and also tolerates a top-level
 * `mcpServers` (mcporter-style) on the same file so we degrade
 * gracefully on either layout.
 */
export function scanMcpFromOpenclawConfig(): RegistryEntry[] {
  const path = join(CONFIG.OPENCLAW_HOME, "openclaw.json");
  if (!existsSync(path)) return [];
  const cfg = safeReadJson(path);
  if (!cfg) return [];
  return entriesFromConfigObject(cfg, path, new Date().toISOString());
}

/**
 * Scan MCP definitions from `~/.openclaw/mcp/*.json` (mcporter-style
 * per-tool config files). Each file's `mcpServers` block contributes
 * one or more entries.
 */
export function scanMcpFromMcpDir(): RegistryEntry[] {
  const dir = join(CONFIG.OPENCLAW_HOME, "mcp");
  if (!existsSync(dir)) return [];
  let files: string[];
  try { files = readdirSync(dir); } catch { return []; }
  const now = new Date().toISOString();
  const seen = new Set<string>();
  const out: RegistryEntry[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    // Skip example/template files to avoid surfacing fake "auth" entries.
    if (f.includes(".example.") || f.endsWith(".template.json")) continue;
    const full = join(dir, f);
    try { if (!statSync(full).isFile()) continue; } catch { continue; }
    const cfg = safeReadJson(full);
    if (!cfg) continue;
    for (const entry of entriesFromConfigObject(cfg, full, now)) {
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      out.push(entry);
    }
  }
  return out;
}

/**
 * Scan all installed MCP definitions, deduplicating by name. Entries
 * from `openclaw.json` win over per-tool mcp/*.json files because the
 * central config is the OpenClaw source of truth.
 */
export function scanMcps(): RegistryEntry[] {
  const central = scanMcpFromOpenclawConfig();
  const perTool = scanMcpFromMcpDir();
  const byName = new Map<string, RegistryEntry>();
  for (const e of central) byName.set(e.name, e);
  for (const e of perTool) if (!byName.has(e.name)) byName.set(e.name, e);
  return [...byName.values()];
}

export function scanAll(): RegistryEntry[] {
  return [...scanSkills(), ...scanScripts(), ...scanMcps()];
}
