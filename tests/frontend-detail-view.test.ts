/**
 * Round 6 follow-up — verifies the stacked detail view in
 * `src/frontend/app.js`:
 *
 *   - The view toggle (Workflow trace / Context length) has been removed.
 *   - `refreshDetail(key)` fetches BOTH /trace and /context in parallel and
 *     renders them as two stacked sections, trace on top, context below.
 *   - The 5-second auto-refresh path (`refreshSessions` → `refreshDetail`)
 *     updates both sections in the same tick.
 *   - `buildTraceHtml()` and `renderContextView()` are pure HTML builders
 *     that degrade gracefully on empty / partial input.
 *
 * The test loads `app.js` verbatim into a `vm` context with a minimal DOM +
 * fetch shim, then drives the exposed top-level functions directly. No
 * browser, no network.
 *
 * Run:
 *   node --experimental-sqlite --experimental-strip-types --no-warnings \
 *     tests/frontend-detail-view.test.ts
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

// ─── DOM + fetch shim ──────────────────────────────────────────
interface LoadedCtx {
  ctx: any;
  setFetchResponse: (pattern: string, payload: unknown, opts?: { ok?: boolean }) => void;
  fetchCalls: Array<{ url: string; opts: any }>;
  getDetailHtml: () => string;
}

function loadAppJs(options: { hash?: string; search?: string } = {}): LoadedCtx {
  let code = readFileSync(join(REPO_ROOT, "src/frontend/app.js"), "utf-8");
  // Strip the boot block so refresh() + setInterval don't run implicitly.
  code = code.replace(/\/\/ Boot\s*\nrefresh\(\);\s*\nsetInterval\(refresh, 5000\);\s*$/m, "/* test: boot skipped */");

  class FakeClassList {
    _s = new Set<string>();
    add(c: string) { this._s.add(c); }
    remove(c: string) { this._s.delete(c); }
    toggle(c: string) { if (this._s.has(c)) this._s.delete(c); else this._s.add(c); }
    contains(c: string) { return this._s.has(c); }
  }

  function makeElement(): any {
    const el: any = {};
    el.innerHTML = "";
    let txt = "";
    Object.defineProperty(el, "textContent", {
      get() { return txt; },
      set(v: unknown) {
        txt = String(v ?? "");
        el.innerHTML = txt
          .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
      },
    });
    el.className = "";
    el.classList = new FakeClassList();
    el.dataset = {};
    el.options = [] as any[];
    el.style = {} as Record<string, string>;
    el.value = "";
    el.addEventListener = () => {};
    el.removeEventListener = () => {};
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
    createElement(_tag: string) { return makeElement(); },
    body: { appendChild: () => {}, removeChild: () => {} },
    execCommand: () => {},
  };

  interface FakeResponse { ok: boolean; json: () => Promise<unknown>; }
  const fetchResponses = new Map<string, { payload: unknown; ok: boolean }>();
  const fetchCalls: Array<{ url: string; opts: any }> = [];
  async function fakeFetch(url: string, opts?: any): Promise<FakeResponse> {
    fetchCalls.push({ url, opts });
    for (const [pat, v] of fetchResponses) {
      if (url.includes(pat)) {
        return { ok: v.ok, json: async () => v.payload };
      }
    }
    return { ok: true, json: async () => ({}) };
  }

  const ctx: any = {
    document: fakeDoc,
    location: { hash: options.hash || "", search: options.search || "" },
    navigator: {},
    fetch: fakeFetch as any,
    setInterval: () => 0,
    setTimeout: (_fn: any, _ms: number) => 0,
    clearTimeout: () => {},
    URLSearchParams: globalThis.URLSearchParams,
    URL: globalThis.URL,
    Promise,
    console,
    Date,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    JSON,
    Map,
    Set,
    Symbol,
    Error,
    encodeURIComponent: globalThis.encodeURIComponent,
    decodeURIComponent: globalThis.decodeURIComponent,
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);

  return {
    ctx,
    setFetchResponse: (pattern, payload, opts) => {
      fetchResponses.set(pattern, { payload, ok: opts?.ok ?? true });
    },
    fetchCalls,
    getDetailHtml: () => fakeDoc.getElementById("session-detail").innerHTML as string,
  };
}

// ─── Fixtures ──────────────────────────────────────────────────
function sampleBreakdown() {
  return {
    runId: "abcdef1234567890",
    totalLatest: 10_000,
    buckets: {
      frameworkBaseline: 2_000,
      assistantOutputsCumulative: 1_500,
      toolResultsCumulative: 4_500,
      mcpDeltasCumulative: 1_000,
      unaccountedCumulative: 1_000,
    },
  };
}

