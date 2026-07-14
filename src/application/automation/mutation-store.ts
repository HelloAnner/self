import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { OperationChange } from "../../domains/automation/index.ts";
import { canonicalAutomationJson } from "../../domains/automation/index.ts";
import { failure } from "../../shared/errors/self-error.ts";
import type { PlannedMutationChange } from "./mutation-types.ts";

type ResourceSpec = {
  table: string;
  keys: string[];
  allowed: string[];
  updatedAt?: string;
};

const RESOURCE_SPECS: Record<string, ResourceSpec> = {
  source: spec("sources", ["source_id"], ["state", "deleted_at", "version", "spec_json"], true),
  connection: spec("data_connections", ["connection_id"], ["state", "revision"], true),
  document: spec("knowledge_documents", ["document_id"], ["state", "deleted_at", "version"], true),
  chunk: spec("knowledge_chunks", ["chunk_id"], ["state", "tombstoned_at"], true),
  note: spec(
    "knowledge_notes",
    ["note_id"],
    ["state", "deleted_at", "version", "relative_path"],
    true,
  ),
  graph_node: spec("graph_nodes", ["node_id"], ["status", "deleted_at", "version"], true),
  entity: spec("graph_entities", ["entity_id"], ["status", "version", "user_confirmed"], true),
  relation: spec("graph_relations", ["relation_id"], ["status", "deleted_at", "version"], true),
  claim: spec("graph_claims", ["claim_id"], ["status", "deleted_at", "version"], true),
  claim_evidence: spec("graph_claim_evidence", ["claim_id", "evidence_id"], ["state"]),
  relation_evidence: spec("graph_relation_evidence", ["relation_id", "evidence_id"], ["state"]),
  evidence_context: spec(
    "evidence_contexts",
    ["context_id"],
    ["state", "stale_at", "stale_reason"],
  ),
  answer: spec("answer_runs", ["answer_id"], ["cache_state", "stale_at", "stale_reason"]),
  topic: spec(
    "topics",
    ["topic_id"],
    ["status", "deleted_at", "version", "stale_reason", "stale_at"],
    true,
  ),
  artifact: spec(
    "artifacts",
    ["artifact_id"],
    ["status", "deleted_at", "version", "stale_reason"],
    true,
  ),
};

export function applyMutationChanges(
  database: Database,
  planned: PlannedMutationChange[],
  now: string,
): OperationChange[] {
  return planned.map((change) => applyOne(database, change, now));
}

export function verifyMutationChanges(database: Database, planned: PlannedMutationChange[]): void {
  for (const change of planned) {
    const spec = requireSpec(change.resource_kind);
    const current = readCurrent(database, spec, change.selector, Object.keys(change.before));
    assertExpected(change, current);
  }
}

export function reverseOperationChanges(rows: Record<string, unknown>[]): PlannedMutationChange[] {
  return rows.map((row) => {
    const resourceKind = String(row.resource_kind);
    const resourceId = String(row.resource_id);
    const before = object(row.before_json);
    const after = object(row.after_json);
    const selector = selectorFor(resourceKind, resourceId);
    const next: Record<string, unknown> = { ...before };
    const currentVersion = numeric(after.version ?? after.revision ?? after.config_version);
    if (currentVersion !== null) {
      if ("version" in after) next.version = currentVersion + 1;
      else if ("revision" in after) next.revision = currentVersion + 1;
      else next.config_version = currentVersion + 1;
    }
    return {
      resource_id: resourceId,
      resource_kind: resourceKind,
      change_kind: `undo_${String(row.change_kind)}`,
      selector,
      before: after,
      after: next,
    };
  });
}

