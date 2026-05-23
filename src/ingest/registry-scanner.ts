import { readdirSync, existsSync, readFileSync } from "node:fs";
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

export function scanMcpFromSettings(): RegistryEntry[] {
  try {
    const raw = readFileSync(join(CONFIG.OPENCLAW_HOME, "settings.json"), "utf-8");
    const cfg = JSON.parse(raw);
    const servers = cfg.mcpServers || {};
    return Object.keys(servers).map(name => ({
      type: "mcp" as const,
      name,
      path: servers[name].command || servers[name].url || null,
      discoveredAt: new Date().toISOString(),
    }));
  } catch {
    return [];
  }
}

export function scanAll(): RegistryEntry[] {
  return [...scanSkills(), ...scanScripts(), ...scanMcpFromSettings()];
}
