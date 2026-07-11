import type { Database } from "bun:sqlite";
import type {
  ArchivedEntry,
  SnapshotChange,
  SourceRow,
  SourceSpec,
} from "../../domains/source/index.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { openWorkspaceDatabase } from "../db/workspace-database.ts";
import { mapSourceRow, type RawSourceRow } from "./source-row.ts";

export async function registerSource(
  root: string,
  input: {
    sourceId: string;
    identityKey: string;
    kind: string;
    mode: string;
    name: string;
    spec: SourceSpec;
    now: string;
  },
): Promise<{ source: SourceRow; created: boolean }> {
  const opened = await writable(root);
  try {
    return opened.transaction(() => {
      const existing = opened
        .query<RawSourceRow, [string]>("SELECT * FROM sources WHERE identity_key = ?")
        .get(input.identityKey);
      if (existing) return { source: mapSourceRow(existing), created: false };
      opened
        .prepare(
          `INSERT INTO sources(source_id, identity_key, kind, mode, name, state, archive_status, spec_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'active', 'registered', ?, ?, ?)`,
        )
        .run(
          input.sourceId,
          input.identityKey,
          input.kind,
          input.mode,
          input.name,
          JSON.stringify(input.spec),
          input.now,
          input.now,
        );
      const row = opened
        .query<RawSourceRow, [string]>("SELECT * FROM sources WHERE source_id = ?")
        .get(input.sourceId);
      if (!row) throw new Error("Registered Source was not readable");
      return { source: mapSourceRow(row), created: true };
    })();
  } finally {
    opened.close();
  }
}

export async function updateSourceSpec(
  root: string,
  sourceId: string,
  spec: SourceSpec,
): Promise<void> {
  const database = await writable(root);
  try {
    database
      .prepare(
        "UPDATE sources SET spec_json = ?, updated_at = ?, version = version + 1 WHERE source_id = ?",
      )
      .run(JSON.stringify(spec), new Date().toISOString(), sourceId);
  } finally {
    database.close();
  }
}

export async function markSourceArchiving(root: string, sourceId: string): Promise<void> {
  await updateState(root, sourceId, "active", "archiving", null, null);
}

export async function markSourceFailed(
  root: string,
  sourceId: string,
  code: string,
  message: string,
): Promise<void> {
  await updateState(root, sourceId, "failed", "failed", code, message);
}

export async function finishUnchanged(
  root: string,
  sourceId: string,
  operation: OperationInput,
): Promise<void> {
  const database = await writable(root);
  try {
    database.transaction(() => {
      database
        .prepare(
          `UPDATE sources SET state = 'active', archive_status = 'published', last_error_code = NULL,
           last_error_message = NULL, updated_at = ?, version = version + 1 WHERE source_id = ?`,
        )
        .run(operation.now, sourceId);
      recordOperation(database, operation, sourceId, { reused_snapshot: true });
    })();
  } finally {
    database.close();
  }
}

