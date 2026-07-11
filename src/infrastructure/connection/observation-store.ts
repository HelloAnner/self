import type { Database } from "bun:sqlite";
import type {
  ConnectionChange,
  ConnectionRow,
  ConnectionTarget,
  InventoryEntry,
  Observation,
} from "../../domains/connection/index.ts";
import { createResourceId } from "../../shared/ids/id.ts";

export type ScanObservationInput = {
  connection: ConnectionRow;
  target: ConnectionTarget;
  scanId: string;
  inventory: InventoryEntry[];
  previous: Observation[];
  missingPending: Observation[];
  changes: ConnectionChange[];
  snapshotId: string | null;
};

export function writeObservations(
  database: Database,
  input: ScanObservationInput,
  now: string,
): void {
  const existingByKey = new Map(input.previous.map((item) => [item.normalized_path_key, item]));
  const renameByPath = new Map(
    input.changes
      .filter((item) => item.kind === "renamed" && item.observation_id)
      .map((item) => [item.relative_path, item]),
  );
  for (const entry of input.inventory) {
    const renamed = renameByPath.get(entry.relative_path);
    const existing = existingByKey.get(entry.normalized_path_key);
    const id =
      renamed?.observation_id ?? existing?.observation_id ?? createResourceId("observation");
    database
      .prepare(
        `INSERT INTO connection_observations(observation_id, connection_id, target_id, relative_path,
         normalized_path_key, file_identity, entry_kind, size_bytes, mtime_ns, quick_fingerprint,
         content_hash, snapshot_id, seen_in_scan_id, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'file', ?, ?, ?, ?, ?, ?, 'active', ?, ?)
         ON CONFLICT(observation_id) DO UPDATE SET relative_path = excluded.relative_path,
         normalized_path_key = excluded.normalized_path_key, file_identity = excluded.file_identity,
         size_bytes = excluded.size_bytes, mtime_ns = excluded.mtime_ns,
         quick_fingerprint = excluded.quick_fingerprint, content_hash = excluded.content_hash,
         snapshot_id = excluded.snapshot_id, seen_in_scan_id = excluded.seen_in_scan_id,
         state = 'active', missing_since = NULL, updated_at = excluded.updated_at, version = version + 1`,
      )
      .run(
        id,
        input.connection.connection_id,
        input.target.target_id,
        entry.relative_path,
        entry.normalized_path_key,
        entry.file_identity,
        entry.size_bytes,
        entry.mtime_ns,
        entry.quick_fingerprint,
        entry.content_hash,
        input.snapshotId ?? existing?.snapshot_id ?? null,
        input.scanId,
        now,
        now,
      );
  }
  for (const item of input.missingPending) {
    database
      .prepare(
        `UPDATE connection_observations SET state = 'missing_pending', missing_since = COALESCE(missing_since, ?),
         seen_in_scan_id = ?, updated_at = ?, version = version + 1 WHERE observation_id = ?`,
      )
      .run(now, input.scanId, now, item.observation_id);
  }
  for (const item of input.changes.filter((change) => change.kind === "deleted")) {
    database
      .prepare(
        `UPDATE connection_observations SET state = 'deleted', snapshot_id = COALESCE(?, snapshot_id),
         seen_in_scan_id = ?, updated_at = ?, version = version + 1 WHERE observation_id = ?`,
      )
      .run(input.snapshotId, input.scanId, now, item.observation_id);
  }
}

export function countConnectionChanges(
  changes: ConnectionChange[],
): Record<ConnectionChange["kind"], number> {
  const output = { created: 0, modified: 0, deleted: 0, renamed: 0, restored: 0 };
  for (const item of changes) output[item.kind] += 1;
  return output;
}
