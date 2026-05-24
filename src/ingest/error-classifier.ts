export function classifyError(errorText: string): string {
  const lower = errorText.toLowerCase();
  if (lower.includes("unauthorized") || lower.includes("need_user_authorization")) return "auth_error";
  if (lower.includes("timeout") || lower.includes("etimedout")) return "timeout";
  if (lower.includes("command not found") || lower.includes("enoent")) return "not_found";
  if (lower.includes("rate limit") || lower.includes("429")) return "rate_limit";
  if (/http[_ ]?5\d\d|status[: ]+5\d\d/.test(lower)) return "http_5xx";
  if (/http[_ ]?4\d\d|status[: ]+4\d\d/.test(lower)) return "http_4xx";
  return "unknown";
}

export interface ErrorCheckResult {
  isError: boolean;
  errorText?: string;
}

export function checkToolResultError(contentBlocks: any[]): ErrorCheckResult {
  if (!Array.isArray(contentBlocks)) return { isError: false };

  for (const block of contentBlocks) {
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    const text = block.text;

    // MCP JSON error: {"error": "..."}
    if (text.trimStart().startsWith("{")) {
      try {
        const parsed = JSON.parse(text);
        if (parsed.error) {
          return { isError: true, errorText: String(parsed.error).slice(0, 200) };
        }
      } catch {
        /* not JSON */
      }
    }

    // Explicit error markers
    if (text.startsWith("Error:") || text.includes("Command not found")) {
      return { isError: true, errorText: text.slice(0, 200) };
    }
  }
  return { isError: false };
}
