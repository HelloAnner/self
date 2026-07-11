import type { Database } from "bun:sqlite";
import type {
  ConnectionChange,
  ConnectionKind,
  ConnectionRow,
  ConnectionTarget,
  FilterPolicy,
  Observation,
  ResourcePolicy,
  ScanPolicy,
  WatchMode,
} from "../../domains/connection/index.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import { sha256Text } from "../filesystem/hash.ts";
import {
  mapConnection,
  mapTarget,
  type RawConnection,
  type RawTarget,
  readableConnectionDatabase as readable,
  writableConnectionDatabase as writable,
} from "./connection-db.ts";

export async function createConnectionRecord(
  root: string,
  input: {
    connectionId: string;
    targetId: string;
    sourceId: string;
    name: string;
    kind: ConnectionKind;
    watchMode: WatchMode;
    scanPolicy: ScanPolicy;
    filterPolicy: FilterPolicy;
    resourcePolicy: ResourcePolicy;
    target: {
      uri: string;
      target_kind: "file" | "directory";
      location_scope: "external" | "managed_content";
      canonical_path: string;
      target_identity_key: string;
      path_fingerprint: Record<string, unknown> | null;
      recursive: boolean;
      follow_symlinks: boolean;
      case_sensitivity: ConnectionTarget["case_sensitivity"];
    };
    paused: boolean;
    requestId: string;
    operationId: string;
  },
): Promise<void> {
  const database = await writable(root);
  const now = new Date().toISOString();
  try {
    const workspace = database
      .query<{ workspace_id: string }, []>("SELECT workspace_id FROM workspace")
      .get();
    if (!workspace) throw new Error("Workspace row is missing");
    database.transaction(() => {
      database
        .prepare(
          `INSERT INTO data_connections(connection_id, workspace_id, source_id, name, kind, state, watch_mode,
           scan_policy_json, filter_policy_json, resource_policy_json, next_scan_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.connectionId,
          workspace.workspace_id,
          input.sourceId,
          input.name,
          input.kind,
          input.paused ? "paused" : "initializing",
          input.watchMode,
          JSON.stringify(input.scanPolicy),
          JSON.stringify(input.filterPolicy),
          JSON.stringify(input.resourcePolicy),
          input.paused ? null : now,
          now,
          now,
        );
      database
        .prepare(
          `INSERT INTO connection_targets(target_id, connection_id, uri, target_kind, location_scope,
           canonical_path, target_identity_key, path_fingerprint_json, recursive, follow_symlinks,
           case_sensitivity, status, last_verified_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        )
        .run(
          input.targetId,
          input.connectionId,
          input.target.uri,
          input.target.target_kind,
          input.target.location_scope,
          input.target.canonical_path,
          input.target.target_identity_key,
          JSON.stringify(input.target.path_fingerprint),
          input.target.recursive ? 1 : 0,
          input.target.follow_symlinks ? 1 : 0,
          input.target.case_sensitivity,
          now,
          now,
          now,
        );
      recordOperation(
        database,
        input.operationId,
        input.requestId,
        "connection.add",
        input.connectionId,
        now,
      );
    })();
  } finally {
    database.close();
  }
}

export async function getConnection(root: string, connectionId: string): Promise<ConnectionRow> {
  const database = await readable(root);
  try {
    const row = database
      .query<RawConnection, [string]>("SELECT * FROM data_connections WHERE connection_id = ?")
      .get(connectionId);
    if (!row)
      throw failure("connection_not_found", `Unknown Connection: ${connectionId}`, "not_found");
    return mapConnection(row);
  } finally {
    database.close();
  }
}

export async function getConnectionBySourceId(
  root: string,
  sourceId: string,
): Promise<ConnectionRow | null> {
  const database = await readable(root);
  try {
    const row = database
      .query<RawConnection, [string]>(
        `SELECT * FROM data_connections
         WHERE source_id = ? AND state NOT IN ('detached', 'deleted') LIMIT 1`,
      )
      .get(sourceId);
    return row ? mapConnection(row) : null;
  } finally {
    database.close();
  }
}

export async function getConnectionTarget(
  root: string,
  connectionId: string,
): Promise<ConnectionTarget> {
  const database = await readable(root);
  try {
    const row = database
      .query<RawTarget, [string]>(
        "SELECT * FROM connection_targets WHERE connection_id = ? AND deleted_at IS NULL",
      )
      .get(connectionId);
    if (!row)
      throw failure("connection_target_unavailable", "Connection has no active Target", "state");
    return mapTarget(row);
  } finally {
    database.close();
  }
}

export async function listConnections(root: string, state?: string): Promise<ConnectionRow[]> {
  const database = await readable(root);
  try {
    const rows = state
      ? database
          .query<RawConnection, [string]>(
            "SELECT * FROM data_connections WHERE state = ? ORDER BY created_at",
          )
          .all(state)
      : database
          .query<RawConnection, []>("SELECT * FROM data_connections ORDER BY created_at")
          .all();
    return rows.map(mapConnection);
  } finally {
    database.close();
  }
}

export async function listActiveTargets(root: string): Promise<ConnectionTarget[]> {
  const database = await readable(root);
  try {
    return database
      .query<RawTarget, []>(
        `SELECT t.* FROM connection_targets t JOIN data_connections c ON c.connection_id = t.connection_id
         WHERE t.deleted_at IS NULL AND c.state NOT IN ('detached', 'deleted')`,
      )
      .all()
      .map(mapTarget);
  } finally {
    database.close();
  }
}

export async function listObservations(root: string, connectionId: string): Promise<Observation[]> {
  const database = await readable(root);
  try {
    return database
      .query<Observation, [string]>(
        `SELECT observation_id, connection_id, target_id, relative_path, normalized_path_key,
         file_identity, size_bytes, mtime_ns, quick_fingerprint, content_hash, snapshot_id,
         state, missing_since, version FROM connection_observations WHERE connection_id = ?`,
      )
      .all(connectionId);
  } finally {
    database.close();
  }
}

export async function startScan(
  root: string,
  connectionId: string,
  trigger: string,
): Promise<string> {
  const database = await writable(root);
  try {
    const running = database
      .query<{ count: number }, [string]>(
        `SELECT COUNT(*) count FROM connection_scan_runs WHERE connection_id = ?
         AND state IN ('queued', 'enumerating', 'comparing', 'hashing', 'batching')`,
      )
      .get(connectionId);
    if (running?.count)
      throw failure(
        "connection_scan_in_progress",
        "Connection already has an active Scan",
        "conflict",
      );
    const scanId = createResourceId("scan");
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO connection_scan_runs(scan_run_id, connection_id, trigger_kind, state, started_at, created_at)
         VALUES (?, ?, ?, 'enumerating', ?, ?)`,
      )
      .run(scanId, connectionId, trigger, now, now);
    return scanId;
  } finally {
    database.close();
  }
}

export async function persistDetectedBatch(
  root: string,
  connectionId: string,
  scanId: string,
  changes: ConnectionChange[],
) {
  if (changes.length === 0) return null;
  const database = await writable(root);
  const fingerprint = sha256Text(
    JSON.stringify(
      changes.map((item) => [item.kind, item.relative_path, item.previous_path, item.current_hash]),
    ),
  );
  const key = sha256Text(`${connectionId}\n${fingerprint}`);
  try {
    const existing = database
      .query<{ change_batch_id: string }, [string]>(
        "SELECT change_batch_id FROM connection_change_batches WHERE idempotency_key = ?",
      )
      .get(key);
    if (existing) return { batchId: existing.change_batch_id, reused: true };
    const batchId = createResourceId("change-batch");
    const now = new Date().toISOString();
    database.transaction(() => {
      database
        .prepare(
          `INSERT INTO connection_change_batches(change_batch_id, connection_id, scan_run_id, state,
           item_count, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, 'detected', ?, ?, ?, ?)`,
        )
        .run(batchId, connectionId, scanId, changes.length, key, now, now);
      const statement = database.prepare(
        `INSERT INTO connection_change_items(change_item_id, batch_id, observation_id, change_kind,
         state, relative_path, previous_path, previous_hash, current_hash, observation_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'stabilized', ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of changes) {
        statement.run(
          createResourceId("change-item"),
          batchId,
          item.observation_id,
          item.kind,
          item.relative_path,
          item.previous_path,
          item.previous_hash,
          item.current_hash,
          item.observation_version,
          now,
          now,
        );
      }
      database
        .prepare("UPDATE connection_scan_runs SET state = 'batching' WHERE scan_run_id = ?")
        .run(scanId);
    })();
    return { batchId, reused: false };
  } finally {
    database.close();
  }
}

export { completeScan, failScan, finishDryRun } from "./scan-result-repository.ts";

function recordOperation(
  database: Database,
  operationId: string,
  requestId: string,
  kind: string,
  targetId: string,
  now: string,
): void {
  database
    .prepare(
      `INSERT INTO operations(operation_id, request_id, kind, status, target_id, input_hash, result_json, created_at, completed_at)
       VALUES (?, ?, ?, 'succeeded', ?, ?, '{}', ?, ?)`,
    )
    .run(operationId, requestId, kind, targetId, sha256Text(targetId), now, now);
}
