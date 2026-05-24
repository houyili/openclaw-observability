/**
 * Round 6 — Context Length analysis (§1.2 #16).
 *
 * Two layers of detail over a single run:
 *
 *   1. getContextBreakdown() — coarse 5-bucket honest decomposition of
 *      the latest assistant message's `usage.input` from transcript-only
 *      signal. Designed so every number is mechanically derivable from
 *      existing schema fields with no fabrication.
 *
 *   2. getContextTimeline() — fine-grained per-turn analysis for finding
 *      prompt growth, single-turn spikes, and repeated no-progress loops.
 *      Per-turn rows (Δin / cR / out / tool / prevTR_chars), phase
 *      auto-detection, top-N single-point spikes, cumulative aggregates,
 *      death-loop heuristics.
 *
 * Both functions read step rows via `getTraceSpans` (existing query)
 * and do all aggregation in JS. No new SQL.
 */

import { getTraceSpans } from "./steps-repo.ts";

// ─── Public types ───────────────────────────────────────────────

export interface ContextBreakdown {
  sessionKey: string;
  runId: string;
  totalLatest: number;
  frameworkBaseline: number;
  turns: Array<{
    seq: number;
    assistantStepId: string;
    inputTokens: number;
    cacheReadTokens: number;
    promptTokens: number;
    outputTokens: number;
    deltaFromPrev: number | null;
    contributors: {
      priorOutput: number;
      toolResultsCharApprox: number;
      mcpDelta: number;
      unaccounted: number;
    } | null;
  }>;
  buckets: {
    frameworkBaseline: number;
    assistantOutputsCumulative: number;
    toolResultsCumulative: number;
    mcpDeltasCumulative: number;
    unaccountedCumulative: number;
  };
}

export type ContextPhaseName = "bootstrap" | "normal" | "spike" | "loop" | "yield_resume";

export interface ContextTimeline {
  sessionKey: string;
  runId: string;

  turns: Array<{
    seq: number;
    ts: string;
    tsEpochMs: number;

    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    deltaIn: number | null;

    primaryTool: string | null;
    primaryToolKind: string | null;
    prevToolResultChars: number;
    toolCallArgsChars: number;

    thinkingChars: number;
    replyTextChars: number;

    stepIds: string[];
  }>;

  phases: Array<{
    name: ContextPhaseName;
    startSeq: number;
    endSeq: number;
    startTotal: number;
    endTotal: number;
    deltaTotal: number;
    note: string;
  }>;

  topSpikes: Array<{
    seq: number;
    deltaIn: number;
    primaryTool: string | null;
    triggerSummary: string;
  }>;

  cumulative: {
    totalTurns: number;
    totalOutputTokens: number;
    totalThinkingChars: number;
    totalToolResultChars: number;
    totalToolCallArgsChars: number;
    totalReplyTextChars: number;
    peakInputTokens: number;
    finalInputTokens: number;
    totalInputCumulative: number;
    totalCacheReadCumulative: number;
    cacheHitRate: number | null;
  };

  loopFlags: {
    suspectedLoopWindows: Array<{
      startSeq: number;
      endSeq: number;
      turns: number;
      reason: string;
    }>;
    repeatedFileReads: Array<{ filePath: string; readCount: number }>;
    consecutiveNoWriteTurns: number;
    healthVerdict: "healthy" | "suspect" | "stuck";
  };

  insightBanner: string | null;
}

// ─── Internal helpers ───────────────────────────────────────────

interface RawStep {
  step_id: string;
  session_key: string;
  run_id: string;
  parent_step_id: string | null;
  seq: number;
  ts: string;
  ts_epoch_ms: number;
  role: string;
  node_type: string;
  tool_name: string | null;
  skill_name: string | null;
  mcp_tool: string | null;
  total_tokens: number | null;
  output_tokens: number | null;
  input_tokens: number | null;
  cache_read_tokens: number | null;
  thinking_text_len: number | null;
  reply_text_len: number | null;
  input_text_len: number | null;
  result_text_len: number | null;
  context_token_delta: number | null;
  input_preview: string | null;
}

