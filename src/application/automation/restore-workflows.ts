import type { Database } from "bun:sqlite";
import { automationInputHash } from "../../domains/automation/index.ts";
import { writableAutomationDatabase } from "../../infrastructure/automation/automation-db.ts";
import {
  completeAutomationOperation,
  findIdempotency,
  operationView,
} from "../../infrastructure/automation/automation-repository.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import {
  applyMutationChanges,
  reverseOperationChanges,
  verifyMutationChanges,
} from "./mutation-store.ts";

type RestorableKind =
  | "source"
  | "note"
  | "connection"
  | "entity"
  | "relation"
  | "claim"
  | "topic"
  | "artifact";

type Row = Record<string, unknown>;

export async function restoreDeletedResource(
  root: string,
  kind: RestorableKind,
  resourceId: string,
  requestId: string,
  options: { ifVersion?: number; idempotencyKey?: string } = {},
) {
  const commandKind = `${kind}.restore`;
  const input = { resource_id: resourceId, if_version: options.ifVersion ?? null };
  const inputHash = automationInputHash(input);
  const database = await writableAutomationDatabase(root);
  try {
    const prior = findIdempotency(database, options.idempotencyKey, commandKind, inputHash);
    if (prior?.result_json && typeof prior.result_json === "object") {
      return { ...(prior.result_json as Row), reused: true };
    }
    const originalOperationId = latestDeleteOperation(database, kind, resourceId);
    const original = operationView(database, originalOperationId) as Row & { changes: Row[] };
    if (Number(original.reversible) !== 1) {
      throw failure("restore_unavailable", "The deleting Operation is not reversible", "state");
    }
    const alreadyRestored = database
      .query<{ operation_id: string }, [string]>(
        `SELECT operation_id FROM operations WHERE undo_of_operation_id = ?
         AND status = 'succeeded' LIMIT 1`,
      )
      .get(originalOperationId);
    if (alreadyRestored) {
      throw failure("resource_not_deleted", "Resource has already been restored", "state", {
        details: { restore_operation_id: alreadyRestored.operation_id },
      });
    }
    const planned = reverseOperationChanges(original.changes);
    const primary = planned.find(
      (change) => change.resource_kind === kind && change.resource_id === resourceId,
    );
    if (!primary) {
      throw failure(
        "restore_unavailable",
        "Delete Operation has no matching resource change",
        "state",
      );
    }
    const currentVersion = numeric(primary.before.version ?? primary.before.revision);
    if (options.ifVersion !== undefined && currentVersion !== options.ifVersion) {
      throw failure(
        "version_conflict",
        "Resource version does not match --if-version",
        "conflict",
        {
          details: { expected: options.ifVersion, actual: currentVersion },
        },
      );
    }
    verifyMutationChanges(database, planned);
    const now = new Date().toISOString();
    const operationId = createResourceId("operation");
    return database.transaction(() => {
      const changes = applyMutationChanges(database, planned, now);
      const restored = changes.find(
        (change) => change.resourceKind === kind && change.resourceId === resourceId,
      );
      const state = restored?.after.state ?? restored?.after.status;
      const result = {
        operation_id: operationId,
        undo_of_operation_id: originalOperationId,
        resource_id: resourceId,
        resource_kind: kind,
        ...(typeof state === "string" ? { state } : {}),
        version: restored?.versionAfter ?? null,
        restored_changes: changes.length,
        reversible: true,
      };
      completeAutomationOperation(database, {
        plan: null,
        operationId,
        requestId,
        kind: commandKind,
        targetId: resourceId,
        inputHash,
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
        result,
        changes,
        reversible: true,
        atomicity: "atomic",
        undoOfOperationId: originalOperationId,
        createdAt: now,
        completedAt: now,
      });
      return result;
    })();
  } finally {
    database.close();
  }
}

function latestDeleteOperation(
  database: Database,
  kind: RestorableKind,
  resourceId: string,
): string {
  const changeKinds = kind === "connection" ? ["detached", "deleted"] : ["deleted"];
  const placeholders = changeKinds.map(() => "?").join(", ");
  const row = database
    .query<{ operation_id: string }, string[]>(
      `SELECT c.operation_id FROM automation_operation_changes c JOIN operations o
       ON o.operation_id = c.operation_id
       WHERE c.resource_kind = ? AND c.resource_id = ? AND c.change_kind IN (${placeholders})
       AND o.status = 'succeeded' ORDER BY o.completed_at DESC LIMIT 1`,
    )
    .get(kind, resourceId, ...changeKinds);
  if (!row) {
    throw failure("resource_not_deleted", "No reversible delete Operation exists", "state");
  }
  return row.operation_id;
}

function numeric(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}
