import type { ServerResponse } from "node:http";
import { buildRankings, getSkillStats } from "../storage/steps-repo.ts";

type SendJson = (res: ServerResponse, data: unknown, status?: number) => void;

export function handleSkillsRoute(query: Record<string, string>, res: ServerResponse, sendJson: SendJson) {
  const range = query.range || "day";
  const rows = getSkillStats(range, query.q);
  const rankings = buildRankings(rows, "skill");

  sendJson(res, {
    range,
    skills: rows.map((r: any) => ({
      name: r.name,
      path: r.path,
      status: r.reg_status || "active",
      callCount: r.call_count,
      avgDurationMs: r.avg_duration_ms ? Math.round(r.avg_duration_ms) : null,
      p95DurationMs: r.p95_duration_ms ?? null,
      totalTokens: r.total_tokens || 0,
      errorCount: r.error_count || 0,
      stuckCount: r.stuck_count || 0,
    })),
    rankings,
  });
}
