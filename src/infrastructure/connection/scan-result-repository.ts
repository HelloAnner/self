import type {
  ConnectionChange,
  ConnectionRow,
  ConnectionTarget,
  InventoryEntry,
  Observation,
} from "../../domains/connection/index.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import { writableConnectionDatabase as writable } from "./connection-db.ts";
import { countConnectionChanges, writeObservations } from "./observation-store.ts";

export async function completeScan(
  root: string,
  input: {
    connection: ConnectionRow;
    target: ConnectionTarget;
    scanId: string;
    inventory: InventoryEntry[];
    previous: Observation[];
    missingPending: Observation[];
    changes: ConnectionChange[];
    batchId: string | null;
    snapshotId: string | null;
    filesHashed: number;
    filesIgnored: number;
    ingestionRunId?: string | null;
    publishedDocuments?: { logical_path: string; revision_id: string }[];
  },
): Promise<void> {
  const database = await writable(root);
  const now = new Date().toISOString();
  try {
    database.transaction(() => {
      writeObservations(database, input, now);
      publishBatch(database, input, now);
      const counts = countConnectionChanges(input.changes);
      database
        .prepare(
          `UPDATE connection_scan_runs SET state = 'succeeded', finished_at = ?, files_seen = ?, files_hashed = ?,
           files_ignored = ?, changes_created = ?, changes_modified = ?, changes_deleted = ?, changes_renamed = ?
           WHERE scan_run_id = ?`,
        )
        .run(
          now,
          input.inventory.length,
          input.filesHashed,
          input.filesIgnored,
          counts.created,
          counts.modified + counts.restored,
          counts.deleted,
          counts.renamed,
          input.scanId,
        );
      const next = new Date(
        Date.now() + input.connection.scan_policy.reconcile_interval_ms,
      ).toISOString();
      database
        .prepare(
          `UPDATE data_connections SET state = 'active', reconcile_required = 0, last_scan_at = ?,
           last_success_at = ?, next_scan_at = ?, consecutive_failures = 0, updated_at = ?, revision = revision + 1
           WHERE connection_id = ?`,
        )
        .run(now, now, next, now, input.connection.connection_id);
      database
        .prepare(
          `UPDATE connection_targets SET status = 'active', last_verified_at = ?, updated_at = ?, revision = revision + 1
           WHERE target_id = ?`,
        )
        .run(now, now, input.target.target_id);
      database
        .prepare(
          "UPDATE connection_failures SET resolved_at = ? WHERE connection_id = ? AND resolved_at IS NULL",
        )
        .run(now, input.connection.connection_id);
    })();
  } finally {
    database.close();
  }
}

function publishBatch(
  database: Awaited<ReturnType<typeof writable>>,
  input: Parameters<typeof completeScan>[1],
  now: string,
): void {
  if (!input.batchId || !input.snapshotId) return;
  database
    .prepare(
      `UPDATE connection_change_batches SET state = 'succeeded', accepted_at = ?, completed_at = ?, updated_at = ?
       WHERE change_batch_id = ?`,
    )
    .run(now, now, now, input.batchId);
  database
    .prepare(
      "UPDATE connection_change_items SET state = 'archived', snapshot_id = ?, updated_at = ? WHERE batch_id = ?",
    )
    .run(input.snapshotId, now, input.batchId);
  if (!input.ingestionRunId) return;
  database
    .prepare(
      `UPDATE connection_change_items SET state = 'ingested', ingestion_run_id = ?,
       error_detail_json = CASE WHEN change_kind = 'deleted' THEN '{"result":"deleted"}' ELSE error_detail_json END,
       updated_at = ? WHERE batch_id = ?`,
    )
    .run(input.ingestionRunId, now, input.batchId);
  const revision = database.prepare(
    "UPDATE connection_change_items SET document_revision_id = ?, updated_at = ? WHERE batch_id = ? AND relative_path = ?",
  );
  for (const document of input.publishedDocuments ?? []) {
    revision.run(document.revision_id, now, input.batchId, document.logical_path);
  }
}

export async function finishDryRun(
  root: string,
  scanId: string,
  filesSeen: number,
  filesHashed: number,
  filesIgnored: number,
  changes: ConnectionChange[],
): Promise<void> {
  const database = await writable(root);
  const now = new Date().toISOString();
  const counts = countConnectionChanges(changes);
  try {
    database
      .prepare(
        `UPDATE connection_scan_runs SET state = 'succeeded', finished_at = ?, files_seen = ?, files_hashed = ?,
         files_ignored = ?, changes_created = ?, changes_modified = ?, changes_deleted = ?, changes_renamed = ?,
         metrics_json = ? WHERE scan_run_id = ?`,
      )
      .run(
        now,
        filesSeen,
        filesHashed,
        filesIgnored,
        counts.created,
        counts.modified + counts.restored,
        counts.deleted,
        counts.renamed,
        JSON.stringify({ dry_run: true }),
        scanId,
      );
  } finally {
    database.close();
  }
}

export async function failScan(
  root: string,
  connectionId: string,
  scanId: string,
  code: string,
  message: string,
): Promise<void> {
  const database = await writable(root);
  const now = new Date().toISOString();
  try {
    database.transaction(() => {
      database
        .prepare(
          "UPDATE connection_scan_runs SET state = 'failed', finished_at = ?, error_count = 1, error_summary_json = ? WHERE scan_run_id = ?",
        )
        .run(now, JSON.stringify({ code, message }), scanId);
      database
        .prepare(
          `UPDATE data_connections SET state = 'degraded', reconcile_required = 1, last_scan_at = ?,
           consecutive_failures = consecutive_failures + 1, updated_at = ?, revision = revision + 1 WHERE connection_id = ?`,
        )
        .run(now, now, connectionId);
      markTargetFailure(database, connectionId, code, now);
      database
        .prepare(
          "UPDATE connection_change_batches SET state = 'failed', completed_at = ?, updated_at = ? WHERE scan_run_id = ? AND state != 'succeeded'",
        )
        .run(now, now, scanId);
      database
        .prepare(
          `UPDATE connection_change_items SET state = 'failed', error_code = ?, updated_at = ?
           WHERE batch_id IN (SELECT change_batch_id FROM connection_change_batches WHERE scan_run_id = ?)
           AND state NOT IN ('archived', 'ingested')`,
        )
        .run(code, now, scanId);
      database
        .prepare(
          `INSERT INTO connection_failures(failure_id, connection_id, scan_run_id, error_code, retryable,
           attempt, first_seen_at, last_seen_at, detail_json) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?)`,
        )
        .run(
          createResourceId("event"),
          connectionId,
          scanId,
          code,
          now,
          now,
          JSON.stringify({ message }),
        );
    })();
  } finally {
    database.close();
  }
}

function markTargetFailure(
  database: Awaited<ReturnType<typeof writable>>,
  connectionId: string,
  code: string,
  now: string,
): void {
  if (!["connection_target_unavailable", "connection_target_permission_denied"].includes(code))
    return;
  database
    .prepare("UPDATE connection_targets SET status = ?, updated_at = ? WHERE connection_id = ?")
    .run(
      code === "connection_target_permission_denied" ? "permission_denied" : "unavailable",
      now,
      connectionId,
    );
}
