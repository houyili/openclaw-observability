import { CONFIG } from "../config.ts";
import { checkToolResultError, classifyError } from "./error-classifier.ts";
import { type Classification, classifyTool, type StepNodeType } from "./tool-classifier.ts";

// ─── Public types ───────────────────────────────────────────────

export interface TranscriptEntry {
  type: string;
  id: string;
  parentId: string;
  timestamp: string;
  message?: TranscriptMessage;
}

export interface TranscriptMessage {
  role: string;
  content: any[];
  usage?: { input: number; output: number; cacheRead?: number; totalTokens: number };
  stopReason?: string;
}

export interface ParsedRun {
  runId: string;
  sessionKey: string;
  sessionId?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  steps: ParsedStep[];
  totalTokens: number;
  outputTokens: number;
}

export interface ParsedStep {
  stepId: string;
  parentStepId: string;
  seq: number;
  ts: string;
  tsEpochMs: number;
  role: string;
  nodeType: StepNodeType;
  toolName?: string;
  toolCallId?: string;
  skillName?: string;
  scriptName?: string;
  mcpServer?: string;
  mcpTool?: string;
  durationMs?: number;
  totalTokens?: number;
  outputTokens?: number;
  // Round 6 — fine-grained Context Length view fields. Set on
  // MODEL_THINK and REPLY rows (the assistant rows that carry a `usage`
  // block); NULL on tool_call and toolResult rows.
  inputTokens?: number; // usage.input
  cacheReadTokens?: number; // usage.cacheRead
  thinkingTextLen?: number; // chars in content[].type='thinking' on this assistant
  replyTextLen?: number; // chars in content[].type='text' on REPLY rows only
  inputTextLen?: number;
  resultTextLen?: number;
  contextTokenDelta?: number;
  status: "ok" | "error" | "running";
  errorText?: string;
  errorType?: string;
  isStuck: boolean;
  isCurrent: boolean;
  inputPreview?: string;
  resultPreview?: string;
}

// ─── Parsing ────────────────────────────────────────────────────

export function parseTranscript(entries: TranscriptEntry[], sessionKey: string, sessionId?: string): ParsedRun[] {
  const runs: ParsedRun[] = [];
  let currentRun: ParsedRun | null = null;
  let prevAssistantInputTokens: number | null = null;
  let seq = 0;

  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message) continue;
    const msg = entry.message;

    if (msg.role === "user") {
      if (currentRun) runs.push(finalizeRun(currentRun));
      currentRun = {
        runId: entry.id,
        sessionKey,
        sessionId,
        startedAt: entry.timestamp,
        steps: [],
        totalTokens: 0,
        outputTokens: 0,
      };
      seq = 0;
      prevAssistantInputTokens = null;
      continue;
    }

    if (!currentRun) continue;

    if (msg.role === "assistant") {
      let ctxDelta: number | undefined;
      if (prevAssistantInputTokens != null && msg.usage) {
        ctxDelta = msg.usage.input - prevAssistantInputTokens;
      }
      if (msg.usage) prevAssistantInputTokens = msg.usage.input;

      const steps = parseAssistantContent(entry, msg, seq, ctxDelta);
      for (const step of steps) {
        currentRun.steps.push(step);
        seq++;
      }
      if (msg.usage) {
        currentRun.totalTokens = msg.usage.totalTokens;
        currentRun.outputTokens += msg.usage.output;
      }
    }

    if (msg.role === "toolResult") {
      const step = parseToolResult(entry, msg, seq);
      currentRun.steps.push(step);
      seq++;
    }
  }

  if (currentRun) runs.push(finalizeRun(currentRun));
  return runs;
}

// ─── Helpers ────────────────────────────────────────────────────

