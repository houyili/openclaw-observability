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
      path: r.path,
      // status: 'active' (disk scan saw it this run),
      //        'observed' (lazy-learned from transcript only),
      //        'removed' (was in registry but disk scan missed it).
      // installed: true when the MCP currently sits in the registry
      // for any reason; the dashboard can downgrade the badge based
      // on status separately.
      status: r.reg_status || "observed",
      installed: r.reg_status !== "removed",
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