/**
 * Group raw step rows from a single run into "turns" — one turn per
 * assistant message (i.e. per MODEL_THINK or REPLY row, plus any tool
 * calls that share its parent assistant id).
 *
 * The trace stores each toolCall as its own row keyed `${entryId}:${tcId}`,
 * with parent_step_id == entryId. The MODEL_THINK row has step_id == entryId.
 * So a turn = the assistant row whose `step_id` is the prefix shared by all
 * its tool_call children.
 */
interface Turn {
  /** The MODEL_THINK or REPLY assistant row that anchors this turn. */
  anchor: RawStep;
  /** All assistant rows belonging to this turn (anchor + tool_call children). */
  assistantRows: RawStep[];
  /** toolResult rows that arrived BEFORE this turn (delivered into this turn's input). */
  precedingToolResults: RawStep[];
}

function groupTurns(rows: RawStep[]): Turn[] {
  // Sort by seq for stability
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);
  const turns: Turn[] = [];
  let pendingResults: RawStep[] = [];
  let currentTurn: Turn | null = null;

  for (const r of sorted) {
    // The parser's step_id encoding (transcript-parser.ts):
    //   MODEL_THINK : entry.id                 (no `:` — bare anchor)
    //   tool_call   : `${entry.id}:${tcId}`    (`:` separator)
    //   REPLY       : `${entry.id}:reply`      (`:reply` suffix)
    //   toolResult  : entry.id                 (no `:` — different role)
    //
    // A "turn" = one assistant message = all rows that share entry.id.
    // Bare-stepId assistant rows are MODEL_THINK anchors.
    // `:reply`-suffixed rows attach to the same turn as the matching
    // bare anchor (MODEL_THINK) when one exists, OR start their own
    // turn when the assistant message is text-only (no thinking, no
    // tool calls — parser creates ONLY a REPLY row in that case).

    const isBareAssistant = r.role === "assistant" && !r.step_id.includes(":");
    const isReplyChild = r.role === "assistant" && r.node_type === "REPLY" && r.step_id.endsWith(":reply");

    if (isBareAssistant) {
      // MODEL_THINK anchor (or, very rarely, a bare REPLY which we treat the same way)
      if (currentTurn) turns.push(currentTurn);
      currentTurn = {
        anchor: r,
        assistantRows: [r],
        precedingToolResults: pendingResults,
      };
      pendingResults = [];
      continue;
    }

    if (isReplyChild) {
      const myEntryId = r.step_id.slice(0, -":reply".length);
      const matchesCurrent = currentTurn?.anchor.step_id === myEntryId;
      if (matchesCurrent && currentTurn) {
        // Same assistant message as the current turn — fold REPLY's
        // payload onto the existing anchor so downstream getters
        // (replyTextLen / thinkingTextLen) read a single source.
        currentTurn.assistantRows.push(r);
        if (r.reply_text_len != null) {
          currentTurn.anchor.reply_text_len = r.reply_text_len;
        }
        if (currentTurn.anchor.thinking_text_len == null && r.thinking_text_len != null) {
          currentTurn.anchor.thinking_text_len = r.thinking_text_len;
        }
        continue;
      }
      // Standalone REPLY (text-only message, no MODEL_THINK companion):
      // promote it to a new turn anchor.
      if (currentTurn) turns.push(currentTurn);
      currentTurn = {
        anchor: r,
        assistantRows: [r],
        precedingToolResults: pendingResults,
      };
      pendingResults = [];
      continue;
    }

    if (r.role === "assistant") {
      // tool_call child — attach to current turn
      if (currentTurn) currentTurn.assistantRows.push(r);
      continue;
    }

    if (r.role === "toolResult") {
      pendingResults.push(r);
    }
  }
  if (currentTurn) turns.push(currentTurn);
  return turns;
}

/**
 * For a turn, find its inputTokens. Falls back to (total_tokens - output_tokens)
 * for pre-Round-6 rows that have NULL input_tokens.
 */
