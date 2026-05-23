import { existsSync, readFileSync } from "node:fs";
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
  | "taskflow_plan_snapshot"
  | "taskflow_child_bound"
  | "taskflow_gap";

export interface WorkflowLane {
  id: string;
  title: string;
  kind: "user" | "parent" | "runtime" | "child" | "taskflow";
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
  type: "causal" | "spawn" | "resume" | "taskflow";
  label?: string;
}

export interface WorkflowDiagnostic {
  id: string;
  severity: "info" | "warning" | "error";
  type: string;
  message: string;
  eventId?: string;
}

interface StepRow {
  step_id: string;
  session_key: string;
  run_id: string;
  seq: number;
  ts: string;
  ts_epoch_ms: number;
  role: string;
  node_type: string;
  tool_name: string | null;
  status: string | null;
  input_preview: string | null;
  result_preview: string | null;
  error_text: string | null;
}

interface SpawnAccepted {
  childSessionKey: string | null;
  runId: string | null;
  taskName: string | null;
  mode: string | null;
}

interface TaskFlowSnapshot {
  flowId: string | null;
  workKey: string | null;
  currentStep: string | null;
  childRefs: string[];
  sourcePath: string;
}

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
  if (!json || typeof json !== "object") return null;
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

function taskFlowFromWorkStatus(parentSteps: StepRow[], childSteps: StepRow[]): TaskFlowSnapshot | null {
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
    const block = raw.match(/<!-- researcher-orchestrator:start -->([\s\S]*?)<!-- researcher-orchestrator:end -->/);
    if (!block) continue;
    const body = block[1];
    const flowId = body.match(/\bflow_id:\s*([^\n]+)/)?.[1]?.trim() || null;
    const workKey = body.match(/\bwork_key:\s*([^\n]+)/)?.[1]?.trim() || null;
    const currentStep = body.match(/\bcurrent_step:\s*([^\n]+)/)?.[1]?.trim() || null;
    const childRefs: string[] = [];
    for (const line of body.split("\n")) {
      if (/child|run|session|waiting/i.test(line)) childRefs.push(line.trim());
    }
    return { flowId, workKey, currentStep, childRefs, sourcePath: path };
  }
  return null;
}

function childMatchesTaskFlow(child: SpawnAccepted, snapshot: TaskFlowSnapshot | null): boolean {
  if (!snapshot) return false;
  const haystack = snapshot.childRefs.join("\n");
  return !!(
    (child.childSessionKey && haystack.includes(child.childSessionKey)) ||
    (child.runId && haystack.includes(child.runId))
  );
}

