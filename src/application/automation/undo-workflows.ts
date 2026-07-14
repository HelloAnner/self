import type { Database } from "bun:sqlite";
import { automationInputHash } from "../../domains/automation/index.ts";
import { operationView } from "../../infrastructure/automation/automation-repository.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { impactDigest } from "./impact-helpers.ts";
import { reverseOperationChanges } from "./mutation-store.ts";
import type { MutationDescription } from "./mutation-types.ts";

type Row = Record<string, unknown>;

export function describeOperationUndo(
  database: Database,
  operationId: string,
): MutationDescription {
  const operation = operationView(database, operationId) as Row & { changes: Row[] };
  if (operation.status !== "succeeded") {
    throw failure("operation_not_undoable", "Only a succeeded Operation can be undone", "state");
  }
  if (Number(operation.reversible) !== 1) {
    throw failure("operation_not_undoable", "Operation is not reversible", "state");
  }
  if (operation.changes.length === 0) {
    throw failure("operation_not_undoable", "Operation has no reversible changes", "state");
  }
  const existingUndo = database
    .query<{ operation_id: string }, [string]>(
      `SELECT operation_id FROM operations
       WHERE undo_of_operation_id = ? AND status = 'succeeded' LIMIT 1`,
    )
    .get(operationId);
  if (existingUndo) {
    throw failure("operation_already_undone", "Operation was already undone", "state", {
      details: { undo_operation_id: existingUndo.operation_id },
    });
  }
  const changes = reverseOperationChanges(operation.changes);
  const changeHash = impactDigest(changes);
  const fileMove = noteMovePrecondition(database, operation);
  return {
    preconditions: {
      operation_id: operationId,
      operation_status: operation.status,
      completed_at: operation.completed_at,
      change_hash: changeHash,
      ...(fileMove ? { file_move: fileMove } : {}),
    },
    impact: {
      original_operation_id: operationId,
      original_kind: operation.kind,
      change_count: changes.length,
      resources: changes.map((change) => ({
        resource_id: change.resource_id,
        resource_kind: change.resource_kind,
        change_kind: change.change_kind,
      })),
      impact_hash: automationInputHash({ operation_id: operationId, change_hash: changeHash }),
      ...(fileMove ? { files: [fileMove] } : {}),
    },
    changes,
    inverse: null,
    reversible: false,
    targets: changes.map((change, index) => ({
      resourceId: change.resource_id,
      resourceKind: change.resource_kind,
      role: index === 0 ? ("primary" as const) : ("affected" as const),
      expectedVersion: numeric(change.before.version ?? change.before.revision),
      expectedState: state(change.before),
    })),
  };
}

function noteMovePrecondition(database: Database, operation: Row) {
  if (operation.kind !== "note.move" || typeof operation.plan_id !== "string") return null;
  const row = database
    .query<{ preconditions_json: string }, [string]>(
      "SELECT preconditions_json FROM automation_plans WHERE plan_id = ?",
    )
    .get(operation.plan_id);
  if (!row) return null;
  const preconditions = JSON.parse(row.preconditions_json) as Record<string, unknown>;
  const from = preconditions.new_relative_path;
  const to = preconditions.old_relative_path;
  const sha256 = preconditions.file_hash;
  if (typeof from !== "string" || typeof to !== "string" || typeof sha256 !== "string") {
    throw failure("operation_not_undoable", "Note move file precondition is unavailable", "state");
  }
  return { from, to, sha256 };
}

function numeric(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function state(value: Record<string, unknown>): string | null {
  const candidate = value.state ?? value.status ?? value.cache_state;
  return typeof candidate === "string" ? candidate : null;
}
