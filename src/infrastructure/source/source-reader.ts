import type { SourceRow } from "../../domains/source/index.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { openWorkspaceDatabase } from "../db/workspace-database.ts";
import { mapSourceRow, type RawSourceRow } from "./source-row.ts";

export type SnapshotEntryRow = {
  snapshot_id: string;
  logical_path: string;
  blob_sha256: string;
  mime_type: string;
  size_bytes: number;
  origin_uri: string | null;
  acquired_at: string;
  blob_relative_path: string;
};

export async function getSource(root: string, sourceId: string): Promise<SourceRow> {
  const opened = await readable(root);
  try {
    const row = opened.database
      .query<RawSourceRow, [string]>("SELECT * FROM sources WHERE source_id = ?")
      .get(sourceId);
    if (!row) throw failure("source_not_found", `Unknown Source: ${sourceId}`, "not_found");
    return mapSourceRow(row);
  } finally {
    opened.database.close();
  }
}

export async function findSourceByIdentity(
  root: string,
  identityKey: string,
): Promise<SourceRow | null> {
  const opened = await readable(root);
  try {
    const row = opened.database
      .query<RawSourceRow, [string]>("SELECT * FROM sources WHERE identity_key = ?")
      .get(identityKey);
    return row ? mapSourceRow(row) : null;
  } finally {
    opened.database.close();
  }
}

export async function listSources(root: string, state?: string): Promise<SourceRow[]> {
  const opened = await readable(root);
  try {
    const rows = state
      ? opened.database
          .query<RawSourceRow, [string]>(
            "SELECT * FROM sources WHERE state = ? ORDER BY created_at, source_id",
          )
          .all(state)
      : opened.database
          .query<RawSourceRow, []>("SELECT * FROM sources ORDER BY created_at, source_id")
          .all();
    return rows.map(mapSourceRow);
  } finally {
    opened.database.close();
  }
}

export async function getSnapshotEntries(
  root: string,
  sourceId: string,
  snapshotId?: string,
): Promise<SnapshotEntryRow[]> {
  const source = await getSource(root, sourceId);
  const selected = snapshotId ?? source.current_snapshot_id;
  if (!selected) return [];
  const opened = await readable(root);
  try {
    const owned = opened.database
      .query<{ count: number }, [string, string]>(
        "SELECT COUNT(*) count FROM source_snapshots WHERE snapshot_id = ? AND source_id = ?",
      )
      .get(selected, sourceId);
    if (!owned?.count)
      throw failure("snapshot_not_found", `Unknown Snapshot: ${selected}`, "not_found");
    return opened.database
      .query<SnapshotEntryRow, [string]>(
        `SELECT e.*, b.relative_path blob_relative_path
         FROM source_snapshot_entries e JOIN source_blobs b ON b.sha256 = e.blob_sha256
         WHERE e.snapshot_id = ? ORDER BY e.logical_path`,
      )
      .all(selected);
  } finally {
    opened.database.close();
  }
}

export async function getSourceSnapshotSummary(root: string, sourceId: string) {
  const source = await getSource(root, sourceId);
  if (!source.current_snapshot_id) return null;
  const opened = await readable(root);
  try {
    return opened.database
      .query<
        {
          snapshot_id: string;
          sequence: number;
          entry_count: number;
          total_bytes: number;
          created_at: string;
        },
        [string]
      >(
        "SELECT snapshot_id, sequence, entry_count, total_bytes, created_at FROM source_snapshots WHERE snapshot_id = ?",
      )
      .get(source.current_snapshot_id);
  } finally {
    opened.database.close();
  }
}

export async function getSourceBatchReceipt(root: string, changeBatchId: string) {
  const opened = await readable(root);
  try {
    return opened.database
      .query<{ source_id: string; snapshot_id: string; accepted_at: string }, [string]>(
        "SELECT source_id, snapshot_id, accepted_at FROM source_batch_receipts WHERE change_batch_id = ?",
      )
      .get(changeBatchId);
  } finally {
    opened.database.close();
  }
}

async function readable(root: string) {
  const opened = await openWorkspaceDatabase(root, "read_only");
  if (!opened.compatible) {
    opened.database.close();
    throw failure(
      "workspace_migration_required",
      "Workspace must be migrated before Source reads",
      "state",
    );
  }
  return opened;
}
