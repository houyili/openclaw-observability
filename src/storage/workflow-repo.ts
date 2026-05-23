import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "../config.ts";
import { getEnvValue } from "../env.ts";
import { getDb } from "./db.ts";
import { getRunList } from "./steps-repo.ts";

export type WorkflowEventType =
  | "user_message"
  | "skill_or_source_step"
  | "checkpoint_write"
  | "sessions_spawn_requested"
  | "sessions_spawn_accepted"
  | "sessions_yield"
  | "child_started"
  | "child_artifact_written"
  | "child_final"
  | "parent_resumed"
  | "workflow_state_snapshot"
  | "workflow_state_child_bound"
  | "workflow_state_gap";

export interface WorkflowLane {
  id: string;
  title: string;
  kind: "user" | "parent" | "runtime" | "child" | "workflow_state";
}

export interface WorkflowEvent {
  id: string;
  laneId: string;
  type: WorkflowEventType;
  ts: string | null;
  tsEpochMs: number;
  title: string;
  subtitle?: string;
  status?: string;
  provenance: Record<string, string | number | null>;
}

export interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
  type: "causal" | "spawn" | "resume" | "workflow_state";
  label?: string;
}

export interface WorkflowDiagnostic {
  id: string;
  severity: "info" | "warning" | "error";
  type: string;
  message: string;
  eventId?: string;
}

export interface WorkflowValidationCheck {
  id: string;
  status: "ok" | "warning" | "error";
  message: string;
  eventId?: string;
}

export interface WorkflowValidation {
  status: "ok" | "warning" | "error";
  checks: WorkflowValidationCheck[];
}

export interface WorkflowAttention {
  status: "ok" | "idle" | "waiting" | "stuck" | "error";
  title: string;
  subtitle?: string;
  laneId?: string;
  eventId?: string;
  stepId?: string;
  runId?: string | null;
  childSessionKey?: string | null;
  childSessionId?: string | null;
  sinceTs?: string | null;
  ageMs?: number | null;
  details?: Record<string, string | number | null>;
}

interface StepRow {
  step_id: string;
  session_key: string;
  session_id: string | null;
  run_id: string;
  seq: number;
  ts: string;
  ts_epoch_ms: number;
  role: string;
  node_type: string;
  tool_name: string | null;
  status: string | null;
  duration_ms: number | null;
  total_tokens: number | null;
  input_tokens: number | null;
  cache_read_tokens: number | null;
  output_tokens: number | null;
  input_preview: string | null;
  result_preview: string | null;
  error_text: string | null;
  is_current: number | null;
  is_stuck: number | null;
}

interface SpawnAccepted {
  childSessionKey: string | null;
  runId: string | null;
  taskName: string | null;
  mode: string | null;
}

interface WorkflowStateSnapshot {
  adapterId: string;
  flowId: string | null;
  workKey: string | null;
  currentStep: string | null;
  childRefs: string[];
  sourcePath: string;
}

const WORKFLOW_STATE_ADAPTERS = [
  {
    id: "openclaw-managed-workflow",
    start: "<!-- openclaw-workflow:start -->",
    end: "<!-- openclaw-workflow:end -->",
  },
];

const BASE_KEY_RE = /:run:[a-f0-9-]+$/;

function baseKey(key: string): string {
  return key.replace(BASE_KEY_RE, "");
}

function shortKey(key: string | null | undefined): string {
  if (!key) return "";
  return key.length > 22 ? "..." + key.slice(-18) : key;
}

function addEvent(events: WorkflowEvent[], event: Omit<WorkflowEvent, "id"> & { id?: string }): WorkflowEvent {
  const id = event.id || `wf-${events.length + 1}`;
  const e: WorkflowEvent = { ...event, id };
  events.push(e);
  return e;
}

function addEdge(edges: WorkflowEdge[], from: WorkflowEvent | undefined, to: WorkflowEvent | undefined, type: WorkflowEdge["type"], label?: string): void {
  if (!from || !to) return;
  edges.push({ id: `edge-${edges.length + 1}`, from: from.id, to: to.id, type, label });
}

function parseMaybeJson(text: string | null): any | null {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function extractSpawnAccepted(step: StepRow): SpawnAccepted | null {
  const json = parseMaybeJson(step.result_preview);
  const text = step.result_preview || "";
  if (!json || typeof json !== "object") {
    const childSessionKey = text.match(/"childSessionKey"\s*:\s*"([^"]+)"/)?.[1] || null;
    const runId = text.match(/"runId"\s*:\s*"([^"]+)"/)?.[1] || null;
    if (!childSessionKey && !runId) return null;
    return {
      childSessionKey,
      runId,
      taskName: text.match(/"taskName"\s*:\s*"([^"]+)"/)?.[1] || null,
      mode: text.match(/"mode"\s*:\s*"([^"]+)"/)?.[1] || null,
    };
  }
  const childSessionKey = typeof json.childSessionKey === "string" ? json.childSessionKey : null;
  const runId = typeof json.runId === "string" ? json.runId : null;
  if (!childSessionKey && !runId) return null;
  return {
    childSessionKey,
    runId,
    taskName: typeof json.taskName === "string" ? json.taskName : null,
    mode: typeof json.mode === "string" ? json.mode : null,
  };
}

