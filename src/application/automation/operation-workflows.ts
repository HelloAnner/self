import { readableAutomationDatabase } from "../../infrastructure/automation/automation-db.ts";
import {
  auditHistory,
  listOperations,
  operationView,
} from "../../infrastructure/automation/automation-repository.ts";

export async function showOperation(root: string, operationId: string) {
  const database = await readableAutomationDatabase(root);
  try {
    return operationView(database, operationId);
  } finally {
    database.close();
  }
}

export async function showOperationDiff(root: string, operationId: string) {
  const operation = (await showOperation(root, operationId)) as Record<string, unknown> & {
    changes: Record<string, unknown>[];
  };
  return {
    operation_id: operation.operation_id,
    kind: operation.kind,
    status: operation.status,
    reversible: Number(operation.reversible) === 1,
    undo_of_operation_id: operation.undo_of_operation_id,
    changes: operation.changes.map((change) => ({
      resource_id: change.resource_id,
      resource_kind: change.resource_kind,
      change_kind: change.change_kind,
      status: change.status,
      version_before: change.version_before,
      version_after: change.version_after,
      before: change.before_json,
      after: change.after_json,
    })),
  };
}

export async function showOperations(root: string, resourceId?: string, limit = 100) {
  const database = await readableAutomationDatabase(root);
  try {
    return listOperations(database, resourceId, limit);
  } finally {
    database.close();
  }
}

export async function showHistory(root: string, resourceId?: string, limit = 100) {
  const database = await readableAutomationDatabase(root);
  try {
    return auditHistory(database, resourceId, limit);
  } finally {
    database.close();
  }
}
