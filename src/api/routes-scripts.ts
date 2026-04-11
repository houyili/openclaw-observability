import type { ServerResponse } from "node:http";
import { getScriptStats, buildRankings } from "../storage/steps-repo.ts";

type SendJson = (res: ServerResponse, data: unknown, status?: number) => void;

export function handleScriptsRoute(query: Record<string, string>, res: ServerResponse, sendJson: SendJson) {
  const range = query.range || "day";
  const rows = getScriptStats(range, query.q);
  const rankings = buildRankings(rows, "script");

  sendJson(res, {
    range,
    scripts: rows.map((r: any) => ({
      name: r.name,
      path: r.path,
      installed: true,
      callCount: r.call_count,
      avgDurationMs: r.avg_duration_ms ? Math.round(r.avg_duration_ms) : null,
      p95DurationMs: r.p95_duration_ms ?? null,
      errorCount: r.error_count || 0,
      stuckCount: r.stuck_count || 0,
    })),
    rankings,
  });
}
