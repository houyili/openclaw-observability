/**
 * Round 6 — text-formatting helpers shared by every CLI subcommand.
 *
 * Output rules (from the design doc §B.4):
 *   - Plain ASCII only — no Unicode box-drawing chars (Telegram strips them).
 *   - Bold via *asterisks* (Feishu / Telegram MarkdownV2 / WeChat all render).
 *   - No emojis (per global instructions).
 *   - Lines ≤ 80 chars.
 *   - Truncate session_keys to 28 chars with "…" ellipsis.
 */

export function header(text: string): string {
  return `*${text}*`;
}

/** Truncate a session key to a max width with an ellipsis. */
export function truncateKey(k: string, max = 28): string {
  if (!k) return "";
  if (k.length <= max) return k;
  return k.slice(0, max - 1) + "\u2026";
}

/** Format a token count: 1234 → "1.2k", 12_345_678 → "12.3M". */
export function fmtTok(n: number | null | undefined): string {
  if (n == null) return "—";
  if (Math.abs(n) < 1000) return String(n);
  if (Math.abs(n) < 1_000_000) return (n / 1000).toFixed(1) + "k";
  return (n / 1_000_000).toFixed(1) + "M";
}

/** Format a duration in milliseconds: 12 → "12ms", 1340 → "1.3s", 9_000_000 → "2.5h". */
export function fmtDur(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/** Format an age in milliseconds as e.g. "12s", "4m", "2.5h", "3d". */
export function fmtAge(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

/**
 * Render a left-aligned key/value list.
 *   keyVal([
 *     ["service", "up · pid 12345"],
 *     ["db",      "1234 steps · 56 sessions"],
 *   ]) →
 *     service     : up · pid 12345
 *     db          : 1234 steps · 56 sessions
 */
export function keyVal(rows: Array<[string, string]>): string {
  if (rows.length === 0) return "";
  const keyWidth = Math.max(...rows.map((r) => r[0].length));
  return rows
    .map(([k, v]) => `${k.padEnd(keyWidth)} : ${v}`)
    .join("\n");
}

/**
 * Render a small ASCII table with right-aligned numeric columns.
 *   table(
 *     ["#", "name", "calls"],
 *     [
 *       ["1", "skill_a", "42"],
 *       ["2", "skill_b", "9"],
 *     ],
 *   )
 */
export function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "(no rows)";
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] || "").length)),
  );
  const fmt = (cells: string[]) =>
    cells.map((c, i) => (c || "").padEnd(widths[i])).join("  ");
  return [fmt(headers), ...rows.map(fmt)].join("\n");
}
