#!/usr/bin/env node

/**
 * Round 6 — observ_cli entry point.
 *
 * Thin shim around `src/cli/dispatcher.ts`. Opens obs.db read-only,
 * dispatches the subcommand, prints, exits.
 *
 * Run directly:
 *   node --experimental-sqlite --experimental-strip-types --no-warnings \
 *     scripts/observ_cli.ts status
 *
 * Run through the dashboard-tunnel skill (the channel-side path):
 *   bash workspace/skills/dashboard-tunnel/scripts/get_dashboard_url.sh /observ status
 */

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dispatch } from "../src/cli/dispatcher.ts";
import { CONFIG } from "../src/config.ts";

function main(): void {
  if (!existsSync(CONFIG.DB_PATH)) {
    process.stderr.write(`obs.db not found at ${CONFIG.DB_PATH}\n`);
    process.exit(1);
  }

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(CONFIG.DB_PATH, { readOnly: true });
  } catch (err) {
    process.stderr.write(`failed to open obs.db: ${(err as Error).message}\n`);
    process.exit(1);
  }

  try {
    const result = dispatch(db, process.argv.slice(2));
    process.stdout.write(`${result.text}\n`);
    process.exit(result.exitCode);
  } finally {
    db.close();
  }
}

main();