export async function publishSnapshot(
  root: string,
  input: {
    sourceId: string;
    snapshotId: string;
    sequence: number;
    previousSnapshotId: string | null;
    manifestSha256: string;
    manifestRelativePath: string;
    entries: ArchivedEntry[];
    changes: SnapshotChange[];
    operation: OperationInput;
  },
): Promise<void> {
  const database = await writable(root);
  try {
    database.transaction(() => {
      insertBlobs(database, input.entries, input.operation.now);
      database
        .prepare(
          `INSERT INTO source_snapshots(snapshot_id, source_id, sequence, previous_snapshot_id,
           manifest_sha256, manifest_relative_path, entry_count, total_bytes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.snapshotId,
          input.sourceId,
          input.sequence,
          input.previousSnapshotId,
          input.manifestSha256,
          input.manifestRelativePath,
          input.entries.length,
          input.entries.reduce((total, entry) => total + entry.size_bytes, 0),
          input.operation.now,
        );
      insertEntries(database, input.snapshotId, input.entries);
      insertChanges(database, input.snapshotId, input.changes);
      database
        .prepare(
          `UPDATE sources SET current_snapshot_id = ?, state = 'active', archive_status = 'published',
           ingestion_status = 'not_started', current_ingestion_run_id = NULL,
           last_error_code = NULL, last_error_message = NULL, updated_at = ?, version = version + 1
           WHERE source_id = ?`,
        )
        .run(input.snapshotId, input.operation.now, input.sourceId);
      recordOperation(database, input.operation, input.sourceId, { snapshot_id: input.snapshotId });
    })();
  } finally {
    database.close();
  }
}

export async function softDeleteSource(
  root: string,
  sourceId: string,
  expectedVersion: number,
  operation: OperationInput,
) {
  const database = await writable(root);
  try {
    database.transaction(() => {
      const result = database
        .prepare(
          `UPDATE sources SET state = 'deleted', deleted_at = ?, updated_at = ?, version = version + 1
           WHERE source_id = ? AND version = ? AND state != 'deleted'`,
        )
        .run(operation.now, operation.now, sourceId, expectedVersion);
      if (result.changes !== 1)
        throw failure("source_plan_conflict", "Source changed after Delete Plan", "conflict");
      recordOperation(database, operation, sourceId, { state: "deleted" });
    })();
  } finally {
    database.close();
  }
}

export async function restoreSource(
  root: string,
  sourceId: string,
  operation: OperationInput,
): Promise<void> {
  const database = await writable(root);
  try {
    database.transaction(() => {
      const result = database
        .prepare(
          `UPDATE sources SET state = 'active', deleted_at = NULL, updated_at = ?, version = version + 1
           WHERE source_id = ? AND state = 'deleted'`,
        )
        .run(operation.now, sourceId);
      if (result.changes !== 1)
        throw failure("source_restore_invalid", "Source is not deleted", "state");
      recordOperation(database, operation, sourceId, { state: "active" });
    })();
  } finally {
    database.close();
  }
}

export async function recordSourceBatchReceipt(
  root: string,
  changeBatchId: string,
  sourceId: string,
  snapshotId: string,
): Promise<void> {
  const database = await writable(root);
  try {
    database
      .prepare(
        `INSERT INTO source_batch_receipts(change_batch_id, source_id, snapshot_id, accepted_at)
         VALUES (?, ?, ?, ?) ON CONFLICT(change_batch_id) DO NOTHING`,
      )
      .run(changeBatchId, sourceId, snapshotId, new Date().toISOString());
  } finally {
    database.close();
  }
}

type OperationInput = {
  operationId: string;
  requestId: string;
  kind: string;
  inputHash: string;
  now: string;
};

async function writable(root: string): Promise<Database> {
  const opened = await openWorkspaceDatabase(root, "read_write");
  if (opened.mode !== "read_write") {
    opened.database.close();
    throw failure(
      "workspace_migration_required",
      "Workspace must be migrated before Source writes",
      "state",
    );
  }
  return opened.database;
}

async function updateState(
  root: string,
  sourceId: string,
  state: string,
  archiveStatus: string,
  errorCode: string | null,
  errorMessage: string | null,
): Promise<void> {
  const database = await writable(root);
  try {
    database
      .prepare(
        `UPDATE sources SET state = ?, archive_status = ?, last_error_code = ?, last_error_message = ?,
         updated_at = ?, version = version + 1 WHERE source_id = ?`,
      )
      .run(state, archiveStatus, errorCode, errorMessage, new Date().toISOString(), sourceId);
  } finally {
    database.close();
  }
}

function insertBlobs(database: Database, entries: ArchivedEntry[], now: string): void {
  const statement = database.prepare(
    `INSERT INTO source_blobs(sha256, size_bytes, mime_type, relative_path, created_at)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT(sha256) DO NOTHING`,
  );
  for (const entry of entries)
    statement.run(
      entry.blob_sha256,
      entry.size_bytes,
      entry.mime_type,
      entry.blob_relative_path,
      now,
    );
}

function insertEntries(database: Database, snapshotId: string, entries: ArchivedEntry[]): void {
  const statement = database.prepare(
    `INSERT INTO source_snapshot_entries(snapshot_id, logical_path, blob_sha256, mime_type, size_bytes, origin_uri, acquired_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const entry of entries)
    statement.run(
      snapshotId,
      entry.logical_path,
      entry.blob_sha256,
      entry.mime_type,
      entry.size_bytes,
      entry.origin_uri,
      entry.acquired_at,
    );
}

function insertChanges(database: Database, snapshotId: string, changes: SnapshotChange[]): void {
  const statement = database.prepare(
    `INSERT INTO source_snapshot_changes(snapshot_id, logical_path, change_kind, previous_blob_sha256, blob_sha256)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const change of changes)
    statement.run(
      snapshotId,
      change.logical_path,
      change.change_kind,
      change.previous_blob_sha256,
      change.blob_sha256,
    );
}

function recordOperation(
  database: Database,
  operation: OperationInput,
  targetId: string,
  result: Record<string, unknown>,
): void {
  database
    .prepare(
      `INSERT INTO operations(operation_id, request_id, kind, status, target_id, input_hash, result_json, created_at, completed_at)
       VALUES (?, ?, ?, 'succeeded', ?, ?, ?, ?, ?)`,
    )
    .run(
      operation.operationId,
      operation.requestId,
      operation.kind,
      targetId,
      operation.inputHash,
      JSON.stringify(result),
      operation.now,
      operation.now,
    );
}