function applyOne(database: Database, change: PlannedMutationChange, now: string): OperationChange {
  const spec = requireSpec(change.resource_kind);
  const current = readCurrent(database, spec, change.selector, Object.keys(change.before));
  assertExpected(change, current);
  const after = materialize(change.after, now);
  const entries = Object.entries(after);
  for (const [column] of entries) {
    if (!spec.allowed.includes(column))
      throw failure(
        "plan_change_invalid",
        `Plan cannot modify ${change.resource_kind}.${column}`,
        "state",
      );
  }
  const assignments = entries.map(([column]) => `${column} = ?`);
  const values = entries.map(([column, value]) => databaseValue(column, value));
  if (spec.updatedAt) {
    assignments.push(`${spec.updatedAt} = ?`);
    values.push(now);
  }
  const where = spec.keys.map((key) => `${key} = ?`).join(" AND ");
  const selectorValues = spec.keys.map((key) => change.selector[key] ?? "");
  const result = database
    .prepare(`UPDATE ${spec.table} SET ${assignments.join(", ")} WHERE ${where}`)
    .run(...values, ...selectorValues);
  if (result.changes !== 1)
    throw failure("plan_conflict", "Plan target changed or disappeared", "conflict");
  return {
    resourceId: change.resource_id,
    resourceKind: change.resource_kind,
    changeKind: change.change_kind,
    versionBefore: numeric(change.before.version ?? change.before.revision),
    versionAfter: numeric(after.version ?? after.revision),
    before: current,
    after,
    inverse: { ...current },
  };
}

function readCurrent(
  database: Database,
  spec: ResourceSpec,
  selector: Record<string, string>,
  columns: string[],
) {
  const selected = [...new Set(columns)];
  for (const column of selected) {
    if (!spec.allowed.includes(column))
      throw failure("plan_change_invalid", "Plan contains an unsupported precondition", "state");
  }
  for (const key of spec.keys) {
    if (!selector[key])
      throw failure("plan_change_invalid", "Plan selector is incomplete", "state");
  }
  const where = spec.keys.map((key) => `${key} = ?`).join(" AND ");
  const values = spec.keys.map((key) => selector[key] ?? "");
  const row = database
    .query<Record<string, unknown>, SQLQueryBindings[]>(
      `SELECT ${selected.join(", ")} FROM ${spec.table} WHERE ${where}`,
    )
    .get(...values);
  if (!row) throw failure("plan_conflict", "Plan target no longer exists", "conflict");
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      key.endsWith("_json") && typeof value === "string" ? JSON.parse(value) : value,
    ]),
  );
}

function assertExpected(change: PlannedMutationChange, current: Record<string, unknown>) {
  if (canonicalAutomationJson(current) !== canonicalAutomationJson(change.before)) {
    throw failure(
      "plan_conflict",
      "Plan precondition no longer matches current state",
      "conflict",
      {
        details: {
          resource_id: change.resource_id,
          expected: change.before,
          actual: current,
        },
      },
    );
  }
}

function selectorFor(kind: string, resourceId: string): Record<string, string> {
  const spec = requireSpec(kind);
  if (spec.keys.length === 1) return { [spec.keys[0] as string]: resourceId };
  const values = resourceId.split("::");
  if (values.length !== spec.keys.length)
    throw failure("operation_undo_invalid", "Operation change selector is invalid", "state");
  return Object.fromEntries(spec.keys.map((key, index) => [key, values[index] ?? ""]));
}

function requireSpec(kind: string): ResourceSpec {
  const spec = RESOURCE_SPECS[kind];
  if (!spec) throw failure("plan_change_invalid", `Unsupported resource kind: ${kind}`, "state");
  return spec;
}

function materialize(value: Record<string, unknown>, now: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, item === "$now" ? now : item]),
  );
}

function databaseValue(column: string, value: unknown): SQLQueryBindings {
  if (column.endsWith("_json") && value !== null && typeof value !== "string") {
    return JSON.stringify(value);
  }
  if (value === undefined) return null;
  return value as SQLQueryBindings;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return JSON.parse(value) as Record<string, unknown>;
  if (value && typeof value === "object") return value as Record<string, unknown>;
  return {};
}

function numeric(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function spec(table: string, keys: string[], allowed: string[], updatedAt = false): ResourceSpec {
  return { table, keys, allowed, ...(updatedAt ? { updatedAt: "updated_at" } : {}) };
}
