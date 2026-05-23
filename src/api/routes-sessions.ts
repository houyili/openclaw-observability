import type { ServerResponse } from "node:http";
import { getAllSessions, getSession, getChildCounts, getParentInfoBatch } from "../storage/sessions-repo.ts";
import { getLatestRun, getRunList, getTraceSpans, getActivityBars } from "../storage/steps-repo.ts";
import { getContextBoth } from "../storage/context-repo.ts";
import { getWorkflowGraph } from "../storage/workflow-repo.ts";
import { getPromptCheck } from "../storage/prompt-check-repo.ts";

type SendJson = (res: ServerResponse, data: unknown, status?: number) => void;

export const handleSessionsRoutes = {
  list(query: Record<string, string>, res: ServerResponse, sendJson: SendJson) {
    const isCron = query.tab === "cron" ? true : query.tab === "sessions" ? false : undefined;
    const pageSize = isCron === true ? 10 : (query.tab === "sessions" ? 15 : 15);
    const { sessions, total, page } = getAllSessions({
      channel: query.channel,
      agent: query.agent,
      state: query.state,
      q: query.q,
      diag: query.diag,
      label: query.label,
      parentKey: query.parentKey,
      parentId: query.parentId,
      isCron,
      page: query.page ? parseInt(query.page) : 1,
      pageSize: query.pageSize ? parseInt(query.pageSize) : pageSize,
    });

    // Batch-fetch child counts (by session_id) and parent display info.
    const allSessionIds = sessions.map(s => s.session_id).filter(Boolean) as string[];
    const childCounts = getChildCounts(allSessionIds);
    const parentSessionIds = [...new Set(sessions.map(s => s.parent_session_id).filter(Boolean))] as string[];
    const parentInfo = getParentInfoBatch(parentSessionIds);

    const result = sessions.map(s => {
      const latestRun = getLatestRun(s.session_key, s.session_id);
      const activityBars = getActivityBars(s.session_key, s.session_id);

      // Compute lastBlockDurationMs: time since last stuck step
      let lastBlockDurationMs: number | null = null;
      if (s.last_block_ts) {
        lastBlockDurationMs = Date.now() - s.last_block_ts;
      }

      return {
        sessionKey: s.session_key,
        sessionId: s.session_id,
        agentId: s.agent_id,
        channel: s.channel,
        diag: s.diag,
        label: s.label,
        kind: s.kind,
        model: s.model,
        source: s.source,
        tokenSource: s.token_source || "official",
        totalTokens: s.total_tokens,
        inputTokens: s.input_tokens,
        outputTokens: s.output_tokens,
        contextTokens: s.context_tokens,
        runtimeMode: s.runtime_mode,
        llmCallCount: s.llm_call_count,
        toolCallCount: s.tool_call_count,
        skillCallCount: s.skill_call_count,
        mcpCallCount: s.mcp_call_count,
        diagState: s.diag_state,
        currentOp: s.current_op,
        blocker: s.blocker,
        lastBlockDurationMs,
        // Compute age live from updated_at; stored s.age_ms is a stale
        // snapshot from the last auth-poller tick (CLI at poll time).
        ageMs: s.updated_at ? Date.now() - s.updated_at : s.age_ms,
        updatedAt: s.updated_at,
        parentSessionKey: s.parent_session_key || null,
        parentSessionId: s.parent_session_id || null,
        parentDiag: s.parent_session_id ? (parentInfo.get(s.parent_session_id)?.diag || null) : null,
        parentLabel: s.parent_session_id ? (parentInfo.get(s.parent_session_id)?.label || null) : null,
        parentAgentId: s.parent_session_id ? (parentInfo.get(s.parent_session_id)?.agentId || null) : null,
        childCount: childCounts.get(s.session_id) || 0,
        latestRun: latestRun ? {
          runId: latestRun.run_id,
          startedAt: latestRun.started_at,
          durationMs: latestRun.duration_ms,
          modelSteps: latestRun.model_steps,
          toolSteps: latestRun.tool_steps,
          status: latestRun.status,
        } : null,
        activityBars,
      };
    });

    sendJson(res, { sessions: result, total, page, pageSize, totalPages: Math.ceil(total / pageSize) });
  },

  detail(key: string, res: ServerResponse, sendJson: SendJson) {
    const session = getSession(key);
    if (!session) return sendJson(res, { error: "Session not found" }, 404);

    const latestRun = getLatestRun(key, session.session_id);
    const activityBars = getActivityBars(key, session.session_id);

    sendJson(res, {
      session: { ...session },
      latestRun,
      activityBars,
    });
  },

  workflow(key: string, query: Record<string, string>, res: ServerResponse, sendJson: SendJson) {
    return sendJson(res, getWorkflowGraph(key, query.runId, query.sessionId));
  },

  promptCheck(key: string, query: Record<string, string>, res: ServerResponse, sendJson: SendJson) {
    return sendJson(res, getPromptCheck(key, query.runId, query.sessionId));
  },

  trace(key: string, query: Record<string, string>, res: ServerResponse, sendJson: SendJson) {
    const allSpans = getTraceSpans(key, query.runId, query.sessionId);
    // Filter out toolResult rows (their data is already merged into the toolCall step)
    const spans = allSpans.filter((s: any) => s.role !== "toolResult");
    if (spans.length === 0) return sendJson(res, { sessionKey: key, spans: [] });

    // Compute startOffsetMs relative to first span
    const firstTs = (spans[0] as any).ts_epoch_ms;
    // traceDuration = max(ts + duration) across all spans to avoid overflow
    let maxEndTs = firstTs;
    for (const s of spans) {
      const end = (s as any).ts_epoch_ms + ((s as any).duration_ms || 0);
      if (end > maxEndTs) maxEndTs = end;
    }
    const lastTs = maxEndTs;

    // Recompute start/duration for correct timeline:
    // MODEL_THINK: starts after prev step ends, ends when assistant message arrives
    // TOOL_CALL: starts when assistant message arrives, ends when toolResult comes back
    let prevEndTs = firstTs; // track the end timestamp of the previous step
    const adjustedSpans: any[] = [];
    for (let i = 0; i < spans.length; i++) {
      const s = spans[i] as any;
      let startMs: number;
      let durMs: number;

      if (s.node_type === "MODEL_THINK") {
        // LLM thinking: from previous step's end to this assistant message's timestamp
        startMs = prevEndTs - firstTs;
        durMs = s.ts_epoch_ms - prevEndTs;
        if (durMs < 0) durMs = 0;
        // Don't advance prevEndTs yet — tool calls follow with the same ts
      } else {
        // Tool calls / reply: from this step's timestamp, duration = its own duration
        startMs = s.ts_epoch_ms - firstTs;
        durMs = s.duration_ms || 0;
        // Advance prevEndTs to end of this step
        prevEndTs = s.ts_epoch_ms + durMs;
      }

      adjustedSpans.push({ s, startMs, durMs });
    }

    // Recalculate traceDuration from adjusted spans
    const adjustedMaxEnd = Math.max(...adjustedSpans.map(a => a.startMs + a.durMs), 1);

    const mappedSpans = adjustedSpans.map(({ s, startMs, durMs }) => ({
      id: s.step_id,
      parentId: s.parent_step_id,
      type: s.node_type,
      label: buildSpanLabel(s),
      startOffsetMs: startMs,
      durationMs: durMs,
      tokens: s.total_tokens,
      outputTokens: s.output_tokens,
      status: s.status,
      isStuck: !!s.is_stuck,
      isCurrent: !!s.is_current,
      toolName: s.tool_name,
      skillName: s.skill_name,
      mcpTool: s.mcp_tool,
      resultTextLen: s.result_text_len,
      inputPreview: s.input_preview,
      resultPreview: s.result_preview,
      errorText: s.error_text,
    }));

    // Include run list for run selector
    const runs = getRunList(key, query.sessionId);

    sendJson(res, {
      sessionKey: key,
      sessionId: query.sessionId || null,
      runId: (spans[0] as any).run_id,
      startedAt: (spans[0] as any).ts,
      traceDurationMs: adjustedMaxEnd,
      spans: mappedSpans,
      runs: runs.map(r => ({
        runId: r.run_id,
        startedAt: r.started_at,
        durationMs: r.duration_ms,
        modelSteps: r.model_steps,
        toolSteps: r.tool_steps,
        status: r.status,
      })),
    });
  },

  /**
   * Round 6 — §1.2 #16 Context Length analysis.
   *
   * Returns BOTH the coarse 5-bucket breakdown and the fine-grained
   * per-turn timeline (phases, top-N spikes, cumulative aggregates,
   * death-loop heuristics) for one session+run. The frontend renders
   * a single panel with all of it stacked.
   *
   *   GET /api/sessions/:key/context?runId=<optional>
   *   → 200 { sessionKey, runId, breakdown, timeline, runs }
   *   → 404 if no MODEL_THINK rows
   */
  context(key: string, query: Record<string, string>, res: ServerResponse, sendJson: SendJson) {
    const result = getContextBoth(key, query.runId, query.sessionId);
    if (!result) {
      return sendJson(res, { error: "No assistant turns found for this run" }, 404);
    }
    const { breakdown, timeline } = result;
    const runs = getRunList(key, query.sessionId);

    sendJson(res, {
      sessionKey: key,
      sessionId: query.sessionId || null,
      runId: breakdown.runId,
      breakdown,
      timeline,
      runs: runs.map(r => ({
        runId: r.run_id,
        startedAt: r.started_at,
        durationMs: r.duration_ms,
        modelSteps: r.model_steps,
        toolSteps: r.tool_steps,
        status: r.status,
      })),
    });
  },
};

function buildSpanLabel(s: any): string {
  if (s.node_type === "MODEL_THINK") {
    const tokens = s.total_tokens ? `${Math.round(s.total_tokens / 1000)}K` : "";
    return `Model${tokens ? ` (${tokens})` : ""}`;
  }
  if (s.node_type === "REPLY") return "Reply";
  if (s.node_type === "SKILL_EXEC") return `${s.skill_name || "skill"}/${s.script_name || s.tool_name || "exec"}`;
  if (s.node_type === "MCP_CALL") return s.mcp_tool || s.tool_name || "mcp";
  if (s.node_type === "SUBAGENT_SPAWN") return "Subagent spawn";
  if (s.node_type === "EXTERNAL_CALL") return s.tool_name || "external";
  if (s.tool_name) {
    const preview = s.input_preview ? ` (${s.input_preview.slice(0, 40)})` : "";
    return `${s.tool_name}${preview}`;
  }
  return s.node_type;
}
