import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "../config.ts";
import { getDb } from "./db.ts";
import { getRunList } from "./steps-repo.ts";
import { getWorkflowGraph } from "./workflow-repo.ts";

export type PromptCheckSeverity = "info" | "warning" | "error";
export type PromptCheckStatus = "ok" | "warning" | "error";

export interface PromptRuleConfig {
  ruleId: string;
  title: string;
  severity?: PromptCheckSeverity;
  enabled?: boolean;
  agentScope?: string[];
  sourceFiles?: string[];
  evidenceMatchers?: Record<string, unknown>;
  failureMessage?: string;
}

export interface PromptSource {
  id: string;
  kind: "prompt" | "rule";
  path: string;
  exists: boolean;
  hash: string | null;
  mtime: number | null;
  title: string;
}

export interface PromptRuleResult {
  ruleId: string;
  title: string;
  severity: PromptCheckSeverity;
  status: PromptCheckStatus;
  message: string;
  evidenceStepIds: string[];
  sourceFiles: string[];
}

export interface PromptHookResult {
  eventId: string;
  hookId: string;
  event: string;
  severity: PromptCheckSeverity;
  status: "bound" | "unbound";
  message: string | null;
  ts: string;
  runId: string | null;
  relatedStepId: string | null;
}

export interface PromptDiagnostic {
  id: string;
  severity: PromptCheckSeverity;
  type: string;
  message: string;
  provenance: Record<string, string | number | null>;
}

export interface PromptCheck {
  sessionKey: string;
  sessionId: string | null;
  runId: string | null;
  status: PromptCheckStatus;
  promptSources: PromptSource[];
  rules: PromptRuleResult[];
  hooks: PromptHookResult[];
  diagnostics: PromptDiagnostic[];
  runs: Array<{
    runId: string;
    startedAt: string;
    durationMs: number | null;
    modelSteps: number;
    toolSteps: number;
    status: string;
  }>;
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
  input_preview: string | null;
  result_preview: string | null;
}

interface SpawnAccepted {
  childSessionKey: string | null;
  runId: string | null;
}

const EXT_ROOT = join(import.meta.dirname, "..", "..");
const RULES_PATH = join(EXT_ROOT, "config", "prompt-rules.json");
const BASE_KEY_RE = /:run:[a-f0-9-]+$/;

function baseKey(key: string): string {
  return key.replace(BASE_KEY_RE, "");
}

function normalizeSeverity(value: unknown): PromptCheckSeverity {
  return value === "error" || value === "warning" ? value : "info";
}

function worstStatus(items: Array<{ status?: string; severity?: string }>): PromptCheckStatus {
  if (items.some(i => i.status === "error" || i.severity === "error")) return "error";
  if (items.some(i => i.status === "warning" || i.severity === "warning")) return "warning";
  return "ok";
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
    return { childSessionKey, runId };
  }
  const childSessionKey = typeof json.childSessionKey === "string" ? json.childSessionKey : null;
  const runId = typeof json.runId === "string" ? json.runId : null;
  if (!childSessionKey && !runId) return null;
  return { childSessionKey, runId };
}

function resolveSourcePath(path: string): string {
  if (path.startsWith("/")) return path;
  if (path.startsWith("config/")) return join(EXT_ROOT, path);
  return join(CONFIG.OPENCLAW_HOME, path);
}

