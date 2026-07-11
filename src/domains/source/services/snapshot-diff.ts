import type { SnapshotChange } from "../model/types.ts";

export type EvidenceEntryIdentity = { logical_path: string; blob_sha256: string };

export function compareSnapshotEntries(
  previous: EvidenceEntryIdentity[],
  current: EvidenceEntryIdentity[],
): SnapshotChange[] {
  const before = new Map(previous.map((entry) => [entry.logical_path, entry.blob_sha256]));
  const after = new Map(current.map((entry) => [entry.logical_path, entry.blob_sha256]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes: SnapshotChange[] = [];
  for (const path of paths) {
    const oldHash = before.get(path) ?? null;
    const newHash = after.get(path) ?? null;
    if (oldHash === newHash) continue;
    changes.push({
      logical_path: path,
      change_kind: oldHash === null ? "added" : newHash === null ? "deleted" : "modified",
      previous_blob_sha256: oldHash,
      blob_sha256: newHash,
    });
  }
  return changes;
}
