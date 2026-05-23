/**
 * Frontend checks for the native Workflow Graph renderer.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

let passed = 0;
let failed = 0;
const failures: string[] = [];
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
}

function loadAppJs() {
  let code = readFileSync(join(REPO_ROOT, "src/frontend/app.js"), "utf-8");
  code = code.replace(/\/\/ Boot\s*\nrefresh\(\);\s*\nsetInterval\(refresh, 5000\);\s*$/m, "/* test: boot skipped */");

  class FakeClassList {
    _s = new Set<string>();
    add(c: string) { this._s.add(c); }
    remove(c: string) { this._s.delete(c); }
    toggle(c: string) { if (this._s.has(c)) this._s.delete(c); else this._s.add(c); }
  }
  function makeElement(): any {
    const el: any = { innerHTML: "", className: "", dataset: {}, options: [], style: {}, value: "" };
    let txt = "";
    Object.defineProperty(el, "textContent", {
      get() { return txt; },
      set(v: unknown) { txt = String(v ?? ""); el.innerHTML = txt.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); },
    });
    el.classList = new FakeClassList();
    el.addEventListener = () => {};
    el.appendChild = (c: any) => c;
    el.removeChild = () => {};
    el.select = () => {};
    el.add = (opt: any) => { el.options.push(opt); };
    el.querySelectorAll = () => ({ forEach: (_fn: any) => {}, length: 0 });
    el.querySelector = () => makeElement();
    return el;
  }

  const elementsById = new Map<string, any>();
  const fakeDoc: any = {
    getElementById(id: string) {
      let el = elementsById.get(id);
      if (!el) { el = makeElement(); elementsById.set(id, el); }
      return el;
    },
    querySelectorAll() { return { forEach: (_fn: any) => {}, length: 0 }; },
    querySelector() { return makeElement(); },
    createElement() { return makeElement(); },
    body: { appendChild: () => {}, removeChild: () => {} },
    execCommand: () => {},
  };

  const fetchResponses = new Map<string, unknown>();
  async function fakeFetch(url: string): Promise<any> {
    for (const [pat, payload] of fetchResponses) {
      if (url.includes(pat)) return { ok: true, json: async () => payload };
    }
    return { ok: true, json: async () => ({}) };
  }

  const ctx: any = {
    document: fakeDoc,
    location: { hash: "", search: "" },
    navigator: {},
    fetch: fakeFetch,
    setInterval: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => {},
    URLSearchParams: globalThis.URLSearchParams,
    URL: globalThis.URL,
    Promise, console, Date, Math, Object, Array, String, Number, Boolean, JSON, Map, Set, Symbol, Error,
    encodeURIComponent: globalThis.encodeURIComponent,
    decodeURIComponent: globalThis.decodeURIComponent,
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);

  return {
    ctx,
    setFetchResponse(pattern: string, payload: unknown) { fetchResponses.set(pattern, payload); },
    detailHtml() { return fakeDoc.getElementById("session-detail").innerHTML as string; },
  };
}

function sampleWorkflow() {
  return {
    sessionKey: "parent",
    runId: "run-12345678",
    lanes: [
      { id: "user", title: "User", kind: "user" },
      { id: "parent", title: "Parent Session", kind: "parent" },
      { id: "runtime", title: "OpenClaw Runtime", kind: "runtime" },
      { id: "child:abc", title: "Child abc", kind: "child" },
      { id: "taskflow", title: "Workflow State", kind: "taskflow" },
    ],
    events: [
      { id: "e1", laneId: "user", type: "user_message", ts: "2026-05-23T07:31:00Z", tsEpochMs: 1, title: "user message", provenance: { run_id: "run-12345678" } },
      { id: "e1b", laneId: "parent", type: "skill_or_source_step", ts: "2026-05-23T07:31:00.500Z", tsEpochMs: 1.5, title: "research_query", provenance: { step_id: "step-source", duration_ms: 200 } },
      { id: "e2", laneId: "parent", type: "sessions_spawn_requested", ts: "2026-05-23T07:31:01Z", tsEpochMs: 2, title: "sessions_spawn", provenance: { step_id: "step-spawn", duration_ms: 1200, input_tokens: 10000, cache_read_tokens: 2000, output_tokens: 80 } },
      { id: "e3", laneId: "runtime", type: "sessions_spawn_accepted", ts: "2026-05-23T07:31:01Z", tsEpochMs: 3, title: "spawn accepted", subtitle: "source-refresh", provenance: { childSessionKey: "abc", child_run_id: "child-run" } },
      { id: "e4", laneId: "child:abc", type: "child_final", ts: "2026-05-23T07:35:00Z", tsEpochMs: 4, title: "child final", provenance: { step_id: "child-final", artifact_path: "/tmp/source.md" } },
      { id: "e5", laneId: "taskflow", type: "taskflow_gap", ts: "2026-05-23T07:35:01Z", tsEpochMs: 5, title: "child binding gap", status: "warning", provenance: { flow_id: "flow-1" } },
    ],
    edges: [
      { id: "edge-1", from: "e2", to: "e3", type: "spawn", label: "accepted" },
      { id: "edge-2", from: "e3", to: "e5", type: "taskflow", label: "gap" },
    ],
    diagnostics: [{ id: "d1", severity: "warning", type: "taskflow_childruns_empty", message: "Accepted child is missing from managed workflow child references", eventId: "e5" }],
    attention: {
      status: "stuck",
      title: "Parent yielded; waiting for child merge",
      subtitle: "child abc is idle / exec; no parent resume observed",
      eventId: "e4",
      stepId: "child-final",
      runId: "run-12345678",
      childSessionKey: "abc",
      childSessionId: "sid-child",
      ageMs: 120000,
    },
    validation: {
      status: "ok",
      checks: [
        { id: "lanes.resolve", status: "ok", message: "all event lanes resolve" },
        { id: "edges.resolve", status: "ok", message: "all edges resolve" },
      ],
    },
    runs: [{ runId: "run-12345678", startedAt: "2026-05-23T07:31:00Z", durationMs: 1000, modelSteps: 1, toolSteps: 2, status: "completed" }],
  };
}

