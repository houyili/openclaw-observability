import { execSync, exec } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { CONFIG } from "../config.ts";

/** Resolve the openclaw binary — try PATH first, fallback to common locations. */
function resolveOpenclawBin(): string {
  try {
    return execSync("which openclaw", { encoding: "utf-8", timeout: 5_000 }).trim();
  } catch { /* not in PATH */ }
  const candidates = [
    join(homedir(), ".npm-global/bin/openclaw"),
    "/usr/local/bin/openclaw",
    join(homedir(), ".local/bin/openclaw"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return "openclaw"; // last resort: hope it's in PATH at runtime
}

const OPENCLAW_BIN = resolveOpenclawBin();

export interface AuthSession {
  sessionKey: string;
  sessionId: string;
  agentId: string;
  kind: string;
  label: string | null;
  model: string;
  modelProvider: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextTokens: number;
  diag: string;         // who/which group - extracted from session_key
  runtimeMode: string;  // merged thinking/fast/verbose/reasoning
  updatedAt: number;
  ageMs: number;
  channel: string;
}

// Poll overlap guard: `openclaw sessions --active 240 --json` takes ~14s and
// the OS process itself pegs a core while running. If a new tick fires while
// the previous one is still in flight, we skip it entirely.
let pollInFlight = false;

// Freshness telemetry — both surfaced via /healthz so operators (and CI)
// can detect a broken openclaw CLI without reading stderr.log.
let lastPollSuccessAt: number | null = null;
let lastPollFailureAt: number | null = null;
let lastPollError: string | null = null;

export function getAuthPollStatus(): {
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
  inFlight: boolean;
} {
  return {
    lastSuccessAt: lastPollSuccessAt,
    lastFailureAt: lastPollFailureAt,
    lastError: lastPollError,
    inFlight: pollInFlight,
  };
}

/** Async poll — does not block the event loop; skipped if a previous call is still running. */
export function pollAuthSessionsAsync(callback: (sessions: AuthSession[]) => void): void {
  if (pollInFlight) {
    return;
  }
  pollInFlight = true;
  const startedAt = Date.now();
  const cmd = `${OPENCLAW_BIN} sessions --all-agents --active ${CONFIG.AUTH_ACTIVE_MINUTES} --json`;
  exec(cmd, { timeout: CONFIG.EXTERNAL_TIMEOUT_MS, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
    pollInFlight = false;
    const elapsedMs = Date.now() - startedAt;
    if (err) {
      lastPollFailureAt = Date.now();
      lastPollError = (err.message || "unknown error").slice(0, 200);
      console.error(`[auth-poller] Failed after ${elapsedMs}ms:`, lastPollError);
      callback([]);
      return;
    }
    lastPollSuccessAt = Date.now();
    lastPollError = null;
    callback(parseAuthOutput(stdout));
  });
}

export function pollAuthSessions(): AuthSession[] {
  let raw: string;
  try {
    raw = execSync(
      `${OPENCLAW_BIN} sessions --all-agents --active ${CONFIG.AUTH_ACTIVE_MINUTES} --json`,
      { timeout: CONFIG.EXTERNAL_TIMEOUT_MS, encoding: "utf-8" },
    );
  } catch (err) {
    console.error("[auth-poller] Failed:", (err as Error).message?.slice(0, 120));
    return [];
  }

  return parseAuthOutput(raw);
}

function parseAuthOutput(raw: string): AuthSession[] {
  let list: any[];
  try {
    const data = JSON.parse(raw);
    list = Array.isArray(data) ? data : data.sessions || [];
  } catch {
    console.error("[auth-poller] Invalid JSON from openclaw sessions");
    return [];
  }

  const result: AuthSession[] = [];
  for (const s of list) {
    const key = s.key || "";
    if (!key) continue;
    result.push({
      sessionKey: key,
      sessionId: s.sessionId || "",
      agentId: s.agentId || "",
      kind: s.kind || "direct",
      label: s.label || null,
      model: s.model || "",
      modelProvider: s.modelProvider || "",
      inputTokens: s.inputTokens || 0,
      outputTokens: s.outputTokens || 0,
      totalTokens: s.totalTokens || 0,
      contextTokens: s.contextTokens || 0,
      diag: parseDiag(key),
      runtimeMode: buildRuntimeMode(s),
      updatedAt: s.updatedAt || 0,
      ageMs: s.ageMs || 0,
      channel: parseChannel(key),
    });
  }
  return result;
}

function buildRuntimeMode(s: any): string {
  const parts: string[] = [];
  const t = s.thinking || "inherit";
  const f = s.fast || "inherit";
  const v = s.verbose || "inherit";
  const r = s.reasoning || "inherit";
  // Only show non-inherit values; if all inherit, show "default"
  if (t !== "inherit") parts.push(`think:${t}`);
  if (f !== "inherit") parts.push(`fast:${f}`);
  if (v !== "inherit") parts.push(`verbose:${v}`);
  if (r !== "inherit") parts.push(`reason:${r}`);
  return parts.length > 0 ? parts.join(" ") : "default";
}

/**
 * Extract the "who/which group" identity from session_key.
 * e.g. "agent:main:chat:group:oc_6da4..." → "group:oc_6da4..."
 *      "agent:main:chat:direct:user_64bc..." → "user:user_64bc..."
 *      "agent:main:cron:188f..." → "cron:188f..."
 */
function parseDiag(key: string): string {
  if (key.includes(":group:")) {
    const m = key.match(/:group:([^:]+)/);
    return m ? `group:${m[1].slice(0, 16)}` : "group";
  }
  if (key.includes(":direct:")) {
    const m = key.match(/:direct:([^:]+)/);
    return m ? `user:${m[1].slice(0, 16)}` : "direct";
  }
  if (key.includes(":cron:")) {
    const m = key.match(/:cron:([a-f0-9-]+)/);
    return m ? `cron:${m[1].slice(0, 8)}` : "cron";
  }
  if (key.includes(":subagent:")) {
    const m = key.match(/:subagent:([a-f0-9-]+)/);
    return m ? `sub:${m[1].slice(0, 8)}` : "subagent";
  }
  // direct session — extract the session name
  const parts = key.split(":");
  return parts[parts.length - 1]?.slice(0, 20) || "direct";
}

function parseChannel(key: string): string {
  const structured = key.match(/^agent:[^:]+:([^:]+):(group|direct):/);
  if (structured) return `${structured[1]}-${structured[2]}`;
  if (key.includes(":cron:") || key.includes("hourly-cron")) return "cron";
  if (key.includes(":subagent:")) return "subagent";
  return "direct";
}

/**
 * Read session store files to get label and other fields not in CLI --json.
 * Returns a map: sessionKey → {label, ...}
 */
export interface SessionStoreExtra {
  label: string | null;
  sessionId: string | null;
  parentSessionKey: string | null;
  parentSessionId: string | null;
}

export function readSessionStoreExtras(): Map<string, SessionStoreExtra> {
  const map = new Map<string, SessionStoreExtra>();
  const agentsDir = CONFIG.AGENTS_DIR;
  if (!existsSync(agentsDir)) return map;

  // Pass 1: collect all entries with their sessionId and spawnedBy (session_key)
  for (const agent of readdirSync(agentsDir, { withFileTypes: true })) {
    if (!agent.isDirectory()) continue;
    const storePath = join(agentsDir, agent.name, "sessions", "sessions.json");
    if (!existsSync(storePath)) continue;
    try {
      const data = JSON.parse(readFileSync(storePath, "utf-8"));
      if (typeof data !== "object" || data === null) continue;
      for (const [key, entry] of Object.entries(data)) {
        if (typeof entry !== "object" || entry === null) continue;
        const e = entry as Record<string, unknown>;
        map.set(key, {
          label: typeof e.label === "string" ? e.label : null,
          sessionId: typeof e.sessionId === "string" ? e.sessionId : null,
          parentSessionKey: typeof e.spawnedBy === "string" ? e.spawnedBy : null,
          parentSessionId: null, // resolved in pass 2
        });
      }
    } catch { /* skip unreadable stores */ }
  }

  // Pass 2: resolve parentSessionId by looking up spawnedBy key in the map
  for (const extra of map.values()) {
    if (extra.parentSessionKey) {
      const parentEntry = map.get(extra.parentSessionKey);
      if (parentEntry?.sessionId) {
        extra.parentSessionId = parentEntry.sessionId;
      }
    }
  }

  return map;
}
