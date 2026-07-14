import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type AutomationPlanManifest,
  automationInputHash,
} from "../../domains/automation/index.ts";
import {
  readableAutomationDatabase,
  writableAutomationDatabase,
} from "../../infrastructure/automation/automation-db.ts";
import {
  automationPlan,
  cancelAutomationPlan,
  findIdempotency,
  insertAutomationPlan,
  listAutomationPlans,
} from "../../infrastructure/automation/automation-repository.ts";
import { atomicWrite } from "../../infrastructure/filesystem/atomic-write.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import type { MutationDescription } from "./mutation-types.ts";
import { describeNoteMove } from "./note-move-plan.ts";
import {
  describeArtifactDelete,
  describeClaimDelete,
  describeConnectionDetach,
  describeEntityDelete,
  describeRelationDelete,
  describeTopicDelete,
} from "./resource-impact.ts";
import { describeNoteDelete, describeSourceDelete } from "./source-impact.ts";
import { describeSourcePurge } from "./source-purge-plan.ts";

export const MUTATION_ACTIONS = [
  "connection_detach",
  "source_delete",
  "source_purge",
  "note_move",
  "note_delete",
  "entity_delete",
  "relation_delete",
  "claim_delete",
  "topic_delete",
  "artifact_delete",
  "operation_undo",
] as const;

export type MutationAction = (typeof MUTATION_ACTIONS)[number];

export async function createSafetyPlan(
  root: string,
  input: {
    action: MutationAction;
    resourceId: string;
    values?: Record<string, unknown>;
    idempotencyKey?: string;
  },
  requestId: string,
) {
  validateIdempotencyKey(input.idempotencyKey);
  const normalizedInput = {
    action: input.action,
    resource_id: input.resourceId,
    values: input.values ?? {},
  };
  const inputHash = automationInputHash(normalizedInput);
  const commandKind = `automation.mutation:${input.action}`;
  const database = await writableAutomationDatabase(root);
  let plan: AutomationPlanManifest;
  try {
    const prior = findIdempotency(database, input.idempotencyKey, commandKind, inputHash);
    if (prior?.plan_id) return automationPlan(database, String(prior.plan_id));
    const description = await describe(
      database,
      root,
      input.action,
      input.resourceId,
      input.values ?? {},
    );
    const now = new Date();
    plan = {
      plan_id: createResourceId("plan"),
      kind: "automation.mutation",
      action: input.action,
      state: "ready",
      request_id: requestId,
      operation_id: createResourceId("operation"),
      resource_id: input.resourceId,
      idempotency_key: input.idempotencyKey ?? null,
      input_hash: inputHash,
      input: normalizedInput,
      preconditions: description.preconditions,
      impact: description.impact,
      changes: description.changes,
      inverse: description.inverse,
      reversible: description.reversible,
      atomicity: "atomic",
      targets: description.targets,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 15 * 60_000).toISOString(),
    };
    const relativePath = planRelativePath(plan.plan_id);
    await mkdir(join(root, "runtime/plans"), { recursive: true });
    await atomicWrite(join(root, relativePath), `${JSON.stringify(plan, null, 2)}\n`);
    insertAutomationPlan(database, plan, relativePath);
  } finally {
    database.close();
  }
  return plan;
}

export async function showPlan(root: string, planId: string) {
  const database = await readableAutomationDatabase(root);
  try {
    return automationPlan(database, planId);
  } finally {
    database.close();
  }
}

export async function listPlans(root: string, state?: string, limit = 100) {
  const database = await readableAutomationDatabase(root);
  try {
    return listAutomationPlans(database, state, limit);
  } finally {
    database.close();
  }
}

export async function diffPlan(root: string, planId: string) {
  const plan = await showPlan(root, planId);
  return {
    plan_id: plan.plan_id,
    state: plan.state,
    action: plan.action,
    resource_id: plan.resource_id,
    atomicity: plan.atomicity,
    reversible: plan.reversible,
    preconditions: plan.preconditions,
    impact: plan.impact,
    changes: plan.changes,
    inverse: plan.inverse,
  };
}

export async function cancelPlan(root: string, planId: string) {
  const database = await writableAutomationDatabase(root);
  try {
    return cancelAutomationPlan(database, planId, new Date().toISOString());
  } finally {
    database.close();
  }
}

export function planRelativePath(planId: string): string {
  return `runtime/plans/${planId.replace(":", "_")}.json`;
}

async function describe(
  database: Awaited<ReturnType<typeof writableAutomationDatabase>>,
  root: string,
  action: MutationAction,
  resourceId: string,
  values: Record<string, unknown>,
): Promise<MutationDescription> {
  if (action === "connection_detach") return describeConnectionDetach(database, resourceId);
  if (action === "source_delete") return describeSourceDelete(database, resourceId);
  if (action === "source_purge") return describeSourcePurge(database, resourceId);
  if (action === "note_delete") return describeNoteDelete(database, resourceId);
  if (action === "note_move") {
    const target = typeof values.to === "string" ? values.to : "";
    if (!target) throw failure("note_move_invalid", "Note move requires a target", "usage");
    return describeNoteMove(database, root, resourceId, target);
  }
  if (action === "entity_delete") return describeEntityDelete(database, resourceId);
  if (action === "relation_delete") return describeRelationDelete(database, resourceId);
  if (action === "claim_delete") return describeClaimDelete(database, resourceId);
  if (action === "topic_delete") return describeTopicDelete(database, resourceId);
  if (action === "artifact_delete") return describeArtifactDelete(database, resourceId);
  if (action === "operation_undo") {
    const { describeOperationUndo } = await import("./undo-workflows.ts");
    return describeOperationUndo(database, resourceId);
  }
  throw failure("plan_action_unsupported", "Mutation action is not supported", "state");
}

function validateIdempotencyKey(value?: string) {
  if (value === undefined) return;
  if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(value)) {
    throw failure(
      "idempotency_key_invalid",
      "Idempotency key must use 1-200 safe characters",
      "usage",
    );
  }
}
