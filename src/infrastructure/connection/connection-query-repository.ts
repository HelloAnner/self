import { readableConnectionDatabase, writableConnectionDatabase } from "./connection-db.ts";

export async function getConnectionMetrics(root: string, connectionId: string) {
  const database = await readableConnectionDatabase(root);
  try {
    const observations = database
      .query<{ state: string; count: number }, [string]>(
        "SELECT state, COUNT(*) count FROM connection_observations WHERE connection_id = ? GROUP BY state",
      )
      .all(connectionId);
    const pending =
      database
        .query<{ count: number }, [string]>(
          `SELECT COUNT(*) count FROM connection_change_items i
         JOIN connection_change_batches b ON b.change_batch_id = i.batch_id
         WHERE b.connection_id = ? AND i.state NOT IN ('archived', 'ingested', 'ignored')`,
        )
        .get(connectionId)?.count ?? 0;
    const failed =
      database
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) count FROM connection_failures WHERE connection_id = ? AND resolved_at IS NULL",
        )
        .get(connectionId)?.count ?? 0;
    const latestScan = database
      .query<
        { scan_run_id: string; state: string; created_at: string; finished_at: string | null },
        [string]
      >(
        `SELECT scan_run_id, state, created_at, finished_at FROM connection_scan_runs
         WHERE connection_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(connectionId);
    return {
      known_files: observations.reduce(
        (total, item) => total + (item.state === "active" ? item.count : 0),
        0,
      ),
      observations: Object.fromEntries(observations.map((item) => [item.state, item.count])),
      pending_changes: pending,
      failed_changes: failed,
      latest_scan: latestScan ?? null,
    };
  } finally {
    database.close();
  }
}

export async function listConnectionEvents(
  root: string,
  options: { connectionId?: string; limit?: number } = {},
) {
  const database = await readableConnectionDatabase(root);
  try {
    const limit = Math.min(options.limit ?? 100, 1_000);
    return options.connectionId
      ? database
          .query<ConnectionEventRow, [string, number]>(eventSql("WHERE b.connection_id = ?"))
          .all(options.connectionId, limit)
      : database.query<ConnectionEventRow, [number]>(eventSql("")).all(limit);
  } finally {
    database.close();
  }
}

export async function listDueConnectionIds(root: string, now: string): Promise<string[]> {
  const database = await readableConnectionDatabase(root);
  try {
    return database
      .query<{ connection_id: string }, [string]>(
        `SELECT connection_id FROM data_connections
         WHERE state IN ('active', 'degraded') AND (reconcile_required = 1 OR next_scan_at <= ?)
         ORDER BY next_scan_at LIMIT 20`,
      )
      .all(now)
      .map((row) => row.connection_id);
  } finally {
    database.close();
  }
}

export async function recordEventHint(
  root: string,
  connectionId: string,
  targetId: string,
  eventKind: string,
  relativePath: string | null,
): Promise<void> {
  const database = await writableConnectionDatabase(root);
  const now = new Date().toISOString();
  const key = `${connectionId}:${eventKind}:${relativePath ?? "*"}:${Math.floor(Date.now() / 250)}`;
  try {
    database.transaction(() => {
      database
        .prepare(
          `INSERT INTO connection_event_hints(connection_id, target_id, event_kind, relative_path,
           received_at, dedupe_key, state) VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
        )
        .run(connectionId, targetId, eventKind, relativePath, now, key);
      database
        .prepare(
          "UPDATE data_connections SET reconcile_required = 1, next_scan_at = ?, updated_at = ? WHERE connection_id = ?",
        )
        .run(now, now, connectionId);
    })();
  } finally {
    database.close();
  }
}

export async function markEventHintsProcessed(root: string, connectionId: string): Promise<void> {
  const database = await writableConnectionDatabase(root);
  try {
    database
      .prepare(
        "UPDATE connection_event_hints SET state = 'processed' WHERE connection_id = ? AND state = 'pending'",
      )
      .run(connectionId);
  } finally {
    database.close();
  }
}

export async function recoverInterruptedConnections(root: string): Promise<{ scans: number }> {
  const database = await writableConnectionDatabase(root);
  const now = new Date().toISOString();
  try {
    const result = database
      .prepare(
        `UPDATE connection_scan_runs SET state = 'failed', finished_at = ?, error_count = error_count + 1,
         error_summary_json = ? WHERE state IN ('queued', 'enumerating', 'comparing', 'hashing', 'batching')`,
      )
      .run(now, JSON.stringify({ code: "connection_scan_interrupted" }));
    database.exec(
      "UPDATE data_connections SET reconcile_required = 1 WHERE connection_id IN (SELECT connection_id FROM connection_scan_runs WHERE error_summary_json LIKE '%connection_scan_interrupted%')",
    );
    return { scans: result.changes };
  } finally {
    database.close();
  }
}

export async function getBatch(root: string, batchId: string) {
  const database = await readableConnectionDatabase(root);
  try {
    const batch = database
      .query<Record<string, unknown>, [string]>(
        "SELECT * FROM connection_change_batches WHERE change_batch_id = ?",
      )
      .get(batchId);
    if (!batch) return null;
    const items = database
      .query<Record<string, unknown>, [string]>(
        "SELECT * FROM connection_change_items WHERE batch_id = ? ORDER BY relative_path",
      )
      .all(batchId);
    return { ...batch, items };
  } finally {
    database.close();
  }
}

export async function getSnapshotRenames(
  root: string,
  snapshotId: string,
): Promise<Map<string, string>> {
  const database = await readableConnectionDatabase(root);
  try {
    const rows = database
      .query<{ previous_path: string; relative_path: string }, [string]>(
        `SELECT previous_path, relative_path FROM connection_change_items
         WHERE snapshot_id = ? AND change_kind = 'renamed' AND previous_path IS NOT NULL`,
      )
      .all(snapshotId);
    return new Map(rows.map((row) => [row.previous_path, row.relative_path]));
  } finally {
    database.close();
  }
}

type ConnectionEventRow = {
  change_item_id: string;
  connection_id: string;
  batch_id: string;
  change_kind: string;
  state: string;
  relative_path: string;
  previous_path: string | null;
  snapshot_id: string | null;
  created_at: string;
};

function eventSql(where: string): string {
  return `SELECT i.change_item_id, b.connection_id, i.batch_id, i.change_kind, i.state,
    i.relative_path, i.previous_path, i.snapshot_id, i.created_at
    FROM connection_change_items i JOIN connection_change_batches b ON b.change_batch_id = i.batch_id
    ${where} ORDER BY i.created_at DESC LIMIT ?`;
}
