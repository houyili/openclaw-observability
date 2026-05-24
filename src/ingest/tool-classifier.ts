import { CONFIG } from "../config.ts";

export type StepNodeType =
  | "MODEL_THINK"
  | "TOOL_CALL"
  | "MCP_CALL"
  | "SKILL_EXEC"
  | "SHELL_EXEC"
  | "SUBAGENT_SPAWN"
  | "EXTERNAL_CALL"
  | "INTERNAL_OP"
  | "REPLY";

export interface Classification {
  nodeType: StepNodeType;
  skillName?: string;
  scriptName?: string;
  mcpServer?: string;
  mcpTool?: string;
}

const SKILL_PATH_RE = /\/skills\/([^/]+)\/scripts\/([^/\s]+)/;
const SKILL_DIR_RE = /\/skills\/([^/\s]+)\//;
const MCPORTER_RE = /\bmcporter\s+call\s+(\S+)/i;

export function classifyTool(toolName: string, input?: Record<string, unknown>): Classification {
  if (toolName === "sessions_spawn" || toolName === "sessions_send") {
    return { nodeType: "SUBAGENT_SPAWN" };
  }
  if (toolName === "web_search" || toolName === "web_fetch") {
    return { nodeType: "EXTERNAL_CALL" };
  }
  if (toolName === "process" || toolName === "cron") {
    return { nodeType: "INTERNAL_OP" };
  }
  if (toolName === "exec") {
    return classifyExec(String(input?.command || ""));
  }
  if (CONFIG.BUILTIN_TOOLS.has(toolName)) {
    return { nodeType: "TOOL_CALL" };
  }
  // Not a built-in tool → must be MCP
  return { nodeType: "MCP_CALL", mcpServer: inferMcpServer(toolName), mcpTool: toolName };
}

function classifyExec(command: string): Classification {
  const mcpMatch = command.match(MCPORTER_RE);
  if (mcpMatch) {
    const target = mcpMatch[1];
    const dot = target.lastIndexOf(".");
    if (dot > 0) {
      return { nodeType: "MCP_CALL", mcpServer: target.slice(0, dot), mcpTool: target.slice(dot + 1) };
    }
    return { nodeType: "MCP_CALL", mcpServer: target };
  }

  const skillScript = command.match(SKILL_PATH_RE);
  if (skillScript) {
    return { nodeType: "SKILL_EXEC", skillName: skillScript[1], scriptName: skillScript[2] };
  }

  const skillDir = command.match(SKILL_DIR_RE);
  if (skillDir) {
    return { nodeType: "SKILL_EXEC", skillName: skillDir[1] };
  }

  return { nodeType: "SHELL_EXEC" };
}

function inferMcpServer(toolName: string): string {
  const prefix = toolName.match(/^([a-z][a-z0-9-]*)_/i)?.[1];
  if (prefix) return prefix;
  if (toolName.startsWith("api-")) return "notion";
  if (toolName === "gateway") return "gateway";
  return "unknown";
}
