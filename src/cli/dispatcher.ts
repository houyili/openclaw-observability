/**
 * Round 6 — CLI subcommand dispatcher (§5).
 *
 * Parses argv into (subcommand, args) and routes to one of the handlers
 * in `handlers.ts`. Returns `{ text, exitCode }` so the caller can
 * print + exit cleanly.
 *
 * Special case: the bare `/observ` (no subcommand) is handled UPSTREAM
 * by the `dashboard-tunnel` skill's existing `get_dashboard_url.sh`,
 * because that flow needs ngrok / cloudflared coordination plus token
 * assembly that lives outside obs.db. The dispatcher's job is to handle
 * everything BUT the no-arg case.
 */

import type { DatabaseSync } from "node:sqlite";
import { header } from "./format.ts";
import { HANDLERS, handleHelp } from "./handlers.ts";

export interface DispatchResult {
  text: string;
  exitCode: 0 | 1;
}

/**
 * Parse a free-form input like `/observ status`, `/observ skills week`,
 * `status`, or `skills week` into (subcommand, args).
 *
 * Strips a leading `/observ` token (or `observ`) so callers don't have to.
 */
export function parseCommand(argv: string[]): { subcommand: string; args: string[] } {
  const tokens = argv.slice();
  // Drop a leading /observ or observ if present.
  if (tokens.length > 0 && (tokens[0] === "/observ" || tokens[0] === "observ")) {
    tokens.shift();
  }
  const subcommand = (tokens.shift() || "help").toLowerCase();
  return { subcommand, args: tokens };
}

/**
 * Dispatch a parsed command against a DB handle. Returns text + exit code.
 *
 * Unknown subcommand → returns help text + exit 1 so the channel knows
 * something was wrong (most channels surface non-zero exits as errors).
 */
export function dispatch(db: DatabaseSync, argv: string[]): DispatchResult {
  const { subcommand, args } = parseCommand(argv);

  const handler = HANDLERS[subcommand];
  if (!handler) {
    const helpText = handleHelp(db, []);
    return {
      text: `${header(`unknown command: /observ ${subcommand}`)}\n${helpText}`,
      exitCode: 1,
    };
  }

  try {
    return { text: handler(db, args), exitCode: 0 };
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    return {
      text: `${header(`/observ ${subcommand} failed`)}\n${msg}`,
      exitCode: 1,
    };
  }
}