export function getWorkflowGraph(sessionKey: string, runId?: string): {
  sessionKey: string;
  runId: string | null;
  lanes: WorkflowLane[];
  events: WorkflowEvent[];
  edges: WorkflowEdge[];
  diagnostics: WorkflowDiagnostic[];
  runs: any[];
} {
  const db = getDb();
  const parentKey = baseKey(sessionKey);
  const runs = getRunList(parentKey).map(r => ({
    runId: r.run_id,
    startedAt: r.started_at,
    durationMs: r.duration_ms,
    modelSteps: r.model_steps,
    toolSteps: r.tool_steps,
    status: r.status,
  }));
  const activeRunId = runId || runs[0]?.runId || null;

  const parentSteps = db.prepare(`
    SELECT * FROM steps
    WHERE session_key = ? ${activeRunId ? "AND run_id = ?" : ""}
    ORDER BY ts_epoch_ms, seq
  `).all(...(activeRunId ? [parentKey, activeRunId] : [parentKey])) as StepRow[];

  const events: WorkflowEvent[] = [];
  const edges: WorkflowEdge[] = [];
  const diagnostics: WorkflowDiagnostic[] = [];
  const lanes: WorkflowLane[] = [
    { id: "user", title: "User / Feishu", kind: "user" },
    { id: "parent", title: "Parent Researcher", kind: "parent" },
    { id: "runtime", title: "OpenClaw Runtime", kind: "runtime" },
  ];

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
    const provenance = {
      step_id: step.step_id,
      run_id: step.run_id,
      session_key: step.session_key,
      tool_name: step.tool_name,
    };
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

  const sessionRows = db.prepare(`
    SELECT session_key, session_id, label, parent_session_key, parent_session_id
    FROM sessions
    WHERE parent_session_key = ?
       OR parent_session_id IN (SELECT session_id FROM sessions WHERE session_key = ?)
  `).all(parentKey, parentKey) as Array<{ session_key: string; session_id: string | null; label: string | null }>;

  const childKeys = new Set<string>();
  for (const s of spawnAccepts) if (s.acceptedData.childSessionKey) childKeys.add(baseKey(s.acceptedData.childSessionKey));
  for (const row of sessionRows) if (row.session_key) childKeys.add(baseKey(row.session_key));

  const childStepMap = new Map<string, StepRow[]>();
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
      provenance: { step_id: first.step_id, run_id: first.run_id, childSessionKey: childKey },
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
        provenance: { step_id: step.step_id, run_id: step.run_id, childSessionKey: childKey, artifact_path: paths[0] },
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
      provenance: { step_id: finalStep.step_id, run_id: finalStep.run_id, childSessionKey: childKey },
    });
    addEdge(edges, started, final, "causal");

    const resumedStep = parentSteps.find(s => s.ts_epoch_ms > finalStep.ts_epoch_ms);
    if (resumedStep) {
      const resumed = addEvent(events, {
        laneId: "parent",
        type: "parent_resumed",
        ts: resumedStep.ts,
        tsEpochMs: resumedStep.ts_epoch_ms + 1,
        title: "parent resumed",
        subtitle: eventLabelForStep(resumedStep),
        provenance: { step_id: resumedStep.step_id, run_id: resumedStep.run_id, childSessionKey: childKey },
      });
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

  lanes.push({ id: "taskflow", title: "TaskFlow", kind: "taskflow" });
  const allChildSteps = [...childStepMap.values()].flat();
  const taskflow = taskFlowFromWorkStatus(parentSteps, allChildSteps);
  const taskTs = (parentSteps.find(s => /work_status\.md/.test(`${s.input_preview || ""} ${s.result_preview || ""}`)) || parentSteps[parentSteps.length - 1])?.ts_epoch_ms || firstTs;
  if (taskflow) {
    const snapshot = addEvent(events, {
      laneId: "taskflow",
      type: "taskflow_plan_snapshot",
      ts: new Date(taskTs).toISOString(),
      tsEpochMs: taskTs,
      title: "plan snapshot",
      subtitle: taskflow.currentStep || taskflow.flowId || "researcher-orchestrator",
      provenance: {
        flow_id: taskflow.flowId,
        work_key: taskflow.workKey,
        artifact_path: taskflow.sourcePath,
      },
    });
    for (const spawn of spawnAccepts) {
      if (childMatchesTaskFlow(spawn.acceptedData, taskflow)) {
        const bound = addEvent(events, {
          laneId: "taskflow",
          type: "taskflow_child_bound",
          ts: spawn.step.ts,
          tsEpochMs: spawn.step.ts_epoch_ms + 2,
          title: "child bound",
          subtitle: spawn.acceptedData.taskName || shortKey(spawn.acceptedData.childSessionKey),
          provenance: {
            flow_id: taskflow.flowId,
            childSessionKey: spawn.acceptedData.childSessionKey,
            child_run_id: spawn.acceptedData.runId,
            artifact_path: taskflow.sourcePath,
          },
        });
        addEdge(edges, spawn.accepted, bound, "taskflow", "bound");
      } else {
        const gap = addEvent(events, {
          laneId: "taskflow",
          type: "taskflow_gap",
          ts: spawn.step.ts,
          tsEpochMs: spawn.step.ts_epoch_ms + 2,
          title: "childRuns gap",
          subtitle: "accepted child not present in TaskFlow",
          status: "warning",
          provenance: {
            flow_id: taskflow.flowId,
            childSessionKey: spawn.acceptedData.childSessionKey,
            child_run_id: spawn.acceptedData.runId,
            artifact_path: taskflow.sourcePath,
          },
        });
        addEdge(edges, spawn.accepted, gap, "taskflow", "gap");
        diagnostics.push({
          id: `diag-${diagnostics.length + 1}`,
          severity: "warning",
          type: "taskflow_childruns_empty",
          message: "TaskFlow childRuns empty or missing after accepted child",
          eventId: gap.id,
        });
      }
    }
  } else {
    const gap = addEvent(events, {
      laneId: "taskflow",
      type: "taskflow_gap",
      ts: new Date(taskTs).toISOString(),
      tsEpochMs: taskTs,
      title: "TaskFlow unavailable",
      subtitle: "no managed work_status projection",
      status: spawnAccepts.length ? "warning" : "info",
      provenance: { session_key: parentKey, run_id: activeRunId },
    });
    if (spawnAccepts.length > 0) {
      diagnostics.push({
        id: `diag-${diagnostics.length + 1}`,
        severity: "warning",
        type: "taskflow_unavailable",
        message: "No researcher-orchestrator managed projection found; child binding cannot be verified",
        eventId: gap.id,
      });
    }
  }

  events.sort((a, b) => (a.tsEpochMs - b.tsEpochMs) || a.laneId.localeCompare(b.laneId));

  return {
    sessionKey: parentKey,
    runId: activeRunId,
    lanes,
    events,
    edges,
    diagnostics,
    runs,
  };
}