function artifactPaths(text: string | null): string[] {
  if (!text) return [];
  const paths = new Set<string>();
  const pathRe = /(?:~|\.\/|\/[^\s"'`<>]+)/g;
  for (const m of text.matchAll(pathRe)) {
    const raw = m[0].replace(/[),.;\]]+$/, "");
    if (/\.(md|json|jsonl|txt|py|ts|tsx|js|pdf|png|jpg|jpeg|csv|db)$/i.test(raw) || raw.includes("work_status.md")) {
      paths.add(raw);
    }
  }
  return [...paths];
}

function isCheckpointWrite(step: StepRow): boolean {
  const text = `${step.tool_name || ""} ${step.input_preview || ""} ${step.result_preview || ""}`;
  return /(checkpoint|work_status\.md|source_refresh|source_collection|handoff)/i.test(text);
}

function isSourceOrSkillStep(step: StepRow): boolean {
  const text = `${step.tool_name || ""} ${step.input_preview || ""}`;
  if (step.node_type === "SKILL_EXEC") return true;
  return /(skill|arxiv|source|research_query|url_router|code_audit|related_work|manifest_query|read|grep|rg)/i.test(text);
}

function eventLabelForStep(step: StepRow): string {
  if (step.tool_name) return step.tool_name;
  if (step.node_type === "REPLY") return "final reply";
  return step.node_type.toLowerCase();
}

function stepProvenance(step: StepRow, scopeSteps: StepRow[] = []): Record<string, string | number | null> {
  const contextStep = [...scopeSteps]
    .reverse()
    .find(s => s.run_id === step.run_id && s.seq <= step.seq && (s.input_tokens != null || s.cache_read_tokens != null));
  return {
    step_id: step.step_id,
    run_id: step.run_id,
    session_key: step.session_key,
    tool_name: step.tool_name,
    duration_ms: step.duration_ms,
    total_tokens: step.total_tokens ?? contextStep?.total_tokens ?? null,
    input_tokens: step.input_tokens ?? contextStep?.input_tokens ?? null,
    cache_read_tokens: step.cache_read_tokens ?? contextStep?.cache_read_tokens ?? null,
    output_tokens: step.output_tokens,
  };
}

function enabledWorkflowAdapterIds(): Set<string> | null {
  const envPath = join(import.meta.dirname, "..", "..", ".env");
  const raw = getEnvValue("OBS_WORKFLOW_ADAPTERS", envPath)?.trim();
  if (!raw || raw === "auto") return null;
  if (raw === "none") return new Set();
  return new Set(raw.split(",").map(s => s.trim()).filter(Boolean));
}

function extractManagedWorkflowBlock(raw: string): { adapterId: string; body: string } | null {
  const enabled = enabledWorkflowAdapterIds();
  for (const adapter of WORKFLOW_STATE_ADAPTERS) {
    if (enabled && !enabled.has(adapter.id)) continue;
    const start = raw.indexOf(adapter.start);
    const end = start >= 0 ? raw.indexOf(adapter.end, start + adapter.start.length) : -1;
    if (start >= 0 && end >= 0) {
      return { adapterId: adapter.id, body: raw.slice(start + adapter.start.length, end) };
    }
  }
  return null;
}

function workflowStateFromArtifacts(parentSteps: StepRow[], childSteps: StepRow[]): WorkflowStateSnapshot | null {
  const paths = new Set<string>();
  for (const step of [...parentSteps, ...childSteps]) {
    for (const p of artifactPaths(`${step.input_preview || ""} ${step.result_preview || ""}`)) {
      if (p.endsWith("work_status.md")) paths.add(p.replace(/^~/, process.env.HOME || "~"));
    }
  }

  for (const path of paths) {
    if (!existsSync(path)) continue;
    let raw = "";
    try { raw = readFileSync(path, "utf-8"); } catch { continue; }
    const block = extractManagedWorkflowBlock(raw);
    if (!block) continue;
    const body = block.body;
    const flowId = body.match(/\bflow_id:\s*([^\n]+)/)?.[1]?.trim() || null;
    const workKey = body.match(/\bwork_key:\s*([^\n]+)/)?.[1]?.trim() || null;
    const currentStep = body.match(/\bcurrent_step:\s*([^\n]+)/)?.[1]?.trim() || null;
    const childRefs: string[] = [];
    for (const line of body.split("\n")) {
      if (/child|run|session|waiting/i.test(line)) childRefs.push(line.trim());
    }
    return { adapterId: block.adapterId, flowId, workKey, currentStep, childRefs, sourcePath: path };
  }
  return null;
}