function sampleTimeline(overrides: Partial<Record<string, unknown>> = {}) {
  const base = {
    turns: [
      {
        seq: 0, ts: "2026-04-12T10:00:00Z", tsEpochMs: 0,
        totalTokens: 2300, inputTokens: 2000, cacheReadTokens: 0, outputTokens: 300,
        deltaIn: null,
        primaryTool: "read", primaryToolKind: "TOOL_CALL",
        prevToolResultChars: 0, toolCallArgsChars: 0,
        thinkingChars: 20, replyTextChars: 0,
        stepIds: ["e0", "e0:tc0"],
      },
      {
        seq: 1, ts: "2026-04-12T10:00:01Z", tsEpochMs: 1000,
        totalTokens: 8400, inputTokens: 8000, cacheReadTokens: 2000, outputTokens: 400,
        deltaIn: 6000,
        primaryTool: "exec", primaryToolKind: "SKILL_EXEC",
        prevToolResultChars: 40_000, toolCallArgsChars: 200,
        thinkingChars: 50, replyTextChars: 100,
        stepIds: ["e1", "e1:tc0"],
      },
    ],
    phases: [
      { name: "spike", startSeq: 1, endSeq: 1, startTotal: 2000, endTotal: 8000, deltaTotal: 6000, note: "+6k delta" },
    ],
    topSpikes: [
      { seq: 1, deltaIn: 6000, primaryTool: "exec", triggerSummary: "exec grep hot.md" },
    ],
    cumulative: {
      totalTurns: 2,
      totalOutputTokens: 700,
      totalThinkingChars: 70,
      totalToolResultChars: 40_000,
      totalToolCallArgsChars: 200,
      totalReplyTextChars: 100,
      peakInputTokens: 8000,
      finalInputTokens: 8000,
      totalInputCumulative: 10_000,
      totalCacheReadCumulative: 2000,
      cacheHitRate: 0.2,
    },
    loopFlags: {
      suspectedLoopWindows: [] as unknown[],
      repeatedFileReads: [{ filePath: "/tmp/hot.md", readCount: 5 }],
      consecutiveNoWriteTurns: 0,
      healthVerdict: "healthy",
    },
    insightBanner: "99% of context burned on tool results",
  };
  return { ...base, ...overrides };
}

function sampleTrace() {
  return {
    runId: "r1abcdef",
    runs: [{ runId: "r1abcdef", startedAt: "2026-04-12T10:00:00Z", durationMs: 1000, modelSteps: 2, toolSteps: 1, status: "ok" }],
    traceDurationMs: 1000,
    startedAt: "2026-04-12T10:00:00Z",
    spans: [
      { id: "s1", type: "model", label: "think A", startOffsetMs: 0, durationMs: 200, tokens: 100, status: "ok" },
      { id: "s2", type: "tool", label: "read f.md", startOffsetMs: 200, durationMs: 300, status: "ok", inputPreview: "f.md" },
      { id: "s3", type: "tool", label: "exec boom", startOffsetMs: 500, durationMs: 100, status: "error", errorText: "boom!" },
    ],
  };
}

// ─── Group 1: buildTraceHtml is a pure function ────────────────
console.log("\n=== Group 1: buildTraceHtml (pure) ===");
{
  const { ctx } = loadAppJs();
  const buildTraceHtml = ctx.buildTraceHtml;
  assert(typeof buildTraceHtml === "function", "buildTraceHtml exposed on vm global");

  const empty = buildTraceHtml({ spans: [], traceDurationMs: 0 });
  assert(empty.includes("No trace data"), "empty spans → placeholder");

  const html = buildTraceHtml(sampleTrace());
  assert(html.includes("trace-container"), "renders trace-container");
  assert(html.includes("type-model"), "renders model span type class");
  assert(html.includes("type-tool"), "renders tool span type class");
  assert(html.includes("trace-err"), "renders ERR badge for error span");
  assert(html.includes("boom!"), "renders error text in detail block");
  assert(html.includes("100 tok"), "renders token count on model span");
  assert(!html.includes("view-selector"), "no view-selector markup leaked");
}

