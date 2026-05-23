import { existsSync, readFileSync } from "node:fs";

export function parseEnvValue(raw: string): string {
  let value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

export function parseEnvFile(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    result[match[1]] = parseEnvValue(match[2]);
  }
  return result;
}

export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return parseEnvFile(readFileSync(path, "utf-8"));
}

export function getEnvValue(name: string, envPath: string, env = process.env): string | null {
  const fromProcess = env[name];
  if (fromProcess != null && fromProcess !== "") return parseEnvValue(fromProcess);
  const fromFile = readEnvFile(envPath)[name];
  if (fromFile == null || fromFile === "") return null;
  return fromFile;
}