function getTurnInputTokens(t: Turn): number {
  const a = t.anchor;
  if (a.input_tokens != null) return a.input_tokens;
  if (a.total_tokens != null && a.output_tokens != null) {
    return a.total_tokens - a.output_tokens;
  }
  return 0;
}

function getTurnOutputTokens(t: Turn): number {
  return t.anchor.output_tokens || 0;
}

function getTurnCacheReadTokens(t: Turn): number {
  return t.anchor.cache_read_tokens || 0;
}

function getTurnPromptTokens(t: Turn): number {
  return getTurnInputTokens(t) + getTurnCacheReadTokens(t);
}

function getTurnTotalTokens(t: Turn): number {
  return t.anchor.total_tokens || 0;
}

function getTurnPrimaryTool(t: Turn): { name: string | null; kind: string | null } {
  // First non-anchor assistant row in this turn = first tool call
  for (const r of t.assistantRows) {
    if (r === t.anchor) continue;
    if (r.tool_name) return { name: r.tool_name, kind: r.node_type };
  }
  return { name: null, kind: null };
}

function getTurnPrevToolResultChars(t: Turn): number {
  return t.precedingToolResults.reduce((n, r) => n + (r.result_text_len || 0), 0);
}

function getTurnToolCallArgsChars(t: Turn): number {
  return t.assistantRows.filter((r) => r !== t.anchor && r.tool_name).reduce((n, r) => n + (r.input_text_len || 0), 0);
}

function getTurnMcpDelta(t: Turn): number {
  return t.assistantRows
    .filter((r) => r.node_type === "MCP_CALL")
    .reduce((n, r) => n + (r.context_token_delta || 0), 0);
}

function getTurnThinkingChars(t: Turn): number {
  return t.anchor.thinking_text_len || 0;
}

function getTurnReplyTextChars(t: Turn): number {
  return t.anchor.reply_text_len || 0;
}

// ─── Shared data fetch (single SQL + groupTurns) ───────────────

function fetchAndGroup(
  sessionKey: string,
  runId?: string,
  sessionId?: string | null,
): { rows: RawStep[]; turns: Turn[]; resolvedRunId: string } | null {
  const rows = getTraceSpans(sessionKey, runId, sessionId) as unknown as RawStep[];
  if (rows.length === 0) return null;
  const turns = groupTurns(rows);
  if (turns.length === 0) return null;
  return { rows, turns, resolvedRunId: rows[0].run_id };
}

/**
 * Combined fetch — one SQL query, one groupTurns pass, both results.
 * Used by the /context route to avoid double-fetching.
 */
export function getContextBoth(
  sessionKey: string,
  runId?: string,
  sessionId?: string | null,
): { breakdown: ContextBreakdown; timeline: ContextTimeline } | null {
  const data = fetchAndGroup(sessionKey, runId, sessionId);
  if (!data) return null;
  const breakdown = buildBreakdown(sessionKey, data.rows, data.turns, data.resolvedRunId);
  const timeline = buildTimeline(sessionKey, data.rows, data.turns, data.resolvedRunId);
  return { breakdown, timeline };
}

// ─── Coarse breakdown (5 buckets) ───────────────────────────────

export function getContextBreakdown(
  sessionKey: string,
  runId?: string,
  sessionId?: string | null,
): ContextBreakdown | null {
  const data = fetchAndGroup(sessionKey, runId, sessionId);
  if (!data) return null;
  return buildBreakdown(sessionKey, data.rows, data.turns, data.resolvedRunId);
}