function parseAssistantContent(
  entry: TranscriptEntry,
  msg: TranscriptMessage,
  startSeq: number,
  contextTokenDelta?: number,
): ParsedStep[] {
  const steps: ParsedStep[] = [];
  const content = msg.content;
  if (!Array.isArray(content)) return steps;

  const toolCalls = content.filter((c: any) => c.type === "toolCall" || c.type === "tool_use");
  const hasText = content.some((c: any) => c.type === "text" && c.text?.trim());
  const hasThinking = content.some((c: any) => c.type === "thinking");
  const tsMs = new Date(entry.timestamp).getTime();

  // Round 6 — char counts of the assistant message's own thinking and
  // text content. These power the fine-grained Context Length view.
  const thinkingTextLen = content
    .filter((c: any) => c.type === "thinking")
    .reduce((n: number, c: any) => n + (typeof c.text === "string" ? c.text.length : 0), 0);
  const replyTextLen = content
    .filter((c: any) => c.type === "text")
    .reduce((n: number, c: any) => n + (typeof c.text === "string" ? c.text.length : 0), 0);
  // Round 6 — surface usage.input and usage.cacheRead (the parser used to
  // discard cacheRead). These are required for the Context view's per-turn
  // Δin / cR columns. Both are optional — providers that don't expose them
  // (e.g. mocks in unit tests) leave the fields undefined.
  const usageInputTokens = msg.usage?.input;
  const usageCacheReadTokens = msg.usage?.cacheRead;

  // MODEL_THINK step
  if (hasThinking || toolCalls.length > 0) {
    steps.push({
      stepId: entry.id,
      parentStepId: entry.parentId,
      seq: startSeq + steps.length,
      ts: entry.timestamp,
      tsEpochMs: tsMs,
      role: "assistant",
      nodeType: "MODEL_THINK",
      totalTokens: msg.usage?.totalTokens,
      outputTokens: msg.usage?.output,
      inputTokens: usageInputTokens,
      cacheReadTokens: usageCacheReadTokens,
      thinkingTextLen: thinkingTextLen || undefined,
      status: "ok",
      isStuck: false,
      isCurrent: false,
    });
  }

  // Each toolCall → separate step
  for (const tc of toolCalls) {
    const tn = tc.toolName || tc.name || "";
    const tcId = tc.toolCallId || tc.id || "";
    const inp = tc.input || tc.arguments || tc.params || {};
    const cls: Classification = classifyTool(tn, inp);

    // Approximate token cost: assistant message's usage.output divided among tool calls
    const perToolTokens =
      msg.usage && toolCalls.length > 0 ? Math.round(msg.usage.output / toolCalls.length) : undefined;

    steps.push({
      stepId: `${entry.id}:${tcId}`,
      parentStepId: entry.id,
      seq: startSeq + steps.length,
      ts: entry.timestamp,
      tsEpochMs: tsMs,
      role: "assistant",
      nodeType: cls.nodeType,
      toolName: tn,
      toolCallId: tcId,
      skillName: cls.skillName,
      scriptName: cls.scriptName,
      mcpServer: cls.mcpServer,
      mcpTool: cls.mcpTool,
      outputTokens: perToolTokens,
      inputTextLen: JSON.stringify(inp).length,
      inputPreview: buildInputPreview(tn, inp),
      contextTokenDelta: cls.nodeType === "MCP_CALL" ? contextTokenDelta : undefined,
      status: "running",
      isStuck: false,
      isCurrent: true,
    });
  }

  // REPLY step: assistant with text content and no tool calls
  // (if both text + toolCall exist, the text is usually partial thinking output, not a reply)
  if (hasText && toolCalls.length === 0) {
    const textBlock = content.find((c: any) => c.type === "text");
    steps.push({
      stepId: `${entry.id}:reply`,
      parentStepId: entry.parentId,
      seq: startSeq + steps.length,
      ts: entry.timestamp,
      tsEpochMs: tsMs,
      role: "assistant",
      nodeType: "REPLY",
      totalTokens: msg.usage?.totalTokens,
      outputTokens: msg.usage?.output,
      // Round 6 — same per-turn token + char surfaces as MODEL_THINK,
      // plus the FULL reply text length (the existing 200-char preview
      // is intentionally a preview and is kept for the trace view).
      // thinkingTextLen is NOT stored on REPLY when a MODEL_THINK
      // companion was already created for the same assistant message
      // (i.e. hasThinking is true), since both rows would otherwise
      // double-count the same chars in cumulative sums.
      inputTokens: usageInputTokens,
      cacheReadTokens: usageCacheReadTokens,
      thinkingTextLen: hasThinking ? undefined : thinkingTextLen || undefined,
      replyTextLen: replyTextLen || undefined,
      resultPreview: textBlock?.text?.slice(0, 200),
      status: "ok",
      isStuck: false,
      isCurrent: false,
    });
  }

  return steps;
}

