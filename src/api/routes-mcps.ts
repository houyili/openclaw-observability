import type { ServerResponse } from "node:http";
import { getMcpStats, getMcpErrorTypeRanking, buildRankings } from "../storage/steps-repo.ts";

type SendJson = (res: ServerResponse, data: unknown, status?: number) => void;

export function handleMcpsRoute(query: Record<string, string>, res: ServerResponse, sendJson: SendJson) {
  const range = query.range || "day";
  const rows = getMcpStats(range, query.q);
  const rankings = buildRankings(rows, "mcp");
  const errorTypeRanking = getMcpErrorTypeRanking(range);

  sendJson(res, {
    range,
    mcps: rows.map((r: any) => ({
      name: r.name,
      server: r.server,
      installed: true,
      callCount: r.call_count,
      avgDurationMs: r.avg_duration_ms ? Math.round(r.avg_duration_ms) : null,
      p95DurationMs: r.p95_duration_ms ?? null,
      errorRate: r.error_rate ?? 0,
      errorCount: r.error_count || 0,
      stuckCount: r.stuck_count || 0,
      avgResultBytes: r.avg_result_bytes ? Math.round(r.avg_result_bytes) : null,
      avgContextTokenDelta: r.avg_context_token_delta ? Math.round(r.avg_context_token_delta) : null,
    })),
    rankings: {
      ...rankings,
      topErrorTypes: errorTypeRanking,
    },
  });
}