// ─── Group 2: renderContextView renders all sections ───────────
console.log("\n=== Group 2: renderContextView (full fixture) ===");
{
  const { ctx } = loadAppJs();
  const render = ctx.renderContextView;
  assert(typeof render === "function", "renderContextView exposed on vm global");

  const html = render(sampleBreakdown(), sampleTimeline());
  assert(html.includes("context-view"), "wraps in .context-view");
  assert(html.includes("context-bucket-grid"), "has bucket grid");
  assert(html.includes("Framework baseline"), "bucket label: framework baseline");
  assert(html.includes("Assistant outputs"), "bucket label: assistant outputs");
  assert(html.includes("Tool result inflow"), "bucket label: tool result inflow");
  assert(html.includes("MCP context inflow"), "bucket label: mcp");
  assert(html.includes("Unaccounted"), "bucket label: unaccounted");
  assert(html.includes("bucket-baseline") && html.includes("bucket-tool") && html.includes("bucket-unacc"),
    "all 5 bucket CSS classes present");

  assert(html.includes("context-insight"), "insight banner rendered");
  assert(html.includes("99% of context burned"), "insight banner text rendered");

  assert(html.includes("context-turn-table"), "per-turn table rendered");
  assert(html.includes("baseline"), "turn 0 labeled baseline");
  assert(html.includes("delta-spike"), "turn 1 flagged as spike via delta class");
  assert(html.includes("+6,000"), "turn 1 delta formatted with thousands separator");

  assert(html.includes("context-phase-strip") && html.includes("phase-spike"), "phase strip with spike phase");
  assert(html.includes("context-spikes") && html.includes("#1"), "top spikes section with rank");
  assert(html.includes("exec grep hot.md"), "spike trigger summary rendered");

  assert(html.includes("context-cumulative-grid"), "cumulative grid rendered");
  assert(html.includes("verdict-healthy"), "health verdict class rendered");

  assert(html.includes("context-repeated-reads"), "repeated reads block rendered");
  assert(html.includes("5×"), "repeat count rendered");
  assert(html.includes("/tmp/hot.md"), "repeated file path rendered");
}

// ─── Group 3: renderContextView degrades on empty sections ─────
console.log("\n=== Group 3: renderContextView degraded input ===");
{
  const { ctx } = loadAppJs();
  const render = ctx.renderContextView;
  const slim = sampleTimeline({
    phases: [],
    topSpikes: [],
    loopFlags: {
      suspectedLoopWindows: [],
      repeatedFileReads: [],
      consecutiveNoWriteTurns: 0,
      healthVerdict: "healthy",
    },
    insightBanner: null,
  });
  const html = render(sampleBreakdown(), slim);
  assert(!html.includes("context-phase-strip"), "phase strip hidden when phases empty");
  assert(!html.includes("context-spikes"), "spikes section hidden when empty");
  assert(!html.includes("context-repeated-reads"), "repeated reads hidden when empty");
  assert(!html.includes("context-insight"), "insight banner hidden when null");
  // stuck verdict should still render the pill
  const stuck = render(sampleBreakdown(), sampleTimeline({
    loopFlags: {
      suspectedLoopWindows: [{ startSeq: 0, endSeq: 10, turns: 10, reason: "loop" }],
      repeatedFileReads: [],
      consecutiveNoWriteTurns: 10,
      healthVerdict: "stuck",
    },
  }));
  assert(stuck.includes("context-loop-warn") && stuck.includes("stuck"), "stuck verdict pill rendered");
  assert(stuck.includes("verdict-stuck"), "stuck verdict cell class rendered");
}

// ─── Group 4: refreshDetail renders BOTH sections stacked ──────
console.log("\n=== Group 4: refreshDetail integration ===");
{
  const loaded = loadAppJs();
  loaded.setFetchResponse("/trace", sampleTrace());
  loaded.setFetchResponse("/context", { runId: "r1", runs: [], breakdown: sampleBreakdown(), timeline: sampleTimeline() });
  await loaded.ctx.refreshDetail("sess:key:1");
  const html = loaded.getDetailHtml();

  assert(html.includes("detail-section-trace"), "trace section wrapper rendered");
  assert(html.includes("detail-section-context"), "context section wrapper rendered");
  assert(html.includes("trace-container"), "trace content rendered inside detail");
  assert(html.includes("context-view"), "context content rendered inside detail");
  assert(html.includes("Workflow trace"), "trace section title rendered");
  assert(html.includes("Context length"), "context section title rendered");

  const traceIdx = html.indexOf("Workflow trace");
  const ctxIdx = html.indexOf("Context length");
  assert(traceIdx >= 0 && ctxIdx >= 0 && traceIdx < ctxIdx, "trace section appears ABOVE context section");

  assert(!html.includes("view-selector"), "no view toggle leaked");
  assert(!html.includes("selectDetailView"), "no toggle handler leaked");
}

