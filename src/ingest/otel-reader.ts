import { statSync, openSync, readSync, closeSync } from "node:fs";
import { CONFIG } from "../config.ts";

export interface OtelSessionState {
  sessionKey: string;
  diagnosticState: string;
  ts: string;
}

/**
 * Read the latest diagnostic.session.state and diagnostic.session.stuck
 * events from the tail of events.jsonl. Returns a map: sessionKey → latest state.
 */
export function readLatestOtelStates(): Map<string, OtelSessionState> {
  const map = new Map<string, OtelSessionState>();
  const filePath = CONFIG.OTEL_EVENTS_FILE;

  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return map;
  }

  // Read last 200KB (enough for recent diagnostic events)
  const readSize = Math.min(stat.size, 200_000);
  const offset = stat.size - readSize;
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(readSize);
    readSync(fd, buf, 0, readSize, offset);
    const lines = buf.toString("utf-8").split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }

      const et = evt.eventType;
      if (et !== "diagnostic.session.state" && et !== "diagnostic.session.stuck") continue;

      const sk = evt.sessionKey || evt.sessionId;
      if (!sk) continue;

      const existing = map.get(sk);
      if (!existing || evt.ts > existing.ts) {
        let diagState = "idle";
        if (et === "diagnostic.session.stuck") {
          diagState = "stuck";
        } else if (evt.diagnosticState || evt.state) {
          const raw = evt.diagnosticState || evt.state;
          if (raw === "processing") diagState = "processing";
          else if (raw === "waiting") diagState = "waiting";
          else if (raw === "idle") diagState = "idle";
          else diagState = raw;
        }
        map.set(sk, { sessionKey: sk, diagnosticState: diagState, ts: evt.ts });
      }
    }
  } finally {
    closeSync(fd);
  }
  return map;
}