function childMatchesWorkflowState(child: SpawnAccepted, snapshot: WorkflowStateSnapshot | null): boolean {
  if (!snapshot) return false;
  const haystack = snapshot.childRefs.join("\n");
  return !!(
    (child.childSessionKey && haystack.includes(child.childSessionKey)) ||
    (child.runId && haystack.includes(child.runId))
  );
}

function eventOrderRank(type: WorkflowEventType): number {
  const ranks: Record<WorkflowEventType, number> = {
    user_message: 0,
    skill_or_source_step: 1,
    checkpoint_write: 1,
    sessions_spawn_requested: 2,
    sessions_spawn_accepted: 3,
    sessions_yield: 4,
    child_started: 5,
    child_artifact_written: 6,
    child_final: 7,
    parent_resumed: 8,
    workflow_state_snapshot: 9,
    workflow_state_child_bound: 10,
    workflow_state_gap: 11,
  };
  return ranks[type] ?? 99;
}

function validationStatus(checks: WorkflowValidationCheck[]): WorkflowValidation["status"] {
  if (checks.some(c => c.status === "error")) return "error";
  if (checks.some(c => c.status === "warning")) return "warning";
  return "ok";
}

function validateWorkflowGraph(params: {
  sessionId?: string | null;
  parentKey: string;
  activeRunId: string | null;
  lanes: WorkflowLane[];
  events: WorkflowEvent[];
  edges: WorkflowEdge[];
  parentSteps: StepRow[];
  childStepMap: Map<string, StepRow[]>;
  spawnAccepts: Array<{ requested: WorkflowEvent; accepted?: WorkflowEvent; acceptedData: SpawnAccepted; step: StepRow }>;
}): WorkflowValidation {
  const checks: WorkflowValidationCheck[] = [];
  const laneIds = new Set(params.lanes.map(l => l.id));
  const eventById = new Map(params.events.map(e => [e.id, e]));
  const sourceSteps = new Map<string, StepRow>();
  for (const step of params.parentSteps) sourceSteps.set(step.step_id, step);
  for (const rows of params.childStepMap.values()) {
    for (const step of rows) sourceSteps.set(step.step_id, step);
  }
  const acceptedChildKeys = new Set(
    params.spawnAccepts
      .map(s => s.acceptedData.childSessionKey ? baseKey(s.acceptedData.childSessionKey) : null)
      .filter(Boolean) as string[],
  );
  const acceptedChildRuns = new Map<string, Set<string>>();
  for (const spawn of params.spawnAccepts) {
    if (!spawn.acceptedData.childSessionKey || !spawn.acceptedData.runId) continue;
    const key = baseKey(spawn.acceptedData.childSessionKey);
    if (!acceptedChildRuns.has(key)) acceptedChildRuns.set(key, new Set());
    acceptedChildRuns.get(key)?.add(spawn.acceptedData.runId);
  }

  const add = (id: string, status: WorkflowValidationCheck["status"], message: string, eventId?: string) => {
    checks.push({ id, status, message, eventId });
  };

  const badLane = params.events.find(e => !laneIds.has(e.laneId));
  add("lanes.resolve", badLane ? "error" : "ok", badLane ? `event ${badLane.id} references missing lane ${badLane.laneId}` : "all event lanes resolve", badLane?.id);

  const badEdge = params.edges.find(e => !eventById.has(e.from) || !eventById.has(e.to));
  add("edges.resolve", badEdge ? "error" : "ok", badEdge ? `edge ${badEdge.id} references missing event` : "all edges resolve");

  const reversedEdge = params.edges.find(edge => {
    const from = eventById.get(edge.from);
    const to = eventById.get(edge.to);
    return !!(from && to && to.tsEpochMs + 1 < from.tsEpochMs);
  });
  add("edges.time", reversedEdge ? "error" : "ok", reversedEdge ? `edge ${reversedEdge.id} points backward in time` : "all causal edges are time-consistent");

  const badStepEvent = params.events.find(e => {
    const stepId = e.provenance?.step_id;
    if (typeof stepId !== "string") return false;
    return !sourceSteps.has(stepId);
  });
  add("provenance.step_id", badStepEvent ? "error" : "ok", badStepEvent ? `event ${badStepEvent.id} has unknown step_id` : "all step_id provenance resolves", badStepEvent?.id);

  if (params.sessionId) {
    const badSessionStep = params.parentSteps.find(s => s.session_id !== params.sessionId);
    add(
      "scope.session_id",
      badSessionStep ? "error" : "ok",
      badSessionStep ? `parent step ${badSessionStep.step_id} escaped session_id scope` : "parent steps are scoped by session_id",
    );
  } else {
    add("scope.session_key", "ok", "parent steps are scoped by session_key");
  }

  const badRunStep = params.activeRunId
    ? params.parentSteps.find(s => s.run_id !== params.activeRunId)
    : null;
  add("scope.run_id", badRunStep ? "error" : "ok", badRunStep ? `parent step ${badRunStep.step_id} escaped run_id scope` : "parent steps are scoped by run_id");

  const badChildLane = params.lanes.find(l => l.id.startsWith("child:") && !acceptedChildKeys.has(l.id.slice("child:".length)));
  add("spawn.child_lanes", badChildLane ? "error" : "ok", badChildLane ? `child lane ${badChildLane.id} has no accepted spawn` : "child lanes come from accepted spawn results");

  const acceptedWithoutRows = [...acceptedChildKeys].find(childKey => (params.childStepMap.get(childKey)?.length || 0) === 0);
  add(
    "spawn.child_steps",
    acceptedWithoutRows ? "warning" : "ok",
    acceptedWithoutRows ? `accepted child ${shortKey(acceptedWithoutRows)} has no visible steps` : "accepted children have visible step rows",
  );

  let badChildRun: { childKey: string; step: StepRow } | null = null;
  for (const [childKey, rows] of params.childStepMap.entries()) {
    const allowedRuns = acceptedChildRuns.get(childKey);
    if (!allowedRuns || allowedRuns.size === 0) continue;
    const bad = rows.find(s => !allowedRuns.has(s.run_id));
    if (bad) {
      badChildRun = { childKey, step: bad };
      break;
    }
  }
  add(
    "spawn.child_run_id",
    badChildRun ? "error" : "ok",
    badChildRun ? `child ${shortKey(badChildRun.childKey)} includes unaccepted run ${badChildRun.step.run_id}` : "child steps match accepted child run_id",
  );

  const spawnRequested = params.events.filter(e => e.type === "sessions_spawn_requested").length;
  const spawnAccepted = params.events.filter(e => e.type === "sessions_spawn_accepted").length;
  add(
    "spawn.acceptance",
    spawnAccepted > spawnRequested ? "error" : "ok",
    spawnAccepted > spawnRequested ? "more spawn accepted events than requests" : "spawn acceptance count is bounded by requests",
  );

  const badResume = params.edges.find(edge => {
    if (edge.type !== "resume") return false;
    const from = eventById.get(edge.from);
    const to = eventById.get(edge.to);
    return !(from?.type === "child_final" && to?.type === "parent_resumed" && to.tsEpochMs >= from.tsEpochMs);
  });
  add("resume.order", badResume ? "error" : "ok", badResume ? `resume edge ${badResume.id} is not child_final -> parent_resumed` : "resume edges follow child_final -> parent_resumed");

  return { status: validationStatus(checks), checks };
}