function buildBreakdown(sessionKey: string, _rows: RawStep[], turns: Turn[], resolvedRunId: string): ContextBreakdown {
  const baseline = getTurnPromptTokens(turns[0]);
  const totalLatest = getTurnPromptTokens(turns[turns.length - 1]);

  const turnRows: ContextBreakdown["turns"] = [];
  let assistantOutputsCumulative = 0;
  let toolResultsCumulative = 0;
  let mcpDeltasCumulative = 0;
  let unaccountedCumulative = 0;

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const inputTokens = getTurnInputTokens(t);
    const outputTokens = getTurnOutputTokens(t);

    const promptTokens = getTurnPromptTokens(t);

    if (i === 0) {
      turnRows.push({
        seq: t.anchor.seq,
        assistantStepId: t.anchor.step_id,
        inputTokens,
        cacheReadTokens: getTurnCacheReadTokens(t),
        promptTokens,
        outputTokens,
        deltaFromPrev: null,
        contributors: null,
      });
      continue;
    }

    const prevPrompt = getTurnPromptTokens(turns[i - 1]);
    const prevOutput = getTurnOutputTokens(turns[i - 1]);
    const deltaFromPrev = promptTokens - prevPrompt;

    const toolResultChars = getTurnPrevToolResultChars(t);
    const toolResultsApprox = Math.round(toolResultChars / 4);
    const mcpDelta = getTurnMcpDelta(t);
    const unaccounted = deltaFromPrev - prevOutput - toolResultsApprox - mcpDelta;

    assistantOutputsCumulative += prevOutput;
    toolResultsCumulative += toolResultsApprox;
    mcpDeltasCumulative += mcpDelta;
    unaccountedCumulative += unaccounted;

    turnRows.push({
      seq: t.anchor.seq,
      assistantStepId: t.anchor.step_id,
      inputTokens,
      cacheReadTokens: getTurnCacheReadTokens(t),
      promptTokens,
      outputTokens,
      deltaFromPrev,
      contributors: {
        priorOutput: prevOutput,
        toolResultsCharApprox: toolResultsApprox,
        mcpDelta,
        unaccounted,
      },
    });
  }

  return {
    sessionKey,
    runId: resolvedRunId,
    totalLatest,
    frameworkBaseline: baseline,
    turns: turnRows,
    buckets: {
      frameworkBaseline: baseline,
      assistantOutputsCumulative,
      toolResultsCumulative,
      mcpDeltasCumulative,
      unaccountedCumulative,
    },
  };
}

// ─── Fine-grained timeline ──────────────────────────────────────

const SPIKE_ABS_THRESHOLD = 5_000;
const SPIKE_REL_THRESHOLD = 0.3;
const LOOP_MIN_TURNS = 8;
const LOOP_CACHE_HIT_THRESHOLD = 0.85;
const LOOP_TOTAL_DRIFT_THRESHOLD = 0.05;
const REPEATED_READ_THRESHOLD = 3;

export function getContextTimeline(
  sessionKey: string,
  runId?: string,
  sessionId?: string | null,
): ContextTimeline | null {
  const data = fetchAndGroup(sessionKey, runId, sessionId);
  if (!data) return null;
  return buildTimeline(sessionKey, data.rows, data.turns, data.resolvedRunId);
}