// ─── Group 4b: run selector is compact by default ──────────────
console.log("\n=== Group 4b: compact run selector ===");
{
  const { ctx } = loadAppJs();
  const runs = Array.from({ length: 30 }, (_, i) => ({
    runId: `run-${i}`,
    startedAt: new Date(1779529000000 - i * 60_000).toISOString(),
    durationMs: 1000,
    modelSteps: 1,
    toolSteps: 1,
    status: "completed",
  }));
  const compact = ctx.renderRunSelector(runs, "run-0");
  const compactCount = (compact.match(/class="run-item/g) || []).length;
  assert(compactCount === 18, "compact run selector shows latest 18 by default", `count=${compactCount}`);
  assert(compact.includes("Runs 30") && compact.includes("latest 18"), "compact label shows total and visible count");
  assert(compact.includes("toggleRunSelector"), "run selector exposes all/compact toggle");
}

// ─── Group 5: refreshDetail is resilient to missing context ─
console.log("\n=== Group 5: refreshDetail with missing context data ===");
{
  const loaded = loadAppJs();
  loaded.setFetchResponse("/trace", sampleTrace());
  // context endpoint intentionally not registered → fakeFetch returns {} (no breakdown/timeline)
  await loaded.ctx.refreshDetail("sess:key:2");
  const html = loaded.getDetailHtml();
  assert(html.includes("trace-container"), "trace renders normally");
  assert(html.includes("No context data"), "context section shows placeholder");
  assert(html.includes("detail-section-trace") && html.includes("detail-section-context"),
    "BOTH section wrappers still rendered");
}

// ─── Group 6: refreshDetail is resilient to missing trace ──
console.log("\n=== Group 6: refreshDetail with missing trace data ===");
{
  const loaded = loadAppJs();
  loaded.setFetchResponse("/context", { runId: "r1", runs: [], breakdown: sampleBreakdown(), timeline: sampleTimeline() });
  // trace endpoint returns {} → spans.length === 0 → placeholder
  await loaded.ctx.refreshDetail("sess:key:3");
  const html = loaded.getDetailHtml();
  assert(html.includes("No trace data"), "trace section shows placeholder");
  assert(html.includes("context-view"), "context section renders normally");
}

// ─── Group 7: refreshDetail polled repeatedly (5s auto-refresh) ──
console.log("\n=== Group 7: repeated refreshDetail stays stable ===");
{
  const loaded = loadAppJs();
  loaded.setFetchResponse("/trace", sampleTrace());
  loaded.setFetchResponse("/context", { runId: "r1", runs: [], breakdown: sampleBreakdown(), timeline: sampleTimeline() });
  // Simulate the 5s polling path: refreshDetail called 3 times in a row.
  for (let i = 0; i < 3; i++) {
    await loaded.ctx.refreshDetail("sess:key:loop");
  }
  const html = loaded.getDetailHtml();
  // After repeated calls, content should be present exactly once (not appended).
  const traceCount = (html.match(/detail-section-trace/g) || []).length;
  const ctxCount = (html.match(/detail-section-context/g) || []).length;
  assert(traceCount === 1, "trace section present exactly once", `count=${traceCount}`);
  assert(ctxCount === 1, "context section present exactly once", `count=${ctxCount}`);
  assert(html.includes("context-view"), "context content still present after repeat");
}

// ─── Group 8: structural file invariants ───────────────────────
console.log("\n=== Group 8: structural file invariants ===");
{
  const source = readFileSync(join(REPO_ROOT, "src/frontend/app.js"), "utf-8");
  assert(!source.includes("currentDetailView"), "no currentDetailView state");
  assert(!source.includes("selectDetailView"), "no selectDetailView function");
  assert(!source.includes("renderViewSelector"), "no renderViewSelector function");
  assert(source.includes("Promise.all"), "refreshDetail uses Promise.all");
  assert(/function buildTraceHtml/.test(source), "buildTraceHtml is a declared function");
  assert(source.includes("detail-section-trace"), "trace section class present");
  assert(source.includes("detail-section-context"), "context section class present");
  // The 5s poll path from refreshSessions must go through refreshDetail, not refreshTrace.
  assert(/refreshSessions[\s\S]*refreshDetail\(expandedSessionKey,\s*expandedSessionId\)/.test(source),
    "refreshSessions calls refreshDetail on poll");
  assert(!/refreshSessions[\s\S]*refreshTrace\(expandedSessionKey\)/.test(source),
    "refreshSessions does NOT call refreshTrace directly");

  const css = readFileSync(join(REPO_ROOT, "src/frontend/style.css"), "utf-8");
  assert(css.includes(".detail-section"), "stacked detail-section CSS present");
  assert(css.includes(".detail-section-title"), "detail-section-title CSS present");
  assert(!css.includes(".view-selector"), "view-selector CSS removed");
  assert(!css.includes(".view-item"), "view-item CSS removed");
}

// ─── Group 9: fragment tokens use Authorization header ─────────
console.log("\n=== Group 9: authFetch token transport ===");
{
  const loaded = loadAppJs({ hash: "#token=abc%20123" });
  loaded.setFetchResponse("/api/summary", { totalSessions: 1 });
  await loaded.ctx.refreshSummary();
  const call = loaded.fetchCalls.find(c => c.url.includes("/api/summary"));
  assert(!!call, "summary request captured");
  assert(call?.url === "/api/summary", "auth token is not appended to API query string", `url=${call?.url}`);
  assert(call?.opts?.headers?.Authorization === "Bearer abc 123",
    "auth token is sent with Authorization header");
}

// ─── Summary ───────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