function hashFile(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return createHash("sha1").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

export function loadPromptRules(path = RULES_PATH): PromptRuleConfig[] {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf-8"));
  const rules = Array.isArray(parsed?.rules) ? parsed.rules : [];
  return rules
    .filter((r: any) => r && typeof r.ruleId === "string" && r.enabled !== false)
    .map((r: any) => ({
      ...r,
      severity: normalizeSeverity(r.severity || "warning"),
      sourceFiles: Array.isArray(r.sourceFiles) ? r.sourceFiles.filter((p: unknown) => typeof p === "string") : [],
    }));
}

function promptSourcesForRules(rules: PromptRuleConfig[]): PromptSource[] {
  const paths = new Set<string>(["config/prompt-rules.json"]);
  for (const rule of rules) for (const p of rule.sourceFiles || []) paths.add(p);
  return [...paths].map((p) => {
    const resolved = resolveSourcePath(p);
    let mtime: number | null = null;
    try { mtime = statSync(resolved).mtimeMs; } catch { /* missing source is diagnostic context */ }
    return {
      id: createHash("sha1").update(p).digest("hex").slice(0, 12),
      kind: p === "config/prompt-rules.json" ? "rule" : "prompt",
      path: p,
      exists: existsSync(resolved),
      hash: hashFile(resolved),
      mtime,
      title: p.split("/").pop() || p,
    };
  });
}

function hasCheckpointBefore(steps: StepRow[], tsEpochMs: number): StepRow | undefined {
  return steps.find(s => s.ts_epoch_ms <= tsEpochMs && /(checkpoint|work_status\.md|source_collection)/i.test(`${s.tool_name || ""} ${s.input_preview || ""} ${s.result_preview || ""}`));
}

function firstSourceOp(steps: StepRow[]): StepRow | undefined {
  return steps.find(s => {
    const text = `${s.tool_name || ""} ${s.input_preview || ""}`;
    if (/SKILL\.md/.test(text)) return false;
    return /(research_query|url_router|arxiv|source|manifest_query|related_work|code_audit)/i.test(text);
  });
}

function sourceSkillReadBefore(steps: StepRow[], tsEpochMs: number): StepRow | undefined {
  return steps.find(s => s.ts_epoch_ms <= tsEpochMs && s.tool_name === "read" && /SKILL\.md/.test(s.input_preview || ""));
}

function addRuleResult(results: PromptRuleResult[], rule: PromptRuleConfig, status: PromptCheckStatus, message: string, evidenceStepIds: string[] = []) {
  results.push({
    ruleId: rule.ruleId,
    title: rule.title,
    severity: normalizeSeverity(rule.severity || "warning"),
    status,
    message,
    evidenceStepIds,
    sourceFiles: rule.sourceFiles || [],
  });
}

function evaluateRules(rules: PromptRuleConfig[], steps: StepRow[], sessionId: string | null, activeRunId: string | null): PromptRuleResult[] {
  const db = getDb();
  const results: PromptRuleResult[] = [];
  const spawnSteps = steps.filter(s => s.tool_name === "sessions_spawn" || s.node_type === "SUBAGENT_SPAWN");
  const accepted = spawnSteps.map(s => ({ step: s, accepted: extractSpawnAccepted(s) }));
  const agentId = steps[0]?.session_key?.split(":")[1] || "";

  for (const rule of rules) {
    if (rule.agentScope?.length && !rule.agentScope.includes(agentId)) continue;

    if (rule.ruleId === "read_source_skill_before_source_ops") {
      const source = firstSourceOp(steps);
      if (!source) {
        addRuleResult(results, rule, "ok", "No source operation in this run.");
      } else {
        const read = sourceSkillReadBefore(steps, source.ts_epoch_ms);
        addRuleResult(results, rule, read ? "ok" : "warning", read ? "Source skill was read before source operations." : (rule.failureMessage || "Missing source skill read."), read ? [read.step_id, source.step_id] : [source.step_id]);
      }
      continue;
    }

    if (rule.ruleId === "checkpoint_before_sessions_yield") {
      const yields = steps.filter(s => s.tool_name === "sessions_yield");
      if (yields.length === 0) {
        addRuleResult(results, rule, "ok", "No sessions_yield in this run.");
      } else {
        const bad = yields.find(y => !hasCheckpointBefore(steps, y.ts_epoch_ms));
        const good = yields.find(y => hasCheckpointBefore(steps, y.ts_epoch_ms));
        addRuleResult(results, rule, bad ? "warning" : "ok", bad ? (rule.failureMessage || "Missing checkpoint before yield.") : "Checkpoint exists before sessions_yield.", bad ? [bad.step_id] : [good?.step_id].filter(Boolean) as string[]);
      }
      continue;
    }

    if (rule.ruleId === "spawn_accept_must_have_child_key_run_id") {
      if (spawnSteps.length === 0) {
        addRuleResult(results, rule, "ok", "No sessions_spawn in this run.");
      } else {
        const bad = accepted.find(x => !x.accepted?.childSessionKey || !x.accepted?.runId);
        addRuleResult(results, rule, bad ? "warning" : "ok", bad ? (rule.failureMessage || "Spawn result missing child key or run id.") : "All spawn results expose childSessionKey and runId.", bad ? [bad.step.step_id] : spawnSteps.map(s => s.step_id));
      }
      continue;
    }

    if (rule.ruleId === "accepted_child_should_be_visible") {
      const visibleBad = accepted.find(x => {
        if (!x.accepted?.childSessionKey || !x.accepted?.runId) return false;
        const childKey = baseKey(x.accepted.childSessionKey);
        const row = db.prepare("SELECT 1 FROM steps WHERE session_key = ? AND run_id = ? LIMIT 1").get(childKey, x.accepted.runId) as any;
        return !row;
      });
      addRuleResult(results, rule, visibleBad ? "warning" : "ok", visibleBad ? (rule.failureMessage || "Accepted child is not visible.") : "Accepted child sessions are visible.", visibleBad ? [visibleBad.step.step_id] : spawnSteps.map(s => s.step_id));
      continue;
    }

    if (rule.ruleId === "workflow_state_should_bind_child_or_show_gap") {
      if (spawnSteps.length === 0) {
        addRuleResult(results, rule, "ok", "No accepted child requiring workflow state.");
      } else {
        const graph = getWorkflowGraph(steps[0]?.session_key || "", activeRunId || undefined, sessionId);
        const types = new Set(graph.events.map(e => e.type));
        const hasGapDiagnostic = graph.diagnostics.some(d => d.type === "workflow_state_unavailable" || d.type === "workflow_state_child_refs_empty");
        const ok = types.has("workflow_state_child_bound") || types.has("workflow_state_gap") || hasGapDiagnostic;
        addRuleResult(results, rule, ok ? "ok" : "warning", ok ? "Workflow state is bound or an explicit gap is visible." : (rule.failureMessage || "Workflow state has no binding or gap."), spawnSteps.map(s => s.step_id));
      }
      continue;
    }

    addRuleResult(results, rule, "ok", "Rule loaded; no evaluator implemented.");
  }

  return results;
}

function hookRows(parentKey: string, sessionId: string | null, runId: string | null): any[] {
  const db = getDb();
  const params: any[] = [];
  let sql = "SELECT * FROM hook_events WHERE 1=1";
  if (sessionId) {
    sql += " AND (session_id = ? OR (session_id IS NULL AND session_key = ?))";
    params.push(sessionId, parentKey);
  } else {
    sql += " AND session_key = ?";
    params.push(parentKey);
  }
  if (runId) {
    sql += " AND (run_id = ? OR run_id IS NULL)";
    params.push(runId);
  }
  sql += " ORDER BY ts_epoch_ms, line_no";
  return db.prepare(sql).all(...params) as any[];
}

function diagnosticsForRulesAndHooks(rules: PromptRuleResult[], hooks: PromptHookResult[]): PromptDiagnostic[] {
  const diagnostics: PromptDiagnostic[] = [];
  for (const r of rules) {
    if (r.status === "ok") continue;
    diagnostics.push({
      id: `diag-${diagnostics.length + 1}`,
      severity: r.severity,
      type: `rule_${r.ruleId}`,
      message: r.message,
      provenance: { rule_id: r.ruleId, step_id: r.evidenceStepIds[0] || null, source_file: r.sourceFiles[0] || null },
    });
  }
  for (const h of hooks) {
    if (h.status !== "unbound") continue;
    diagnostics.push({
      id: `diag-${diagnostics.length + 1}`,
      severity: "warning",
      type: "unbound_hook_event",
      message: `Hook event ${h.hookId} is missing session/run/step binding`,
      provenance: { hook_id: h.hookId, run_id: h.runId, step_id: h.relatedStepId },
    });
  }
  return diagnostics;
}

export function getPromptCheck(sessionKey: string, runId?: string, sessionId?: string | null): PromptCheck {
  const db = getDb();
  const parentKey = baseKey(sessionKey);
  const activeRunId = runId || (getRunList(parentKey, sessionId)[0]?.run_id ?? null);
  const rows = activeRunId
    ? db.prepare(`
        SELECT * FROM steps
        WHERE ${sessionId ? "session_id = ?" : "session_key = ?"} AND run_id = ?
        ORDER BY seq
      `).all(sessionId || parentKey, activeRunId) as StepRow[]
    : [];
  const rules = loadPromptRules();
  const ruleResults = evaluateRules(rules, rows, sessionId || null, activeRunId);
  const hooks = hookRows(parentKey, sessionId || null, activeRunId).map((h): PromptHookResult => {
    const bound = !!(h.session_id && h.run_id && h.related_step_id);
    return {
      eventId: h.event_id,
      hookId: h.hook_id,
      event: h.event,
      severity: normalizeSeverity(h.severity),
      status: bound ? "bound" : "unbound",
      message: h.message,
      ts: h.ts,
      runId: h.run_id,
      relatedStepId: h.related_step_id,
    };
  });
  const diagnostics = diagnosticsForRulesAndHooks(ruleResults, hooks);
  const runs = getRunList(parentKey, sessionId).map(r => ({
    runId: r.run_id,
    startedAt: r.started_at,
    durationMs: r.duration_ms,
    modelSteps: r.model_steps,
    toolSteps: r.tool_steps,
    status: r.status,
  }));

  return {
    sessionKey: parentKey,
    sessionId: sessionId || null,
    runId: activeRunId,
    status: worstStatus([...ruleResults, ...diagnostics]),
    promptSources: promptSourcesForRules(rules),
    rules: ruleResults,
    hooks,
    diagnostics,
    runs,
  };
}