function buildTimeline(sessionKey: string, rows: RawStep[], turns: Turn[], resolvedRunId: string): ContextTimeline {
  // ─── Per-turn rows ────────────────────────────────────────────
  const turnRows: ContextTimeline["turns"] = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const prim = getTurnPrimaryTool(t);
    const inputTokens = getTurnInputTokens(t);
    const cacheReadTokens = getTurnCacheReadTokens(t);
    const promptTokens = inputTokens + cacheReadTokens;
    const prevPrompt = i > 0 ? getTurnPromptTokens(turns[i - 1]) : 0;

    turnRows.push({
      seq: t.anchor.seq,
      ts: t.anchor.ts,
      tsEpochMs: t.anchor.ts_epoch_ms,
      totalTokens: getTurnTotalTokens(t),
      inputTokens,
      outputTokens: getTurnOutputTokens(t),
      cacheReadTokens,
      deltaIn: i > 0 ? promptTokens - prevPrompt : null,
      primaryTool: prim.name,
      primaryToolKind: prim.kind,
      prevToolResultChars: getTurnPrevToolResultChars(t),
      toolCallArgsChars: getTurnToolCallArgsChars(t),
      thinkingChars: getTurnThinkingChars(t),
      replyTextChars: getTurnReplyTextChars(t),
      stepIds: t.assistantRows.map((r) => r.step_id),
    });
  }

  // ─── Cumulative aggregates ────────────────────────────────────
  const allToolResultRows = rows.filter((r) => r.role === "toolResult");

  const totalOutputTokens = turnRows.reduce((n, t) => n + t.outputTokens, 0);
  const totalThinkingChars = turnRows.reduce((n, t) => n + t.thinkingChars, 0);
  const totalToolResultChars = allToolResultRows.reduce((n, r) => n + (r.result_text_len || 0), 0);
  const totalToolCallArgsChars = turnRows.reduce((n, t) => n + t.toolCallArgsChars, 0);
  const totalReplyTextChars = turnRows.reduce((n, t) => n + t.replyTextChars, 0);

  const peakInputTokens = turnRows.reduce((m, t) => Math.max(m, t.inputTokens + t.cacheReadTokens), 0);
  const finalInputTokens =
    (turnRows[turnRows.length - 1]?.inputTokens || 0) + (turnRows[turnRows.length - 1]?.cacheReadTokens || 0);
  const totalInputCumulative = turnRows.reduce((n, t) => n + t.inputTokens + t.cacheReadTokens, 0);
  const totalCacheReadCumulative = turnRows.reduce((n, t) => n + t.cacheReadTokens, 0);
  const cacheHitRate = totalInputCumulative > 0 ? totalCacheReadCumulative / totalInputCumulative : null;

  // ─── Top-N single-point spikes ────────────────────────────────
  const spikes = turnRows
    .filter((t) => t.deltaIn != null && t.deltaIn > 0)
    .sort((a, b) => (b.deltaIn || 0) - (a.deltaIn || 0))
    .slice(0, 5)
    .map((t) => ({
      seq: t.seq,
      deltaIn: t.deltaIn || 0,
      primaryTool: t.primaryTool,
      triggerSummary: buildSpikeSummary(t),
    }));

  // ─── Phase auto-detection ─────────────────────────────────────
  const phases = detectPhases(turnRows);

  // ─── Death-loop heuristics ────────────────────────────────────
  // For repeatedFileReads we need input_preview from the raw rows, so
  // we collect file-path read counts here while we still have `turns`.
  const fileReadCounts = new Map<string, number>();
  for (const t of turns) {
    for (const r of t.assistantRows) {
      if (r === t.anchor) continue;
      if (r.tool_name !== "read") continue;
      const path = (r.input_preview || "").trim();
      if (!path) continue;
      fileReadCounts.set(path, (fileReadCounts.get(path) || 0) + 1);
    }
  }
  const loopFlags = detectLoopFlags(turnRows, fileReadCounts);

  // ─── Insight banner ───────────────────────────────────────────
  let insightBanner: string | null = null;
  if (turnRows.length >= 3 && peakInputTokens >= 10_000) {
    const replyTokensApprox = Math.round(totalReplyTextChars / 4);
    const ratio = peakInputTokens > 0 ? replyTokensApprox / peakInputTokens : 0;
    if (ratio < 0.05) {
      const pct = (ratio * 100).toFixed(1);
      insightBanner =
        `${turnRows.length} turns / ${peakInputTokens.toLocaleString()} peak input / ` +
        `only ${totalReplyTextChars.toLocaleString()} chars (~${replyTokensApprox} tok) ` +
        `actually sent back to user. ${(100 - parseFloat(pct)).toFixed(1)}% of context is ` +
        `reasoning + tools.`;
    }
  }

  return {
    sessionKey,
    runId: resolvedRunId,
    turns: turnRows,
    phases,
    topSpikes: spikes,
    cumulative: {
      totalTurns: turnRows.length,
      totalOutputTokens,
      totalThinkingChars,
      totalToolResultChars,
      totalToolCallArgsChars,
      totalReplyTextChars,
      peakInputTokens,
      finalInputTokens,
      totalInputCumulative,
      totalCacheReadCumulative,
      cacheHitRate,
    },
    loopFlags,
    insightBanner,
  };
}