function parseToolResult(entry: TranscriptEntry, msg: TranscriptMessage, seq: number): ParsedStep {
  const content = msg.content;
  const errCheck = checkToolResultError(Array.isArray(content) ? content : []);
  const resultText = Array.isArray(content)
    ? content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text || "")
        .join("")
        .slice(0, 200)
    : "";
  const resultLen = Array.isArray(content) ? content.reduce((n: number, c: any) => n + (c.text?.length || 0), 0) : 0;
  const tsMs = new Date(entry.timestamp).getTime();

  return {
    stepId: entry.id,
    parentStepId: entry.parentId,
    seq,
    ts: entry.timestamp,
    tsEpochMs: tsMs,
    role: "toolResult",
    nodeType: "TOOL_CALL", // placeholder; will be refined by back-linking to the toolCall
    resultTextLen: resultLen,
    resultPreview: resultText,
    status: errCheck.isError ? "error" : "ok",
    errorText: errCheck.errorText,
    errorType: errCheck.isError && errCheck.errorText ? classifyError(errCheck.errorText) : undefined,
    isStuck: false,
    isCurrent: false,
  };
}

function finalizeRun(run: ParsedRun): ParsedRun {
  if (run.steps.length === 0) return run;

  const lastStep = run.steps[run.steps.length - 1];
  run.endedAt = lastStep.ts;
  const startMs = new Date(run.startedAt).getTime();
  const endMs = new Date(lastStep.ts).getTime();
  run.durationMs = endMs - startMs;

  // Compute step durations and back-link toolResults to toolCalls
  const pendingToolCalls = new Map<string, ParsedStep>(); // toolCallId → step

  // First pass: find unique timestamps to determine "previous message" timing
  // MODEL_THINK duration = this assistant ts - previous entry ts (LLM inference time)
  // Tool call duration will be computed from toolResult back-linking
  let prevEntryTs = new Date(run.startedAt).getTime(); // start with user message ts

  for (let i = 0; i < run.steps.length; i++) {
    const step = run.steps[i];

    if (step.nodeType === "MODEL_THINK") {
      // LLM inference time: time from previous entry to this assistant message
      step.durationMs = step.tsEpochMs - prevEntryTs;
    } else if (step.role === "toolResult") {
      // toolResult duration is computed below via back-linking
      step.durationMs = 0;
    } else if (step.nodeType === "REPLY") {
      step.durationMs = step.tsEpochMs - prevEntryTs;
    } else {
      // Tool call: duration will be set by toolResult back-link; default to 0
      step.durationMs = 0;
    }

    // Update prevEntryTs when we move to a new transcript entry
    // (MODEL_THINK and its child tool calls share ts, so only advance on toolResult or new assistant)
    if (step.role === "toolResult" || step.nodeType === "MODEL_THINK" || step.nodeType === "REPLY") {
      prevEntryTs = step.tsEpochMs;
    }

    // Track pending tool calls
    if (step.toolCallId && step.status === "running") {
      pendingToolCalls.set(step.toolCallId, step);
    }

    // Back-link toolResult to pending tool call (FIFO order)
    // Transcript chains toolResults linearly: result1.parent → assistant, result2.parent → result1
    // So we match them to pending tool calls in order of insertion.
    if (step.role === "toolResult") {
      // Take the oldest pending tool call
      const firstKey = pendingToolCalls.keys().next().value;
      if (firstKey !== undefined) {
        const tcStep = pendingToolCalls.get(firstKey)!;
        tcStep.status = step.status;
        tcStep.errorText = step.errorText;
        tcStep.errorType = step.errorType;
        tcStep.resultTextLen = step.resultTextLen;
        tcStep.resultPreview = step.resultPreview;
        tcStep.isCurrent = false;
        tcStep.durationMs = step.tsEpochMs - tcStep.tsEpochMs;
        tcStep.isStuck = (tcStep.durationMs || 0) > CONFIG.STUCK_THRESHOLD_MS;
        pendingToolCalls.delete(firstKey);
      }
    }
  }

  // Mark remaining pending tool calls as stuck if old enough
  const now = Date.now();
  for (const tcStep of pendingToolCalls.values()) {
    const elapsed = now - tcStep.tsEpochMs;
    tcStep.isStuck = elapsed > CONFIG.STUCK_THRESHOLD_MS;
  }

  return run;
}

function buildInputPreview(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "exec" && input.command) return String(input.command).slice(0, 200);
  if (toolName === "read" && (input.file_path || input.path))
    return String(input.file_path || input.path).slice(0, 200);
  if (toolName === "write" && input.file_path) return String(input.file_path).slice(0, 200);
  if (toolName === "edit" && input.file_path) return String(input.file_path).slice(0, 200);
  if (input.query) return String(input.query).slice(0, 200);
  return "";
}