function computeWorkflowAttention(params: {
  sessionId?: string | null;
  parentKey: string;
  activeRunId: string | null;
  events: WorkflowEvent[];
  parentSteps: StepRow[];
  childStepMap: Map<string, StepRow[]>;
  spawnAccepts: Array<{ requested: WorkflowEvent; accepted?: WorkflowEvent; acceptedData: SpawnAccepted; step: StepRow }>;
}): WorkflowAttention {
  const db = getDb();
  const now = Date.now();
  const session = params.sessionId
    ? db.prepare(`
        SELECT session_id, diag_state, current_op, blocker, last_block_ts, updated_at
        FROM sessions WHERE session_key = ? AND session_id = ? LIMIT 1
      `).get(params.parentKey, params.sessionId) as any
    : db.prepare(`
        SELECT session_id, diag_state, current_op, blocker, last_block_ts, updated_at
        FROM sessions WHERE session_key = ? ORDER BY updated_at DESC LIMIT 1
      `).get(params.parentKey) as any;

  const allRows = [...params.parentSteps, ...params.childStepMap.values()].flat();
  const current = allRows
    .filter(s => s.is_current)
    .sort((a, b) => b.ts_epoch_ms - a.ts_epoch_ms)[0];
  if (current) {
    const ageMs = now - current.ts_epoch_ms;
    const dynamicStuck = ageMs > CONFIG.STUCK_THRESHOLD_MS || !!current.is_stuck;
    return {
      status: dynamicStuck ? "stuck" : "waiting",
      title: dynamicStuck ? `Stuck on ${current.tool_name || current.node_type}` : `Running ${current.tool_name || current.node_type}`,
      subtitle: current.input_preview || current.result_preview || undefined,
      laneId: current.session_key === params.parentKey ? "parent" : `child:${current.session_key}`,
      stepId: current.step_id,
      runId: current.run_id,
      sinceTs: current.ts,
      ageMs,
      details: {
        tool_name: current.tool_name,
        node_type: current.node_type,
        status: current.status,
      },
    };
  }

  const latestYield = [...params.events].reverse().find(e => e.type === "sessions_yield");
  const latestResume = [...params.events].reverse().find(e => e.type === "parent_resumed");
  if (latestYield && (!latestResume || latestResume.tsEpochMs < latestYield.tsEpochMs)) {
    const acceptedChildren = params.spawnAccepts
      .filter(s => s.acceptedData.childSessionKey)
      .map(s => baseKey(s.acceptedData.childSessionKey as string));
    const children = acceptedChildren.length > 0
      ? db.prepare(`
          SELECT session_key, session_id, diag_state, current_op, blocker, updated_at
          FROM sessions
          WHERE session_key IN (${acceptedChildren.map(() => "?").join(",")})
          ORDER BY updated_at DESC
        `).all(...acceptedChildren) as any[]
      : (params.sessionId
          ? db.prepare(`
              SELECT session_key, session_id, diag_state, current_op, blocker, updated_at
              FROM sessions WHERE parent_session_id = ? ORDER BY updated_at DESC
            `).all(params.sessionId) as any[]
          : []);
    const child = children[0] || null;
    const ageMs = now - latestYield.tsEpochMs;
    const childState = child ? `${child.diag_state || "unknown"}${child.current_op ? ` / ${child.current_op}` : ""}` : "not visible";
    return {
      status: ageMs > CONFIG.STUCK_THRESHOLD_MS ? "stuck" : "waiting",
      title: child ? "Parent yielded; waiting for child merge" : "Parent yielded; child not visible",
      subtitle: child ? `child ${shortKey(child.session_key)} is ${childState}; no parent resume observed` : "no child session is linked or visible",
      laneId: child ? `child:${child.session_key}` : "runtime",
      eventId: latestYield.id,
      stepId: typeof latestYield.provenance?.step_id === "string" ? latestYield.provenance.step_id : undefined,
      runId: params.activeRunId,
      childSessionKey: child?.session_key || acceptedChildren[0] || null,
      childSessionId: child?.session_id || null,
      sinceTs: latestYield.ts,
      ageMs,
      details: {
        yielded_event: latestYield.id,
        child_state: childState,
        child_updated_at: child?.updated_at || null,
      },
    };
  }

  if (session?.blocker && session?.last_block_ts) {
    return {
      status: "stuck",
      title: `Stuck on ${session.blocker}`,
      subtitle: session.current_op ? `current op: ${session.current_op}` : undefined,
      laneId: "parent",
      runId: params.activeRunId,
      sinceTs: new Date(session.last_block_ts).toISOString(),
      ageMs: now - session.last_block_ts,
      details: {
        diag_state: session.diag_state,
        blocker: session.blocker,
        current_op: session.current_op,
      },
    };
  }

  const latestError = [...params.events].reverse().find(e => e.status === "error");
  if (latestError) {
    return {
      status: "error",
      title: `Latest visible error: ${latestError.title}`,
      subtitle: latestError.subtitle,
      laneId: latestError.laneId,
      eventId: latestError.id,
      stepId: typeof latestError.provenance?.step_id === "string" ? latestError.provenance.step_id : undefined,
      runId: latestError.provenance?.run_id ? String(latestError.provenance.run_id) : params.activeRunId,
      sinceTs: latestError.ts,
      ageMs: latestError.tsEpochMs ? now - latestError.tsEpochMs : null,
    };
  }

  return {
    status: session?.diag_state === "idle" ? "idle" : "ok",
    title: session?.diag_state === "idle" ? "No active blocker" : "Workflow data looks healthy",
    subtitle: session?.current_op ? `last op: ${session.current_op}` : undefined,
    laneId: "parent",
    runId: params.activeRunId,
    sinceTs: session?.updated_at ? new Date(session.updated_at).toISOString() : null,
    ageMs: session?.updated_at ? now - session.updated_at : null,
  };
}

