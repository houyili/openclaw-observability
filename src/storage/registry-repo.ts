import type { RegistryEntry } from "../ingest/registry-scanner.ts";
import { getDb } from "./db.ts";

export function upsertRegistryEntries(entries: RegistryEntry[]): void {
  const db = getDb();
  const now = new Date().toISOString();

  // Mark disk-scanned entries as 'removed' first (transcript-observed entries keep their status)
  db.prepare("UPDATE registry SET status = 'removed' WHERE status = 'active'").run();
  // Note: entries with status='observed' (from transcript lazy load) are NOT touched here

  const stmt = db.prepare(`
    INSERT INTO registry (type, name, path, discovered_at, last_seen_at, status)
    VALUES (?, ?, ?, ?, ?, 'active')
    ON CONFLICT(type, name) DO UPDATE SET
      path = COALESCE(excluded.path, registry.path),
      last_seen_at = excluded.last_seen_at,
      status = 'active'
  `);
  for (const e of entries) {
    stmt.run(e.type, e.name, e.path, e.discoveredAt, now);
  }
}

export function touchRegistryEntry(type: string, name: string, path?: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db.prepare("SELECT status, path FROM registry WHERE type = ? AND name = ?").get(type, name) as any;
  if (existing) {
    // Update last_seen_at, and fill in path if it was null
    if (path && !existing.path) {
      db.prepare("UPDATE registry SET last_seen_at = ?, path = ? WHERE type = ? AND name = ?").run(
        now,
        path,
        type,
        name,
      );
    } else {
      db.prepare("UPDATE registry SET last_seen_at = ? WHERE type = ? AND name = ?").run(now, type, name);
    }
  } else {
    // Discovered from transcript (not from disk scan) → status = 'observed'
    db.prepare(
      "INSERT INTO registry (type, name, path, discovered_at, last_seen_at, status) VALUES (?, ?, ?, ?, ?, 'observed')",
    ).run(type, name, path || null, now, now);
  }
}

export function getAllRegistry() {
  return getDb().prepare("SELECT * FROM registry ORDER BY type, name").all();
}