function buildSpikeSummary(t: ContextTimeline["turns"][number]): string {
  const tool = t.primaryTool || t.primaryToolKind || "unknown";
  const trChars = t.prevToolResultChars;
  const trBlurb = trChars > 0 ? ` — ${(trChars / 1000).toFixed(0)}k char tool_result` : "";
  return `${tool}: +${t.deltaIn?.toLocaleString() ?? "?"} tokens${trBlurb}`;
}

function detectPhases(turnRows: ContextTimeline["turns"]): ContextTimeline["phases"] {
  if (turnRows.length === 0) return [];

  const phases: ContextTimeline["phases"] = [];
  const peakInput = turnRows.reduce((m, t) => Math.max(m, t.inputTokens + t.cacheReadTokens), 0);

  // Step 1 — assign each turn a label
  const labels: ContextPhaseName[] = turnRows.map((t, i) => {
    // Spike: single-turn deltaIn surge
    const d = t.deltaIn ?? 0;
    if (d >= SPIKE_ABS_THRESHOLD || d >= peakInput * SPIKE_REL_THRESHOLD) {
      return "spike";
    }
    // Yield/resume: long ts gap + cache cold
    if (i > 0) {
      const gapMs = t.tsEpochMs - turnRows[i - 1].tsEpochMs;
      if (gapMs > 5 * 60_000 && t.cacheReadTokens === 0 && t.inputTokens > 1000) {
        return "yield_resume";
      }
    }
    // Bootstrap: leading turns with primaryTool=='read' and small cumulative tool result
    if (i < 10 && (t.primaryTool === "read" || t.primaryTool === null)) {
      const cumTr = turnRows.slice(0, i + 1).reduce((n, x) => n + x.prevToolResultChars, 0);
      if (cumTr < 15_000) return "bootstrap";
    }
    return "normal";
  });

  // Step 2 — loop detection: scan for windows of consecutive turns where
  // cache hit ≥ 0.85, no write/edit, |Δtotal/total| ≤ 0.05
  for (let start = 0; start <= turnRows.length - LOOP_MIN_TURNS; start++) {
    let end = start;
    while (end < turnRows.length) {
      const t = turnRows[end];
      const cR = t.cacheReadTokens;
      const inDenom = t.inputTokens + cR;
      const cacheHit = inDenom > 0 ? cR / inDenom : 0;
      const isWrite = t.primaryTool === "write" || t.primaryTool === "edit";
      const total = t.totalTokens || 1;
      const drift = end > start ? Math.abs(t.totalTokens - turnRows[end - 1].totalTokens) / total : 0;
      if (cacheHit >= LOOP_CACHE_HIT_THRESHOLD && !isWrite && drift <= LOOP_TOTAL_DRIFT_THRESHOLD) {
        end++;
      } else {
        break;
      }
    }
    if (end - start >= LOOP_MIN_TURNS) {
      for (let i = start; i < end; i++) labels[i] = "loop";
      start = end;
    }
  }

  // Step 3 — collapse consecutive same-labels into phase ranges
  let i = 0;
  while (i < turnRows.length) {
    const lab = labels[i];
    let j = i;
    while (j + 1 < turnRows.length && labels[j + 1] === lab) j++;
    const startPrompt = turnRows[i].inputTokens + turnRows[i].cacheReadTokens;
    const endPrompt = turnRows[j].inputTokens + turnRows[j].cacheReadTokens;
    phases.push({
      name: lab,
      startSeq: turnRows[i].seq,
      endSeq: turnRows[j].seq,
      startTotal: startPrompt,
      endTotal: endPrompt,
      deltaTotal: endPrompt - startPrompt,
      note: buildPhaseNote(lab, turnRows.slice(i, j + 1)),
    });
    i = j + 1;
  }

  return phases;
}

