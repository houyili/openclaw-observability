import { statSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { CONFIG } from "../config.ts";
import { parseTranscript, type TranscriptEntry, type ParsedRun } from "./transcript-parser.ts";
import { getDb } from "../storage/db.ts";

export interface WatcherCallbacks {
  onRuns: (sessionKey: string, runs: ParsedRun[]) => void;
}

// ─── File reader ────────────────────────────────────────────────
//
// Round 2 note: we used to track a byte offset and feed ONLY the new bytes
// to the parser. That was broken: `parseTranscript` drops entries that
// appear before a user message, so any tick that started mid-run silently
// lost every subsequent step of that run. `replay-verify` caught this —
// 138 of 231 runs were missing or truncated.
//
// The simple, provably correct fix: whenever a file grows, re-read it from
// scratch and hand the whole thing to the parser. `upsertSteps` is
// idempotent (`ON CONFLICT(step_id) DO UPDATE`), so reparsing is cheap on
// writes, and the per-file size cache + fileSizeCache short-circuit means
// we only pay this cost on files that actually changed.

function readAllEntries(filePath: string): { entries: TranscriptEntry[]; size: number } {
  let stat;
  try { stat = statSync(filePath); }
  catch { return { entries: [], size: 0 }; }

  if (stat.size === 0) return { entries: [], size: 0 };

  // Bounded cap — refuse to parse anything over 50 MB in one shot so a
  // runaway transcript cannot blow up the event loop. In practice transcripts
  // are well under 2 MB; anything bigger is skipped and reported.
  if (stat.size > 50 * 1024 * 1024) {
    console.error(`[transcript-watcher] skipping oversized file (${Math.round(stat.size / 1024 / 1024)} MB): ${basename(filePath)}`);
    return { entries: [], size: stat.size };
  }

  const raw = readFileSync(filePath, "utf-8");
  const entries: TranscriptEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try { entries.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return { entries, size: stat.size };
}

// ─── Session key extraction ─────────────────────────────────────

function extractSessionIdFromFile(filePath: string): string {
  const fileName = basename(filePath).replace(".jsonl", "");
  // Strip timestamp prefix if present (format: YYYYMMDD_HHMMSS_uuid or just uuid)
  return fileName.replace(/^\d{8}_\d{6}_/, "").replace(/^\d+_/, "");
}

// In-memory map: sessionId (UUID) → sessionKey (agent:main:...)
// Built once at startup from sessions.json store files.
let sessionIdToKeyMap: Map<string, string> | null = null;

function buildSessionIdMap(): Map<string, string> {
  const map = new Map<string, string>();
  const agentsDir = CONFIG.AGENTS_DIR;
  if (!existsSync(agentsDir)) return map;

  for (const agent of readdirSync(agentsDir, { withFileTypes: true })) {
    if (!agent.isDirectory()) continue;
    const storePath = join(agentsDir, agent.name, "sessions", "sessions.json");
    if (!existsSync(storePath)) continue;
    try {
      const data = JSON.parse(readFileSync(storePath, "utf-8"));
      if (typeof data !== "object" || data === null) continue;
      for (const [key, entry] of Object.entries(data)) {
        if (typeof entry !== "object" || entry === null) continue;
        const sid = (entry as any).sessionId;
        if (typeof sid === "string" && sid) {
          map.set(sid, key);
        }
      }
    } catch { /* skip unreadable */ }
  }
  return map;
}

function resolveSessionKey(sessionId: string, db: any): string {
  // 1. Check in-memory map (built from sessions.json — has ALL sessions)
  if (!sessionIdToKeyMap) sessionIdToKeyMap = buildSessionIdMap();
  const fromMap = sessionIdToKeyMap.get(sessionId);
  if (fromMap) {
    // Strip ":run:UUID" suffix — the auth CLI returns base keys without it
    const baseKey = fromMap.replace(/:run:[a-f0-9-]+$/, "");
    return baseKey;
  }

  // 2. Fallback: check DB (has active sessions from auth poller)
  const row = db.prepare("SELECT session_key FROM sessions WHERE session_id = ? LIMIT 1").get(sessionId) as any;
  if (row) return row.session_key;

  // 3. Last resort: use UUID
  return sessionId;
}

// ─── Scanner ────────────────────────────────────────────────────

function findTranscriptFiles(): string[] {
  const files: string[] = [];
  const agentsDir = CONFIG.AGENTS_DIR;
  if (!existsSync(agentsDir)) return files;

  for (const agent of readdirSync(agentsDir, { withFileTypes: true })) {
    if (!agent.isDirectory()) continue;
    const sessionsDir = join(agentsDir, agent.name, "sessions");
    if (!existsSync(sessionsDir)) continue;

    for (const f of readdirSync(sessionsDir)) {
      if (f.endsWith(".jsonl") && !f.includes(".acp-stream")) {
        files.push(join(sessionsDir, f));
      }
    }
  }
  return files;
}

// ─── Main watcher loop ──────────────────────────────────────────

export function startTranscriptWatcher(callbacks: WatcherCallbacks): { stop: () => void } {
  const db = getDb();
  const getOffset = db.prepare("SELECT byte_offset, session_key FROM ingest_state WHERE file_path = ?");
  const upsertOffset = db.prepare(`
    INSERT INTO ingest_state (file_path, byte_offset, session_key, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET byte_offset=excluded.byte_offset, session_key=excluded.session_key, updated_at=excluded.updated_at
  `);

  let running = true;

  // File-level size cache. Avoids per-tick DB roundtrips + syscalls for
  // files that haven't grown. Only the actual size change triggers real work.
  //
  // IMPORTANT: the cache is INTENTIONALLY NOT seeded from `ingest_state` on
  // startup. The first tick after a process restart does a full reparse of
  // every file so that parser bug-fixes and schema changes are applied to
  // historical data. Subsequent ticks rely on the in-memory cache and only
  // touch files whose size has actually grown.
  const fileSizeCache = new Map<string, number>();

  function processFile(filePath: string): void {
    // Short-circuit: if stat.size matches our last-seen size, no work to do.
    let statSize: number;
    try {
      statSize = statSync(filePath).size;
    } catch {
      return;
    }
    const cached = fileSizeCache.get(filePath);
    if (cached !== undefined && cached === statSize) return;
    fileSizeCache.set(filePath, statSize);

    const row = getOffset.get(filePath) as any;
    const cachedKey = row?.session_key || null;

    // Full-file reparse on every change (see top-of-file note on why).
    const { entries, size } = readAllEntries(filePath);
    if (entries.length === 0) {
      upsertOffset.run(filePath, size, cachedKey, new Date().toISOString());
      return;
    }

    // Determine session key (first time we see this file, or after restart).
    let sessionKey = cachedKey;
    if (!sessionKey) {
      const sessionId = extractSessionIdFromFile(filePath);
      sessionKey = resolveSessionKey(sessionId, db);
    }

    const runs = parseTranscript(entries, sessionKey);
    if (runs.length > 0) {
      callbacks.onRuns(sessionKey, runs);
    }

    upsertOffset.run(filePath, size, sessionKey, new Date().toISOString());
  }

  function tick(): void {
    if (!running) return;
    const files = findTranscriptFiles();
    for (const f of files) {
      try {
        processFile(f);
      } catch (err) {
        // Log but don't crash
        console.error(`[transcript-watcher] Error processing ${f}:`, (err as Error).message);
      }
    }
  }

  // Initial scan
  tick();

  // Poll
  const interval = setInterval(tick, CONFIG.TRANSCRIPT_POLL_MS);

  return {
    stop() {
      running = false;
      clearInterval(interval);
    },
  };
}
