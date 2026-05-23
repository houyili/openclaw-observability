/**
 * Redaction helpers for live test output.
 *
 * Live integrity / live-e2e / cross-check / replay-verify all run
 * against a real local obs.db and a real OpenClaw install. When they
 * print diagnostic messages, the raw `session_key` and `session_id`
 * leak the operator's actual chat ids (`feishu:direct:ou_...`,
 * `cron:UUID`, group ids, user ids). That is not appropriate for
 * any log we might paste into a public bug report or issue tracker.
 *
 * `redactKey` keeps the structural prefix (`agent:<agent>:<transport>:<kind>:`)
 * so the operator can still tell what KIND of session it is, then
 * replaces the trailing identifier with `<hash8>...<suffix4>`. The
 * suffix-4 is kept so two messages about the same key correlate
 * within a run.
 *
 * `redactId` is the same idea for raw runtime session_id / run_id /
 * step_id values: keep the last 4 chars, replace the rest with
 * `<hash8>...`.
 *
 * Both functions are pure and synchronous. They use `node:crypto`
 * SHA-1 truncated to 8 hex chars; the hash is stable per input so
 * two redacted lines about the same key match each other.
 */

import { createHash } from "node:crypto";

function hash8(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 8);
}

/**
 * Redact a structured OpenClaw session_key. Recognised shapes:
 *
 *   agent:<agent>:<transport>:<kind>:<id>            (5+ parts)
 *     -> agent:<agent>:<transport>:<kind>:<hash8>...<suffix4>
 *
 *   agent:<agent>:cron:<UUID>                        (4 parts)
 *     -> agent:<agent>:cron:<hash8>...<suffix4>
 *
 *   agent:<agent>:<inline-cron-name>                 (3 parts)
 *     -> kept verbatim (cron task name is part of the public
 *        OpenClaw dashboard already and is not an identifier)
 *
 *   anything else                                    (<3 parts)
 *     -> <hash8>...<suffix4>
 */
export function redactKey(key: string | null | undefined): string {
  if (!key) return "(none)";
  const parts = key.split(":");
  if (parts.length >= 4) {
    // Drop the last segment (the identifying id) and hash it; keep
    // the structural prefix verbatim. For 5+ part keys this lands on
    // <kind>, for 4-part cron keys it lands on <UUID>.
    const prefix = parts.slice(0, parts.length - 1).join(":");
    const tail = parts[parts.length - 1] || "";
    const suffix4 = tail.length >= 4 ? tail.slice(-4) : tail;
    return `${prefix}:<${hash8(tail)}>...${suffix4}`;
  }
  if (parts.length === 3) {
    // Inline cron name like `agent:main:hourly-cron-progress-reporter`
    return key;
  }
  return `<${hash8(key)}>...${key.slice(-4)}`;
}

/**
 * Redact a free-form identifier (session_id UUID, run_id, step_id).
 * Keeps the last 4 chars for correlation.
 */
export function redactId(id: string | null | undefined): string {
  if (!id) return "(none)";
  const suffix4 = id.length >= 4 ? id.slice(-4) : id;
  return `<${hash8(id)}>...${suffix4}`;
}