function buildPhaseNote(name: ContextPhaseName, slice: ContextTimeline["turns"]): string {
  switch (name) {
    case "bootstrap":
      return `${slice.length} bootstrap turn${slice.length === 1 ? "" : "s"}`;
    case "spike": {
      const biggest = slice.reduce((best, t) => ((t.deltaIn ?? 0) > (best.deltaIn ?? 0) ? t : best), slice[0]);
      const d = biggest.deltaIn ?? 0;
      const tool = biggest.primaryTool || "unknown";
      return `+${d.toLocaleString()} via ${tool}${slice.length > 1 ? ` (${slice.length} spikes)` : ""}`;
    }
    case "loop":
      return `${slice.length} turns, cache-hit loop, no writes`;
    case "yield_resume":
      return `cold-cache resume`;
    default:
      return `${slice.length} normal turn${slice.length === 1 ? "" : "s"}`;
  }
}

function detectLoopFlags(
  turnRows: ContextTimeline["turns"],
  fileReadCounts: Map<string, number>,
): ContextTimeline["loopFlags"] {
  // Suspected loop windows
  const suspectedLoopWindows: ContextTimeline["loopFlags"]["suspectedLoopWindows"] = [];
  let i = 0;
  while (i < turnRows.length) {
    let j = i;
    while (j < turnRows.length) {
      const t = turnRows[j];
      const inDenom = t.inputTokens + t.cacheReadTokens;
      const cacheHit = inDenom > 0 ? t.cacheReadTokens / inDenom : 0;
      const isWrite = t.primaryTool === "write" || t.primaryTool === "edit";
      const total = t.totalTokens || 1;
      const drift = j > i ? Math.abs(t.totalTokens - turnRows[j - 1].totalTokens) / total : 0;
      if (cacheHit >= LOOP_CACHE_HIT_THRESHOLD && !isWrite && drift <= LOOP_TOTAL_DRIFT_THRESHOLD) {
        j++;
      } else {
        break;
      }
    }
    if (j - i >= LOOP_MIN_TURNS) {
      suspectedLoopWindows.push({
        startSeq: turnRows[i].seq,
        endSeq: turnRows[j - 1].seq,
        turns: j - i,
        reason: `${j - i} turns: cache_hit ≥ ${(LOOP_CACHE_HIT_THRESHOLD * 100).toFixed(0)}% AND no writes AND |Δtotal/total| ≤ ${(LOOP_TOTAL_DRIFT_THRESHOLD * 100).toFixed(0)}%`,
      });
      i = j;
    } else {
      i++;
    }
  }

  // Repeated file reads — collected upstream from raw row input_preview
  const repeatedFileReads: ContextTimeline["loopFlags"]["repeatedFileReads"] = [];
  for (const [path, count] of fileReadCounts) {
    if (count >= REPEATED_READ_THRESHOLD) {
      repeatedFileReads.push({ filePath: path, readCount: count });
    }
  }
  repeatedFileReads.sort((a, b) => b.readCount - a.readCount);

  // Consecutive no-write turns (longest run)
  let consecutiveNoWriteTurns = 0;
  let cur = 0;
  for (const t of turnRows) {
    const isWrite = t.primaryTool === "write" || t.primaryTool === "edit";
    if (isWrite) {
      cur = 0;
    } else {
      cur++;
      if (cur > consecutiveNoWriteTurns) consecutiveNoWriteTurns = cur;
    }
  }

  // Health verdict
  let healthVerdict: ContextTimeline["loopFlags"]["healthVerdict"] = "healthy";
  if (suspectedLoopWindows.some((w) => w.turns >= 10)) {
    healthVerdict = "stuck";
  } else if (consecutiveNoWriteTurns >= 8 || repeatedFileReads.some((r) => r.readCount >= 4)) {
    healthVerdict = "suspect";
  }

  return {
    suspectedLoopWindows,
    repeatedFileReads,
    consecutiveNoWriteTurns,
    healthVerdict,
  };
}
