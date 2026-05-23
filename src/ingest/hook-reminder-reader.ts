import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { CONFIG } from "../config.ts";
import { getDb } from "../storage/db.ts";

export interface HookReminderEvent {
  ts: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  relatedStepId?: string;
  hookId: string;
  event: string;
  severity?: "info" | "warning" | "error";
  message?: string;
}

function eventId(sourceFile: string, lineNo: number, raw: string): string {
  return createHash("sha1").update(`${sourceFile}\n${lineNo}\n${raw}`).digest("hex");
}

function normalizeSeverity(value: unknown): "info" | "warning" | "error" {
  return value === "warning" || value === "error" ? value : "info";
}

export function ingestHookReminderFile(filePath = CONFIG.HOOK_REMINDERS_FILE): number {
  if (!existsSync(filePath)) return 0;
  const raw = readFileSync(filePath, "utf-8");
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO hook_events (
      event_id, ts, ts_epoch_ms, session_key, session_id, run_id, related_step_id,
      hook_id, event, severity, message, source_file, line_no, raw_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO UPDATE SET
      ts=excluded.ts,
      ts_epoch_ms=excluded.ts_epoch_ms,
      session_key=excluded.session_key,
      session_id=excluded.session_id,
      run_id=excluded.run_id,
      related_step_id=excluded.related_step_id,
      hook_id=excluded.hook_id,
      event=excluded.event,
      severity=excluded.severity,
      message=excluded.message,
      raw_json=excluded.raw_json
  `);

  let inserted = 0;
  let lineNo = 0;
  for (const line of raw.split("\n")) {
    lineNo++;
    if (!line.trim()) continue;
    let parsed: any;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!parsed || typeof parsed !== "object") continue;
    const ts = typeof parsed.ts === "string" ? parsed.ts : "";
    const hookId = typeof parsed.hookId === "string" ? parsed.hookId : "";
    const event = typeof parsed.event === "string" ? parsed.event : "";
    const tsEpochMs = Date.parse(ts);
    if (!ts || !hookId || !event || Number.isNaN(tsEpochMs)) continue;
    stmt.run(
      eventId(filePath, lineNo, line),
      ts,
      tsEpochMs,
      typeof parsed.sessionKey === "string" ? parsed.sessionKey : null,
      typeof parsed.sessionId === "string" ? parsed.sessionId : null,
      typeof parsed.runId === "string" ? parsed.runId : null,
      typeof parsed.relatedStepId === "string" ? parsed.relatedStepId : null,
      hookId,
      event,
      normalizeSeverity(parsed.severity),
      typeof parsed.message === "string" ? parsed.message : null,
      filePath,
      lineNo,
      line,
    );
    inserted++;
  }
  return inserted;
}

export function startHookReminderWatcher(filePath = CONFIG.HOOK_REMINDERS_FILE): { stop: () => void } {
  let running = true;
  let lastSize = -1;
  let lastMtime = -1;

  function tick(): void {
    if (!running || !existsSync(filePath)) return;
    let stat;
    try { stat = statSync(filePath); } catch { return; }
    if (stat.size === lastSize && stat.mtimeMs === lastMtime) return;
    lastSize = stat.size;
    lastMtime = stat.mtimeMs;
    try {
      ingestHookReminderFile(filePath);
    } catch (err) {
      console.error(`[hook-reminder-reader] Error processing ${basename(filePath)}:`, (err as Error).message);
    }
  }

  tick();
  const interval = setInterval(tick, CONFIG.HOOK_POLL_MS);
  return {
    stop() {
      running = false;
      clearInterval(interval);
    },
  };
}
