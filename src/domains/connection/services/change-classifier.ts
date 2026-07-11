import type { ConnectionChange, InventoryEntry, Observation } from "../model/types.ts";

export type Classification = {
  changes: ConnectionChange[];
  missing_pending: Observation[];
};

export function classifyChanges(
  previous: Observation[],
  current: InventoryEntry[],
  now: string,
  deleteGraceMs: number,
): Classification {
  const before = new Map(previous.map((item) => [item.normalized_path_key, item]));
  const after = new Map(current.map((item) => [item.normalized_path_key, item]));
  const matchedPrevious = new Set<string>();
  const matchedCurrent = new Set<string>();
  const changes: ConnectionChange[] = [];

  for (const [key, entry] of after) {
    const old = before.get(key);
    if (!old) continue;
    matchedPrevious.add(key);
    matchedCurrent.add(key);
    if (old.state === "deleted") changes.push(change("restored", entry, old));
    else if (old.content_hash !== entry.content_hash) changes.push(change("modified", entry, old));
  }

  const unmatchedPrevious = previous.filter(
    (item) => !matchedPrevious.has(item.normalized_path_key) && item.state !== "deleted",
  );
  for (const entry of current.filter((item) => !matchedCurrent.has(item.normalized_path_key))) {
    const renamed = uniqueRename(entry, unmatchedPrevious, matchedPrevious);
    if (renamed) {
      matchedPrevious.add(renamed.normalized_path_key);
      changes.push({ ...change("renamed", entry, renamed), previous_path: renamed.relative_path });
    } else {
      changes.push(change("created", entry, null));
    }
  }

  const missingPending: Observation[] = [];
  for (const old of previous.filter((item) => !matchedPrevious.has(item.normalized_path_key))) {
    if (old.state === "deleted") continue;
    if (
      old.state === "missing_pending" &&
      old.missing_since &&
      Date.parse(now) - Date.parse(old.missing_since) >= deleteGraceMs
    ) {
      changes.push({
        kind: "deleted",
        relative_path: old.relative_path,
        previous_path: null,
        previous_hash: old.content_hash,
        current_hash: null,
        observation_id: old.observation_id,
        observation_version: old.version,
      });
    } else {
      missingPending.push(old);
    }
  }
  changes.sort((left, right) => left.relative_path.localeCompare(right.relative_path));
  return { changes, missing_pending: missingPending };
}

function uniqueRename(
  entry: InventoryEntry,
  candidates: Observation[],
  matched: Set<string>,
): Observation | null {
  const available = candidates.filter((item) => !matched.has(item.normalized_path_key));
  const identity = entry.file_identity
    ? available.filter((item) => item.file_identity === entry.file_identity)
    : [];
  if (identity.length === 1) return identity[0] ?? null;
  const hash = available.filter((item) => item.content_hash === entry.content_hash);
  return hash.length === 1 ? (hash[0] ?? null) : null;
}

function change(
  kind: ConnectionChange["kind"],
  entry: InventoryEntry,
  old: Observation | null,
): ConnectionChange {
  return {
    kind,
    relative_path: entry.relative_path,
    previous_path: null,
    previous_hash: old?.content_hash ?? null,
    current_hash: entry.content_hash,
    observation_id: old?.observation_id ?? null,
    observation_version: old?.version ?? 0,
  };
}