function sampleTrace() {
  return { runId: "run-12345678", runs: [], traceDurationMs: 1, startedAt: "2026-05-23T07:31:00Z", spans: [] };
}

function sampleContext() {
  return {
    runId: "run-12345678",
    runs: [],
    breakdown: { runId: "run-12345678", totalLatest: 1, buckets: { frameworkBaseline: 1, assistantOutputsCumulative: 0, toolResultsCumulative: 0, mcpDeltasCumulative: 0, unaccountedCumulative: 0 } },
    timeline: {
      turns: [],
      phases: [],
      topSpikes: [],
      cumulative: { totalTurns: 0, totalOutputTokens: 0, totalThinkingChars: 0, totalToolResultChars: 0, totalToolCallArgsChars: 0, totalReplyTextChars: 0, peakInputTokens: 1, finalInputTokens: 1, totalInputCumulative: 1, totalCacheReadCumulative: 0, cacheHitRate: null },
      loopFlags: { suspectedLoopWindows: [], repeatedFileReads: [], consecutiveNoWriteTurns: 0, healthVerdict: "healthy" },
      insightBanner: null,
    },
  };
}

console.log("\n=== Group 1: renderWorkflowGraph ===");
{
  const { ctx } = loadAppJs();
  assert(typeof ctx.renderWorkflowGraph === "function", "renderWorkflowGraph exposed on vm global");
  const html = ctx.renderWorkflowGraph(sampleWorkflow());
  assert(html.includes("workflow-sequence"), "renders sequence diagram view");
  assert(html.includes("sequence-lane-area"), "renders a dedicated lane drawing area");
  assert(html.includes("left:10.0000%;width:20.0000%"), "user-to-parent arrow is center-to-center");
  assert(html.includes("left:calc(30.0000% - 58px);width:116px"), "self-call is centered on parent lane");
  assert(html.includes("User"), "renders user lane");
  assert(html.includes("OpenClaw Runtime"), "renders runtime lane");
  assert(html.includes("Workflow State"), "renders workflow state lane");
  assert(html.includes("accepted childSessionKey + runId"), "renders accepted return message");
  assert(html.includes("ctx 12K"), "renders context length metadata");
  assert(html.includes("1.2s"), "renders call duration metadata");
  assert(html.includes("workflow-validation wf-ok"), "renders workflow data validation status");
  assert(html.includes("workflow-attention wf-stuck"), "renders workflow attention summary");
  assert(html.includes("Parent yielded; waiting for child merge"), "renders stuck location title");
  assert(html.includes("wf-attention-hit"), "highlights the attention event");
  assert(html.includes("taskflow_childruns_empty"), "renders diagnostics");
  assert(html.includes("childSessionKey"), "detail provenance includes childSessionKey");
  assert(!/mermaid/i.test(html), "does not require Mermaid markup");
}

console.log("\n=== Group 2: refreshDetail order and preservation ===");
{
  const loaded = loadAppJs();
  loaded.setFetchResponse("/workflow", sampleWorkflow());
  loaded.setFetchResponse("/trace", sampleTrace());
  loaded.setFetchResponse("/context", sampleContext());
  await loaded.ctx.refreshDetail("parent");
  const html = loaded.detailHtml();
  const workflowIdx = html.indexOf("Workflow Graph");
  const traceIdx = html.indexOf("Workflow trace");
  const contextIdx = html.indexOf("Context length");
  assert(workflowIdx >= 0, "Workflow Graph section rendered");
  assert(traceIdx >= 0, "Workflow trace section preserved");
  assert(contextIdx >= 0, "Context length section preserved");
  assert(workflowIdx < traceIdx && traceIdx < contextIdx, "section order is graph, trace, context");
  assert(html.includes("detail-section-workflow"), "workflow section wrapper present");
  assert(html.includes("detail-section-trace"), "trace wrapper preserved");
  assert(html.includes("detail-section-context"), "context wrapper preserved");
}

console.log("\n=== Group 3: static dependency check ===");
{
  const source = readFileSync(join(REPO_ROOT, "src/frontend/app.js"), "utf-8");
  assert(source.includes("/workflow?"), "refreshDetail fetches workflow endpoint");
  assert(!/mermaid/i.test(source), "app.js has no Mermaid dependency");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
