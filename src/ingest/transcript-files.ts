import { basename } from "node:path";

/**
 * Canonical session transcripts are the only JSONL files obs-v2 should ingest.
 * ACP stream, checkpoint, and trajectory sidecars reuse JSONL but do not have
 * the same event contract, so accepting them corrupts replay/count integrity.
 */
export function isCanonicalTranscriptFile(filePathOrName: string): boolean {
  const name = basename(filePathOrName);
  if (!name.endsWith(".jsonl")) return false;
  if (name.includes(".acp-stream")) return false;
  if (name.includes(".checkpoint.")) return false;
  if (name.endsWith(".trajectory.jsonl")) return false;
  return true;
}
