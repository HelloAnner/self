import type { Database } from "bun:sqlite";
import type { AutomationPlanManifest, OperationChange } from "../../domains/automation/index.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { createResourceId } from "../../shared/ids/id.ts";

type Row = Record<string, unknown>;

export function findIdempotency(
  database: Database,
  key: string | null | undefined,
  commandKind: string,
  inputHash: string,
) {
  if (!key) return null;
  const row = database
    .query<Row, [string]>("SELECT * FROM automation_idempotency_records WHERE idempotency_key = ?")
    .get(key);
  if (!row) return null;
  if (row.command_kind !== commandKind || row.input_hash !== inputHash) {
    throw failure(
      "idempotency_conflict",
      "Idempotency key was already used with different input",
      "conflict",
      { details: { command_kind: row.command_kind } },
    );
  }
  return parseJsonRow(row);
}

export function insertAutomationPlan(
  database: Database,
  plan: AutomationPlanManifest,
  manifestRelativePath: string,
): void {
  database.transaction(() => {
    database
      .prepare(
        `INSERT INTO automation_plans(plan_id, kind, action, state, request_id, operation_id,
         resource_id, idempotency_key, input_hash, input_json, preconditions_json, impact_json,
         changes_json, inverse_json, reversible, atomicity, manifest_relative_path, created_at,
         expires_at) VALUES (?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        plan.plan_id,
        plan.kind,
        plan.action,
        plan.request_id,
        plan.operation_id,
        plan.resource_id,
        plan.idempotency_key,
        plan.input_hash,
        JSON.stringify(plan.input),
        JSON.stringify(plan.preconditions),
        JSON.stringify(plan.impact),
        JSON.stringify(plan.changes),
        plan.inverse ? JSON.stringify(plan.inverse) : null,
        plan.reversible ? 1 : 0,
        plan.atomicity,
        manifestRelativePath,
        plan.created_at,
        plan.expires_at,
      );
    const targetInsert = database.prepare(
      `INSERT INTO automation_plan_targets(plan_id, resource_id, resource_kind, role,
       expected_version, expected_state) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const target of plan.targets) {
      targetInsert.run(
        plan.plan_id,
        target.resourceId,
        target.resourceKind,
        target.role,
        target.expectedVersion ?? null,
        target.expectedState ?? null,
      );
    }
    if (plan.idempotency_key) {
      database
        .prepare(
          `INSERT INTO automation_idempotency_records(idempotency_key, command_kind, input_hash,
           state, plan_id, operation_id, created_at, updated_at)
           VALUES (?, ?, ?, 'planned', ?, ?, ?, ?)`,
        )
        .run(
          plan.idempotency_key,
          `${plan.kind}:${plan.action}`,
          plan.input_hash,
          plan.plan_id,
          plan.operation_id,
          plan.created_at,
          plan.created_at,
        );
    }
    insertAudit(database, {
      planId: plan.plan_id,
      eventType: "plan_created",
      resourceId: plan.resource_id,
      after: { action: plan.action, impact: plan.impact, reversible: plan.reversible },
      createdAt: plan.created_at,
    });
  })();
}

export function automationPlan(database: Database, planId: string): AutomationPlanManifest {
  const row = database
    .query<Row, [string]>("SELECT * FROM automation_plans WHERE plan_id = ?")
    .get(planId);
  if (!row) throw failure("plan_not_found", "Plan does not exist", "not_found");
  const targets = database
    .query<Row, [string]>(
      `SELECT resource_id, resource_kind, role, expected_version, expected_state
       FROM automation_plan_targets WHERE plan_id = ? ORDER BY role, resource_kind, resource_id`,
    )
    .all(planId);
  return planFromRow(row, targets);
}

export function listAutomationPlans(database: Database, state?: string, limit = 100) {
  const rows = state
    ? database
        .query<Row, [string, number]>(
          "SELECT * FROM automation_plans WHERE state = ? ORDER BY created_at DESC LIMIT ?",
        )
        .all(state, limit)
    : database
        .query<Row, [number]>("SELECT * FROM automation_plans ORDER BY created_at DESC LIMIT ?")
        .all(limit);
  return rows.map((row) => planSummary(row));
}