export function getWorkflowGraph(sessionKey: string, runId?: string, sessionId?: string | null): {
  sessionKey: string;
  sessionId: string | null;
  runId: string | null;
  lanes: WorkflowLane[];
  events: WorkflowEvent[];
  edges: WorkflowEdge[];
  diagnostics: WorkflowDiagnostic[];
  validation: WorkflowValidation;
  attention: WorkflowAttention;
  runs: any[];
} {
  const db = getDb();
  const parentKey = baseKey(sessionKey);
  const runs = getRunList(parentKey, sessionId).map(r => ({
    runId: r.run_id,
    startedAt: r.started_at,
    durationMs: r.duration_ms,
    modelSteps: r.model_steps,
    toolSteps: r.tool_steps,
    status: r.status,
  }));
  const activeRunId = runId || runs[0]?.runId || null;

  const parentWhereCol = sessionId ? "session_id" : "session_key";
  const parentWhereVal = sessionId || parentKey;
  let parentSteps = db.prepare(`
    SELECT * FROM steps
    WHERE ${parentWhereCol} = ? ${activeRunId ? "AND run_id = ?" : ""}
    ORDER BY ts_epoch_ms, seq
  `).all(...(activeRunId ? [parentWhereVal, activeRunId] : [parentWhereVal])) as StepRow[];

  const events: WorkflowEvent[] = [];
  const edges: WorkflowEdge[] = [];
  const diagnostics: WorkflowDiagnostic[] = [];
  const lanes: WorkflowLane[] = [
    { id: "user", title: "User", kind: "user" },
    { id: "parent", title: "Parent Session", kind: "parent" },
    { id: "runtime", title: "OpenClaw Runtime", kind: "runtime" },
  ];

  if (parentSteps.length === 0) {
    const emptyLanes = [...lanes, { id: "workflow_state", title: "Workflow State", kind: "workflow_state" } as WorkflowLane];
    const validation = validateWorkflowGraph({
      sessionId,
      parentKey,
      activeRunId,
      lanes: emptyLanes,
      events,
      edges,
      parentSteps,
      childStepMap: new Map(),
      spawnAccepts: [],
    });
    const attention = computeWorkflowAttention({
      sessionId,
      parentKey,
      activeRunId,
      events,
      parentSteps,
      childStepMap: new Map(),
      spawnAccepts: [],
    });
    return {
      sessionKey: parentKey,
      sessionId: sessionId || null,
      runId: activeRunId,
      lanes: emptyLanes,
      events,
      edges,
      diagnostics,
      validation,
      attention,
      runs,
    };
  }

  const firstTs = parentSteps[0]?.ts_epoch_ms || Date.now();
  const firstIso = parentSteps[0]?.ts || new Date(firstTs).toISOString();
  const userEvent = addEvent(events, {
    laneId: "user",
    type: "user_message",
    ts: firstIso,
    tsEpochMs: firstTs,
    title: "user message",
    subtitle: activeRunId ? shortKey(activeRunId) : "latest run",
    provenance: { run_id: activeRunId, session_key: parentKey },
  });

  const spawnAccepts: Array<{ requested: WorkflowEvent; accepted?: WorkflowEvent; acceptedData: SpawnAccepted; step: StepRow }> = [];
  let previousParentEvent: WorkflowEvent | undefined = userEvent;

  for (const step of parentSteps) {
    const provenance = stepProvenance(step, parentSteps);
    if (step.tool_name === "sessions_spawn" || step.node_type === "SUBAGENT_SPAWN") {
      const requested = addEvent(events, {
        laneId: "parent",
        type: "sessions_spawn_requested",
        ts: step.ts,
        tsEpochMs: step.ts_epoch_ms,
        title: "sessions_spawn",
        subtitle: step.input_preview?.slice(0, 120) || "spawn requested",
        status: step.status || undefined,
        provenance,
      });
      addEdge(edges, previousParentEvent, requested, "causal");
      previousParentEvent = requested;
      const acceptedData = extractSpawnAccepted(step);
      if (acceptedData) {
        const accepted = addEvent(events, {
          laneId: "runtime",
          type: "sessions_spawn_accepted",
          ts: step.ts,
          tsEpochMs: step.ts_epoch_ms + 1,
          title: "spawn accepted",
          subtitle: acceptedData.taskName || shortKey(acceptedData.childSessionKey),
          status: acceptedData.mode || step.status || undefined,
          provenance: {
            ...provenance,
            childSessionKey: acceptedData.childSessionKey,
            child_run_id: acceptedData.runId,
            task_name: acceptedData.taskName,
          },
        });
        addEdge(edges, requested, accepted, "spawn", "accepted");
        spawnAccepts.push({ requested, accepted, acceptedData, step });
      } else {
        diagnostics.push({
          id: `diag-${diagnostics.length + 1}`,
          severity: "warning",
          type: "spawn_without_accept",
          message: "sessions_spawn step has no parseable childSessionKey/runId result",
          eventId: requested.id,
        });
      }
      continue;
    }

    if (step.tool_name === "sessions_yield") {
      const e = addEvent(events, {
        laneId: "runtime",
        type: "sessions_yield",
        ts: step.ts,
        tsEpochMs: step.ts_epoch_ms,
        title: "sessions_yield",
        subtitle: "parent paused",
        status: step.status || undefined,
        provenance,
      });
      addEdge(edges, previousParentEvent, e, "causal", "pause");
      previousParentEvent = e;
      continue;
    }

    if (isCheckpointWrite(step)) {
      const paths = artifactPaths(`${step.input_preview || ""} ${step.result_preview || ""}`);
      const e = addEvent(events, {
        laneId: "parent",
        type: "checkpoint_write",
        ts: step.ts,
        tsEpochMs: step.ts_epoch_ms,
        title: eventLabelForStep(step),
        subtitle: paths[0] || "checkpoint write",
        status: step.status || undefined,
        provenance: { ...provenance, artifact_path: paths[0] || null },
      });
      addEdge(edges, previousParentEvent, e, "causal");
      previousParentEvent = e;
      continue;
    }

    if (isSourceOrSkillStep(step)) {
      const e = addEvent(events, {
        laneId: "parent",
        type: "skill_or_source_step",
        ts: step.ts,
        tsEpochMs: step.ts_epoch_ms,
        title: eventLabelForStep(step),
        subtitle: step.input_preview?.slice(0, 100) || undefined,
        status: step.status || undefined,
        provenance,
      });
      addEdge(edges, previousParentEvent, e, "causal");
      previousParentEvent = e;
    }
  }

  const childKeys = new Set<string>();
  for (const s of spawnAccepts) if (s.acceptedData.childSessionKey) childKeys.add(baseKey(s.acceptedData.childSessionKey));

  const childStepMap = new Map<string, StepRow[]>();
  const resumeEventsByStepId = new Map<string, WorkflowEvent>();
  for (const childKey of childKeys) {
    lanes.push({ id: `child:${childKey}`, title: `Child ${shortKey(childKey)}`, kind: "child" });
    const childRunIds = spawnAccepts
      .filter(s => s.acceptedData.childSessionKey && baseKey(s.acceptedData.childSessionKey) === childKey && s.acceptedData.runId)
      .map(s => s.acceptedData.runId as string);
    const rows = childRunIds.length > 0
      ? db.prepare(`
          SELECT * FROM steps
          WHERE session_key = ? AND run_id IN (${childRunIds.map(() => "?").join(",")})
          ORDER BY ts_epoch_ms, seq
        `).all(childKey, ...childRunIds) as StepRow[]
      : db.prepare(`
          SELECT * FROM steps WHERE session_key = ? ORDER BY ts_epoch_ms, seq
        `).all(childKey) as StepRow[];
    childStepMap.set(childKey, rows);

    const first = rows[0];
    if (!first) continue;
    const started = addEvent(events, {
      laneId: `child:${childKey}`,
      type: "child_started",
      ts: first.ts,
      tsEpochMs: first.ts_epoch_ms,
      title: "child started",
      subtitle: shortKey(childKey),
      provenance: { ...stepProvenance(first, rows), childSessionKey: childKey },
    });
    const accepted = spawnAccepts.find(s => s.acceptedData.childSessionKey && baseKey(s.acceptedData.childSessionKey) === childKey)?.accepted;
    addEdge(edges, accepted, started, "spawn", "start");

    for (const step of rows) {
      if (!/(write|edit|patch|save)/i.test(step.tool_name || "") && !isCheckpointWrite(step)) continue;
      const paths = artifactPaths(`${step.input_preview || ""} ${step.result_preview || ""}`);
      if (paths.length === 0) continue;
      addEdge(edges, started, addEvent(events, {
        laneId: `child:${childKey}`,
        type: "child_artifact_written",
        ts: step.ts,
        tsEpochMs: step.ts_epoch_ms,
        title: eventLabelForStep(step),
        subtitle: paths[0],
        status: step.status || undefined,
        provenance: { ...stepProvenance(step, rows), childSessionKey: childKey, artifact_path: paths[0] },
      }), "causal");
    }

    const finalStep = [...rows].reverse().find(s => s.node_type === "REPLY") || rows[rows.length - 1];
    const final = addEvent(events, {
      laneId: `child:${childKey}`,
      type: "child_final",
      ts: finalStep.ts,
      tsEpochMs: finalStep.ts_epoch_ms,
      title: "child final",
      subtitle: finalStep.result_preview?.slice(0, 120) || finalStep.input_preview?.slice(0, 120) || undefined,
      status: finalStep.status || undefined,
      provenance: { ...stepProvenance(finalStep, rows), childSessionKey: childKey },
    });
    addEdge(edges, started, final, "causal");

    const resumedStep = parentSteps.find(s => s.ts_epoch_ms > finalStep.ts_epoch_ms);
    if (resumedStep) {
      let resumed = resumeEventsByStepId.get(resumedStep.step_id);
      if (!resumed) {
        resumed = addEvent(events, {
          laneId: "parent",
          type: "parent_resumed",
          ts: resumedStep.ts,
          tsEpochMs: resumedStep.ts_epoch_ms + 1,
          title: "parent resumed",
          subtitle: eventLabelForStep(resumedStep),
          provenance: { ...stepProvenance(resumedStep, parentSteps), childSessionKey: childKey },
        });
        resumeEventsByStepId.set(resumedStep.step_id, resumed);
      }
      addEdge(edges, final, resumed, "resume", "resume");
    } else {
      diagnostics.push({
        id: `diag-${diagnostics.length + 1}`,
        severity: "info",
        type: "unmatched_child_completion",
        message: `Child ${shortKey(childKey)} completed without a later visible parent step in this run`,
        eventId: final.id,
      });
    }
  }

  lanes.push({ id: "workflow_state", title: "Workflow State", kind: "workflow_state" });
  const allChildSteps = [...childStepMap.values()].flat();
  const workflowState = workflowStateFromArtifacts(parentSteps, allChildSteps);
  const taskTs = (parentSteps.find(s => /work_status\.md/.test(`${s.input_preview || ""} ${s.result_preview || ""}`)) || parentSteps[parentSteps.length - 1])?.ts_epoch_ms || firstTs;
  if (workflowState) {
    const snapshot = addEvent(events, {
      laneId: "workflow_state",
      type: "workflow_state_snapshot",
      ts: new Date(taskTs).toISOString(),
      tsEpochMs: taskTs,
      title: "workflow snapshot",
      subtitle: workflowState.currentStep || workflowState.flowId || workflowState.adapterId,
      provenance: {
        adapter_id: workflowState.adapterId,
        flow_id: workflowState.flowId,
        work_key: workflowState.workKey,
        artifact_path: workflowState.sourcePath,
      },
    });
    for (const spawn of spawnAccepts) {
      if (childMatchesWorkflowState(spawn.acceptedData, workflowState)) {
        const bound = addEvent(events, {
          laneId: "workflow_state",
          type: "workflow_state_child_bound",
          ts: spawn.step.ts,
          tsEpochMs: spawn.step.ts_epoch_ms + 2,
          title: "child bound",
          subtitle: spawn.acceptedData.taskName || shortKey(spawn.acceptedData.childSessionKey),
          provenance: {
            adapter_id: workflowState.adapterId,
            flow_id: workflowState.flowId,
            childSessionKey: spawn.acceptedData.childSessionKey,
            child_run_id: spawn.acceptedData.runId,
            artifact_path: workflowState.sourcePath,
          },
        });
        addEdge(edges, spawn.accepted, bound, "workflow_state", "bound");
      } else {
        const gap = addEvent(events, {
          laneId: "workflow_state",
          type: "workflow_state_gap",
          ts: spawn.step.ts,
          tsEpochMs: spawn.step.ts_epoch_ms + 2,
          title: "child binding gap",
          subtitle: "accepted child not present in workflow state",
          status: "warning",
          provenance: {
            adapter_id: workflowState.adapterId,
            flow_id: workflowState.flowId,
            childSessionKey: spawn.acceptedData.childSessionKey,
            child_run_id: spawn.acceptedData.runId,
            artifact_path: workflowState.sourcePath,
          },
        });
        addEdge(edges, spawn.accepted, gap, "workflow_state", "gap");
        diagnostics.push({
          id: `diag-${diagnostics.length + 1}`,
          severity: "warning",
          type: "workflow_state_child_refs_empty",
          message: "Accepted child is missing from managed workflow child references",
          eventId: gap.id,
        });
      }
    }
  } else {
    const gap = addEvent(events, {
      laneId: "workflow_state",
      type: "workflow_state_gap",
      ts: new Date(taskTs).toISOString(),
      tsEpochMs: taskTs,
      title: "Workflow state unavailable",
      subtitle: "no managed workflow projection",
      status: spawnAccepts.length ? "warning" : "info",
      provenance: { session_key: parentKey, run_id: activeRunId },
    });
    if (spawnAccepts.length > 0) {
      diagnostics.push({
        id: `diag-${diagnostics.length + 1}`,
        severity: "warning",
        type: "workflow_state_unavailable",
        message: "No managed workflow projection found; child binding cannot be verified",
        eventId: gap.id,
      });
    }
  }

  events.sort((a, b) => (
    (a.tsEpochMs - b.tsEpochMs) ||
    (eventOrderRank(a.type) - eventOrderRank(b.type)) ||
    a.laneId.localeCompare(b.laneId)
  ));

  const validation = validateWorkflowGraph({
    sessionId,
    parentKey,
    activeRunId,
    lanes,
    events,
    edges,
    parentSteps,
    childStepMap,
    spawnAccepts,
  });
  const attention = computeWorkflowAttention({
    sessionId,
    parentKey,
    activeRunId,
    events,
    parentSteps,
    childStepMap,
    spawnAccepts,
  });
  for (const check of validation.checks) {
    if (check.status === "ok") continue;
    diagnostics.push({
      id: `diag-${diagnostics.length + 1}`,
      severity: check.status,
      type: `validation_${check.id.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`,
      message: check.message,
      eventId: check.eventId,
    });
  }

  return {
    sessionKey: parentKey,
    sessionId: sessionId || null,
    runId: activeRunId,
    lanes,
    events,
    edges,
    diagnostics,
    validation,
    attention,
    runs,
  };
}
