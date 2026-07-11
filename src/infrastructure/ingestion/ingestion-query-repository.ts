import { failure } from "../../shared/errors/self-error.ts";
import { readableIngestionDatabase } from "./ingestion-db.ts";

export async function knowledgeStatus(root: string, sourceId?: string) {
  const database = await readableIngestionDatabase(root);
  try {
    const sql = `SELECT s.source_id, s.name, s.archive_status, s.ingestion_status,
      s.current_snapshot_id, s.current_ingestion_run_id, i.state ingestion_run_state,
      i.files_total, i.files_parsed, i.files_skipped, i.documents_published,
      i.chunks_published, i.chunks_reused, i.chunks_tombstoned, i.error_code, i.updated_at
      FROM sources s LEFT JOIN ingestion_runs i ON i.ingestion_run_id = s.current_ingestion_run_id`;
    return sourceId
      ? database
          .query<Record<string, unknown>, [string]>(`${sql} WHERE s.source_id = ?`)
          .all(sourceId)
      : database.query<Record<string, unknown>, []>(`${sql} ORDER BY s.created_at`).all();
  } finally {
    database.close();
  }
}

export async function listIngestionFailures(root: string, sourceId?: string) {
  const database = await readableIngestionDatabase(root);
  try {
    const where = sourceId ? "WHERE i.source_id = ?" : "";
    const sql = `SELECT i.ingestion_run_id, i.source_id, i.snapshot_id, i.state, i.error_code,
      i.error_message, i.attempt, i.updated_at, e.logical_path, e.error_code entry_error_code
      FROM ingestion_runs i LEFT JOIN ingestion_entry_results e
      ON e.ingestion_run_id = i.ingestion_run_id AND e.state = 'failed'
      ${where} AND i.state = 'failed' ORDER BY i.updated_at DESC`;
    return sourceId
      ? database.query<Record<string, unknown>, [string]>(sql).all(sourceId)
      : database
          .query<Record<string, unknown>, []>(sql.replace(" AND i.state", " WHERE i.state"))
          .all();
  } finally {
    database.close();
  }
}

export async function showIngestionRun(root: string, runId: string) {
  const database = await readableIngestionDatabase(root);
  try {
    const run = database
      .query<Record<string, unknown>, [string]>(
        "SELECT * FROM ingestion_runs WHERE ingestion_run_id = ?",
      )
      .get(runId);
    if (!run) throw failure("ingestion_not_found", `Unknown IngestionRun: ${runId}`, "not_found");
    const entries = database
      .query<Record<string, unknown>, [string]>(
        "SELECT * FROM ingestion_entry_results WHERE ingestion_run_id = ? ORDER BY logical_path",
      )
      .all(runId);
    return { ...run, entries };
  } finally {
    database.close();
  }
}

export async function listBuildCandidates(root: string, sourceId?: string) {
  const database = await readableIngestionDatabase(root);
  try {
    const sql = `SELECT source_id, current_snapshot_id FROM sources
      WHERE state = 'active' AND archive_status = 'published' AND current_snapshot_id IS NOT NULL
      AND (ingestion_status != 'ready' OR current_ingestion_run_id IS NULL
        OR current_ingestion_run_id NOT IN (
          SELECT ingestion_run_id FROM ingestion_runs WHERE snapshot_id = sources.current_snapshot_id AND state = 'ready'
        ))`;
    return sourceId
      ? database
          .query<{ source_id: string; current_snapshot_id: string }, [string]>(
            `${sql} AND source_id = ?`,
          )
          .all(sourceId)
      : database
          .query<{ source_id: string; current_snapshot_id: string }, []>(
            `${sql} ORDER BY created_at`,
          )
          .all();
  } finally {
    database.close();
  }
}

export async function listCurrentSnapshots(root: string) {
  const database = await readableIngestionDatabase(root);
  try {
    return database
      .query<{ source_id: string; current_snapshot_id: string }, []>(
        `SELECT source_id, current_snapshot_id FROM sources WHERE state = 'active'
         AND archive_status = 'published' AND current_snapshot_id IS NOT NULL ORDER BY created_at`,
      )
      .all();
  } finally {
    database.close();
  }
}

export async function findSnapshotOwner(root: string, snapshotId: string) {
  const database = await readableIngestionDatabase(root);
  try {
    const row = database
      .query<{ source_id: string }, [string]>(
        "SELECT source_id FROM source_snapshots WHERE snapshot_id = ?",
      )
      .get(snapshotId);
    if (!row) throw failure("snapshot_not_found", `Unknown Snapshot: ${snapshotId}`, "not_found");
    return row.source_id;
  } finally {
    database.close();
  }
}
