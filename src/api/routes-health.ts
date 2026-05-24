import type { ServerResponse } from "node:http";
import { CONFIG } from "../config.ts";
import { getAuthPollStatus } from "../ingest/auth-poller.ts";
import { getDb } from "../storage/db.ts";

type SendJson = (res: ServerResponse, data: unknown, status?: number) => void;

export function handleHealthRoute(res: ServerResponse, sendJson: SendJson) {
  const db = getDb();
  const sessionCount = (db.prepare("SELECT COUNT(*) as n FROM sessions").get() as any).n;
  const stepCount = (db.prepare("SELECT COUNT(*) as n FROM steps").get() as any).n;

  // auth-poll freshness — stale if we're > 3× the cadence behind a success.
  const pollStatus = getAuthPollStatus();
  const now = Date.now();
  const staleThresholdMs = CONFIG.AUTH_POLL_MS * 3;
  const ageMs = pollStatus.lastSuccessAt != null ? now - pollStatus.lastSuccessAt : null;
  const authStale = ageMs == null || ageMs > staleThresholdMs;

  sendJson(res, {
    ok: true,
    updatedAt: new Date().toISOString(),
    sessions: sessionCount,
    steps: stepCount,
    authPoll: {
      lastSuccessAt: pollStatus.lastSuccessAt,
      lastSuccessAgeMs: ageMs,
      lastFailureAt: pollStatus.lastFailureAt,
      lastError: pollStatus.lastError,
      inFlight: pollStatus.inFlight,
      stale: authStale,
      staleThresholdMs,
    },
  });
}
