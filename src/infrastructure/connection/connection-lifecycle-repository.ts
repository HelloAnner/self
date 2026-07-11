import { failure } from "../../shared/errors/self-error.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import { sha256Text } from "../filesystem/hash.ts";
import { writableConnectionDatabase } from "./connection-db.ts";

export async function setConnectionState(
  root: string,
  connectionId: string,
  state: "active" | "paused",
  requestId: string,
): Promise<void> {
  const database = await writableConnectionDatabase(root);
  const now = new Date().toISOString();
  const operationId = createResourceId("operation");
  try {
    database.transaction(() => {
      const result = database
        .prepare(
          `UPDATE data_connections SET state = ?, reconcile_required = ?, next_scan_at = ?,
           updated_at = ?, revision = revision + 1 WHERE connection_id = ? AND state NOT IN ('deleted', 'detached')`,
        )
        .run(state, state === "active" ? 1 : 0, state === "active" ? now : null, now, connectionId);
      if (result.changes !== 1) {
        throw failure(
          "connection_state_invalid",
          "Connection cannot change to the requested state",
          "state",
        );
      }
      recordOperation(database, operationId, requestId, `connection.${state}`, connectionId, now);
    })();
  } finally {
    database.close();
  }
}

export async function rebindConnectionTarget(
  root: string,
  input: {
    connectionId: string;
    connectionRevision: number;
    targetId: string;
    targetRevision: number;
    target: {
      uri: string;
      canonical_path: string;
      target_identity_key: string;
      path_fingerprint: Record<string, unknown> | null;
    };
    sourceId: string;
    sourceSpecJson: string;
    operationId: string;
    requestId: string;
  },
): Promise<void> {
  const database = await writableConnectionDatabase(root);
  const now = new Date().toISOString();
  try {
    database.transaction(() => {
      const target = database
        .prepare(
          `UPDATE connection_targets SET uri = ?, canonical_path = ?, target_identity_key = ?,
           path_fingerprint_json = ?, status = 'active', last_verified_at = ?, updated_at = ?, revision = revision + 1
           WHERE target_id = ? AND connection_id = ? AND revision = ?`,
        )
        .run(
          input.target.uri,
          input.target.canonical_path,
          input.target.target_identity_key,
          JSON.stringify(input.target.path_fingerprint),
          now,
          now,
          input.targetId,
          input.connectionId,
          input.targetRevision,
        );
      const connection = database
        .prepare(
          `UPDATE data_connections SET state = 'active', reconcile_required = 1, next_scan_at = ?,
           updated_at = ?, revision = revision + 1 WHERE connection_id = ? AND revision = ?`,
        )
        .run(now, now, input.connectionId, input.connectionRevision);
      if (target.changes !== 1 || connection.changes !== 1) {
        throw failure(
          "connection_rebind_mismatch",
          "Connection changed after Rebind Plan",
          "conflict",
        );
      }
      const source = database
        .prepare(
          "UPDATE sources SET spec_json = ?, updated_at = ?, version = version + 1 WHERE source_id = ?",
        )
        .run(input.sourceSpecJson, now, input.sourceId);
      if (source.changes !== 1) throw new Error("Bound Source was not updated during Rebind");
      recordOperation(
        database,
        input.operationId,
        input.requestId,
        "connection.rebind",
        input.connectionId,
        now,
      );
    })();
  } finally {
    database.close();
  }
}

function recordOperation(
  database: Awaited<ReturnType<typeof writableConnectionDatabase>>,
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