export function cancelAutomationPlan(database: Database, planId: string, now: string) {
  const plan = automationPlan(database, planId);
  if (plan.state !== "ready")
    throw failure("plan_state_invalid", "Only a ready Plan can be cancelled", "state");
  database.transaction(() => {
    database
      .prepare(
        "UPDATE automation_plans SET state = 'cancelled', cancelled_at = ? WHERE plan_id = ?",
      )
      .run(now, planId);
    if (plan.idempotency_key)
      database
        .prepare(
          `UPDATE automation_idempotency_records SET state = 'cancelled', updated_at = ?
           WHERE idempotency_key = ?`,
        )
        .run(now, plan.idempotency_key);
    insertAudit(database, {
      planId,
      eventType: "plan_cancelled",
      resourceId: plan.resource_id,
      createdAt: now,
    });
  })();
  return { plan_id: planId, state: "cancelled" as const, cancelled_at: now };
}

export function completeAutomationOperation(
  database: Database,
  input: {
    plan: AutomationPlanManifest | null;
    operationId: string;
    requestId: string;
    kind: string;
    targetId: string | null;
    inputHash: string;
    idempotencyKey?: string | null;
    result: Record<string, unknown>;
    changes: OperationChange[];
    reversible: boolean;
    atomicity: "atomic" | "per_item";
    undoOfOperationId?: string | null;
    createdAt: string;
    completedAt: string;
  },
) {
  database
    .prepare(
      `INSERT INTO operations(operation_id, request_id, kind, status, target_id,
       idempotency_key, input_hash, result_json, created_at, completed_at, plan_id,
       undo_of_operation_id, reversible, atomicity, resource_version_before,
       resource_version_after)
       VALUES (?, ?, ?, 'succeeded', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.operationId,
      input.requestId,
      input.kind,
      input.targetId,
      input.idempotencyKey ?? null,
      input.inputHash,
      JSON.stringify(input.result),
      input.createdAt,
      input.completedAt,
      input.plan?.plan_id ?? null,
      input.undoOfOperationId ?? null,
      input.reversible ? 1 : 0,
      input.atomicity,
      input.changes[0]?.versionBefore ?? null,
      input.changes[0]?.versionAfter ?? null,
    );
  const changeInsert = database.prepare(
    `INSERT INTO automation_operation_changes(operation_id, ordinal, resource_id,
     resource_kind, change_kind, status, version_before, version_after, before_json,
     after_json, inverse_json, error_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  input.changes.forEach((change, index) => {
    changeInsert.run(
      input.operationId,
      index + 1,
      change.resourceId,
      change.resourceKind,
      change.changeKind,
      change.status ?? "succeeded",
      change.versionBefore ?? null,
      change.versionAfter ?? null,
      JSON.stringify(change.before),
      JSON.stringify(change.after),
      change.inverse ? JSON.stringify(change.inverse) : null,
      change.error ? JSON.stringify(change.error) : null,
    );
    insertAudit(database, {
      operationId: input.operationId,
      planId: input.plan?.plan_id ?? null,
      eventType: `resource_${change.changeKind}`,
      resourceId: change.resourceId,
      before: change.before,
      after: change.after,
      metadata: { resource_kind: change.resourceKind, ordinal: index + 1 },
      createdAt: input.completedAt,
    });
  });
  if (input.plan) {
    database
      .prepare("UPDATE automation_plans SET state = 'applied', applied_at = ? WHERE plan_id = ?")
      .run(input.completedAt, input.plan.plan_id);
  }
  if (input.idempotencyKey) {
    database
      .prepare(
        `INSERT INTO automation_idempotency_records(idempotency_key, command_kind, input_hash,
         state, plan_id, operation_id, result_json, created_at, updated_at)
         VALUES (?, ?, ?, 'succeeded', ?, ?, ?, ?, ?)
         ON CONFLICT(idempotency_key) DO UPDATE SET state = 'succeeded', operation_id = excluded.operation_id,
         result_json = excluded.result_json, updated_at = excluded.updated_at`,
      )
      .run(
        input.idempotencyKey,
        input.plan ? `${input.plan.kind}:${input.plan.action}` : input.kind,
        input.inputHash,
        input.plan?.plan_id ?? null,
        input.operationId,
        JSON.stringify(input.result),
        input.createdAt,
        input.completedAt,
      );
  }
  insertAudit(database, {
    operationId: input.operationId,
    planId: input.plan?.plan_id ?? null,
    eventType: input.undoOfOperationId ? "operation_undone" : "operation_applied",
    resourceId: input.targetId,
    after: input.result,
    metadata: {
      reversible: input.reversible,
      atomicity: input.atomicity,
      undo_of_operation_id: input.undoOfOperationId ?? null,
    },
    createdAt: input.completedAt,
  });
}

export function operationView(database: Database, operationId: string) {
  const operation = database
    .query<Row, [string]>("SELECT * FROM operations WHERE operation_id = ?")
    .get(operationId);
  if (!operation) throw failure("operation_not_found", "Operation does not exist", "not_found");
  const changes = database
    .query<Row, [string]>(
      "SELECT * FROM automation_operation_changes WHERE operation_id = ? ORDER BY ordinal",
    )
    .all(operationId)
    .map(parseJsonRow);
  return { ...parseJsonRow(operation), changes };
}

export function listOperations(database: Database, resourceId?: string, limit = 100) {
  const rows = resourceId
    ? database
        .query<Row, [string, string, number]>(
          `SELECT DISTINCT o.* FROM operations o LEFT JOIN automation_operation_changes c
           ON c.operation_id = o.operation_id WHERE o.target_id = ? OR c.resource_id = ?
           ORDER BY o.created_at DESC LIMIT ?`,
        )
        .all(resourceId, resourceId, limit)
    : database
        .query<Row, [number]>("SELECT * FROM operations ORDER BY created_at DESC LIMIT ?")
        .all(limit);
  return rows.map(parseJsonRow);
}

export function auditHistory(database: Database, resourceId?: string, limit = 100) {
  const rows = resourceId
    ? database
        .query<Row, [string, number]>(
          "SELECT * FROM audit_events WHERE resource_id = ? ORDER BY created_at DESC LIMIT ?",
        )
        .all(resourceId, limit)
    : database
        .query<Row, [number]>("SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?")
        .all(limit);
  return rows.map(parseJsonRow);
}

export function markPlanExpired(database: Database, planId: string, now: string): void {
  database
    .prepare("UPDATE automation_plans SET state = 'expired' WHERE plan_id = ? AND state = 'ready'")
    .run(planId);
  insertAudit(database, { planId, eventType: "plan_expired", createdAt: now });
}

function insertAudit(
  database: Database,
  input: {
    operationId?: string | null;
    planId?: string | null;
    eventType: string;
    resourceId?: string | null;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    metadata?: Record<string, unknown>;
    createdAt: string;
  },
) {
  database
    .prepare(
      `INSERT INTO audit_events(event_id, operation_id, plan_id, event_type, resource_id,
       before_json, after_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      createResourceId("event"),
      input.operationId ?? null,
      input.planId ?? null,
      input.eventType,
      input.resourceId ?? null,
      input.before ? JSON.stringify(input.before) : null,
      input.after ? JSON.stringify(input.after) : null,
      JSON.stringify(input.metadata ?? {}),
      input.createdAt,
    );
}

function planFromRow(row: Row, targets: Row[]): AutomationPlanManifest {
  return {
    plan_id: String(row.plan_id),
    kind: String(row.kind),
    action: String(row.action),
    state: row.state as AutomationPlanManifest["state"],
    request_id: String(row.request_id),
    operation_id: String(row.operation_id),
    resource_id: nullable(row.resource_id),
    idempotency_key: nullable(row.idempotency_key),
    input_hash: String(row.input_hash),
    input: jsonObject(row.input_json),
    preconditions: jsonObject(row.preconditions_json),
    impact: jsonObject(row.impact_json),
    changes: jsonArray(row.changes_json),
    inverse: row.inverse_json ? jsonObject(row.inverse_json) : null,
    reversible: Number(row.reversible) === 1,
    atomicity: row.atomicity as AutomationPlanManifest["atomicity"],
    targets: targets.map((target) => ({
      resourceId: String(target.resource_id),
      resourceKind: String(target.resource_kind),
      role: target.role as "primary" | "precondition" | "affected",
      expectedVersion: target.expected_version === null ? null : Number(target.expected_version),
      expectedState: nullable(target.expected_state),
    })),
    created_at: String(row.created_at),
    expires_at: String(row.expires_at),
  };
}

function planSummary(row: Row) {
  return {
    plan_id: row.plan_id,
    kind: row.kind,
    action: row.action,
    state: row.state,
    resource_id: row.resource_id,
    reversible: Number(row.reversible) === 1,
    atomicity: row.atomicity,
    created_at: row.created_at,
    expires_at: row.expires_at,
    applied_at: row.applied_at,
    cancelled_at: row.cancelled_at,
  };
}

function parseJsonRow(row: Row) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      key.endsWith("_json") && typeof value === "string" ? JSON.parse(value) : value,
    ]),
  );
}

function jsonObject(value: unknown): Record<string, unknown> {
  return typeof value === "string" ? (JSON.parse(value) as Record<string, unknown>) : {};
}

function jsonArray(value: unknown): Record<string, unknown>[] {
  return typeof value === "string" ? (JSON.parse(value) as Record<string, unknown>[]) : [];
}

function nullable(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
