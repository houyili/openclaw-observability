/**
 * Regression / unit tests for observability-v2.
 * Run: node --experimental-sqlite --experimental-strip-types --no-warnings tests/run-tests.ts
 */

import { classifyTool } from "../src/ingest/tool-classifier.ts";
import { classifyError, checkToolResultError } from "../src/ingest/error-classifier.ts";
import { parseTranscript, type TranscriptEntry } from "../src/ingest/transcript-parser.ts";

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`); }
}

// ─── Tool Classifier Tests ──────────────────────────────────────
console.log("\n=== Tool Classifier ===");

assert(classifyTool("read").nodeType === "TOOL_CALL", "read → TOOL_CALL");
assert(classifyTool("write").nodeType === "TOOL_CALL", "write → TOOL_CALL");
assert(classifyTool("edit").nodeType === "TOOL_CALL", "edit → TOOL_CALL");
assert(classifyTool("sessions_spawn").nodeType === "SUBAGENT_SPAWN", "sessions_spawn → SUBAGENT_SPAWN");
assert(classifyTool("web_search").nodeType === "EXTERNAL_CALL", "web_search → EXTERNAL_CALL");
assert(classifyTool("web_fetch").nodeType === "EXTERNAL_CALL", "web_fetch → EXTERNAL_CALL");
assert(classifyTool("process").nodeType === "INTERNAL_OP", "process → INTERNAL_OP");
assert(classifyTool("cron").nodeType === "INTERNAL_OP", "cron → INTERNAL_OP");

// MCP detection
assert(classifyTool("feishu_search_doc_wiki").nodeType === "MCP_CALL", "feishu tool → MCP_CALL");
assert(classifyTool("feishu_search_doc_wiki").mcpServer === "feishu", "feishu tool → server=feishu");
assert(classifyTool("api-post-search").nodeType === "MCP_CALL", "api-* → MCP_CALL");
assert(classifyTool("api-post-search").mcpServer === "notion", "api-* → server=notion");
assert(classifyTool("gateway").nodeType === "MCP_CALL", "gateway → MCP_CALL");
assert(classifyTool("browser").nodeType === "MCP_CALL", "unknown tool → MCP_CALL");

// exec → skill
const skillExec = classifyTool("exec", { command: "python3 /Users/x/.openclaw/skills/arxiv-source-pipeline/scripts/arxiv_search.py query" });
assert(skillExec.nodeType === "SKILL_EXEC", "exec with skill path → SKILL_EXEC");
assert(skillExec.skillName === "arxiv-source-pipeline", "skill name extracted");
assert(skillExec.scriptName === "arxiv_search.py", "script name extracted");

// exec → mcporter
const mcpExec = classifyTool("exec", { command: "mcporter call reddit.search_reddit query='test'" });
assert(mcpExec.nodeType === "MCP_CALL", "mcporter call → MCP_CALL");
assert(mcpExec.mcpServer === "reddit", "mcporter server extracted");
assert(mcpExec.mcpTool === "search_reddit", "mcporter tool extracted");

// exec → shell
assert(classifyTool("exec", { command: "git status" }).nodeType === "SHELL_EXEC", "git → SHELL_EXEC");

// ─── Error Classifier Tests ────────────────────────────────────
console.log("\n=== Error Classifier ===");

assert(classifyError("need_user_authorization") === "auth_error", "auth error");
assert(classifyError("Request timed out ETIMEDOUT") === "timeout", "timeout error");
assert(classifyError("zsh: command not found: rg") === "not_found", "not found");
assert(classifyError("HTTP 429 Too Many Requests rate limit") === "rate_limit", "rate limit");
assert(classifyError("HTTP 500 Internal Server Error") === "http_5xx", "5xx error");
assert(classifyError("HTTP 404 Not Found") === "http_4xx", "4xx error");
assert(classifyError("something went wrong") === "unknown", "unknown error");

// checkToolResultError
const errResult = checkToolResultError([{ type: "text", text: '{"error": "need_user_authorization"}' }]);
assert(errResult.isError === true, "MCP JSON error detected");
assert(errResult.errorText?.includes("need_user_authorization") === true, "error text extracted");

const okResult = checkToolResultError([{ type: "text", text: "some normal output" }]);
assert(okResult.isError === false, "normal output is not error");

// ─── Transcript Parser Tests ───────────────────────────────────
console.log("\n=== Transcript Parser ===");

const entries: TranscriptEntry[] = [
  { type: "session", id: "s1", parentId: "", timestamp: "2026-01-01T00:00:00Z" },
  { type: "message", id: "u1", parentId: "s1", timestamp: "2026-01-01T00:00:01Z",
    message: { role: "user", content: [{ type: "text", text: "hello" }] } },
  { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:10Z",
    message: { role: "assistant", content: [
      { type: "thinking" },
      { type: "toolCall", name: "read", id: "tc1", arguments: { file_path: "/tmp/test.txt" } },
    ], usage: { input: 100, output: 50, totalTokens: 150 } } },
  { type: "message", id: "r1", parentId: "a1", timestamp: "2026-01-01T00:00:12Z",
    message: { role: "toolResult", content: [{ type: "text", text: "file contents here" }] } },
  { type: "message", id: "a2", parentId: "r1", timestamp: "2026-01-01T00:00:20Z",
    message: { role: "assistant", content: [
      { type: "thinking" },
      { type: "text", text: "Here is your answer" },
    ], usage: { input: 200, output: 100, totalTokens: 300 } } },
];

const runs = parseTranscript(entries, "test-session");
assert(runs.length === 1, "one run parsed");
assert(runs[0].runId === "u1", "run starts at user message");
assert(runs[0].steps.length >= 3, "at least 3 steps (model+tool+reply)");

const modelStep = runs[0].steps.find(s => s.nodeType === "MODEL_THINK");
assert(modelStep != null, "MODEL_THINK step exists");
assert((modelStep?.durationMs ?? 0) > 0, "MODEL_THINK has duration > 0");

const toolStep = runs[0].steps.find(s => s.nodeType === "TOOL_CALL" && s.toolName === "read");
assert(toolStep != null, "TOOL_CALL read step exists");
assert(toolStep?.inputPreview?.includes("/tmp/test.txt") === true, "input preview contains path");
assert(toolStep?.status === "ok", "tool status is ok after result");

const replyStep = runs[0].steps.find(s => s.nodeType === "REPLY");
assert(replyStep != null, "REPLY step exists");
assert(replyStep?.resultPreview?.includes("Here is your answer") === true, "reply preview");

// Test cumulative token tracking
assert(runs[0].totalTokens === 300, "total tokens = last assistant's totalTokens");

// ─── Summary ───────────────────────────────────────────────────
console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
