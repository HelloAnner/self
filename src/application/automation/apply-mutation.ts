import { mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AutomationPlanManifest } from "../../domains/automation/index.ts";
import { writableAutomationDatabase } from "../../infrastructure/automation/automation-db.ts";
import {
  automationPlan,
  completeAutomationOperation,
  markPlanExpired,
  operationView,
} from "../../infrastructure/automation/automation-repository.ts";
import { recordManagedWriteReceipt } from "../../infrastructure/connection/managed-write-repository.ts";
import { sha256File } from "../../infrastructure/filesystem/hash.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { applyMutationChanges, verifyMutationChanges } from "./mutation-store.ts";
import type { PlannedMutationChange } from "./mutation-types.ts";
import { describeNoteMove } from "./note-move-plan.ts";

export async function applyAutomationMutation(root: string, planId: string) {
  const database = await writableAutomationDatabase(root);
  let open = true;
  try {
    const plan = automationPlan(database, planId);
    if (plan.kind !== "automation.mutation")
      throw failure("plan_kind_unsupported", "Plan is not an Automation mutation", "state");
    if (plan.state === "applied") {
      const operation = operationView(database, plan.operation_id) as Record<string, unknown>;
      const result = operation.result_json;
      return {
        ...(result && typeof result === "object" ? (result as Record<string, unknown>) : operation),
        reused: true,
      };
    }
    if (plan.state !== "ready")
      throw failure("plan_state_invalid", "Plan is not ready to apply", "state");
    if (Date.parse(plan.expires_at) < Date.now()) {
      markPlanExpired(database, planId, new Date().toISOString());
      throw failure("plan_expired", "Plan expired before Apply", "conflict");
    }
    if (plan.action === "source_purge") {
      const { applySourcePurge } = await import("./source-purge-apply.ts");
      return await applySourcePurge(root, database, plan);
    }
    if (plan.action === "note_move") {
      database.close();
      open = false;
      return await applyNoteMove(root, plan);
    }
    if (plan.action === "operation_undo" && plan.preconditions.file_move) {
      database.close();
      open = false;
      return await applyNoteMoveUndo(root, plan);
    }
    return applyChanges(database, plan);
  } finally {
    if (open) database.close();
  }
}

function applyChanges(
  database: Awaited<ReturnType<typeof writableAutomationDatabase>>,
  plan: AutomationPlanManifest,
) {
  const planned = plan.changes as PlannedMutationChange[];
  verifyMutationChanges(database, planned);
  const now = new Date().toISOString();
  const result = database.transaction(() => {
    const changes = applyMutationChanges(database, planned, now);
    const output = operationResult(plan, changes);
    completeAutomationOperation(database, {
      plan,
      operationId: plan.operation_id,
      requestId: plan.request_id,
      kind: `${plan.action.replaceAll("_", ".")}`,
      targetId: plan.resource_id,
      inputHash: plan.input_hash,
      idempotencyKey: plan.idempotency_key,
      result: output,
      changes,
      reversible: plan.reversible,
      atomicity: plan.atomicity,
      ...(plan.action === "operation_undo"
        ? { undoOfOperationId: String(plan.input.resource_id) }
        : {}),
      createdAt: plan.created_at,
      completedAt: now,
    });
    return output;
  })();
  return result;
}

async function applyNoteMove(root: string, plan: AutomationPlanManifest) {
  const verification = await writableAutomationDatabase(root);
  const target = String((plan.input.values as Record<string, unknown> | undefined)?.to ?? "");
  let current: Awaited<ReturnType<typeof describeNoteMove>>;
  try {
    current = await describeNoteMove(verification, root, String(plan.resource_id), target);
  } finally {
    verification.close();
  }
  if (current.preconditions.impact_hash !== plan.preconditions.impact_hash)
    throw failure("note_move_conflict", "Note or target changed after Plan creation", "conflict");
  const from = String(plan.preconditions.old_relative_path);
  const to = String(plan.preconditions.new_relative_path);
  const source = resolve(root, from);
  const destination = resolve(root, to);
  if ((await sha256File(source)) !== plan.preconditions.file_hash)
    throw failure("note_move_conflict", "Note file changed after Plan creation", "conflict");
  await recordManagedWriteReceipt(root, {
    absolutePath: destination,
    expectedHash: String(plan.preconditions.file_hash),
    operationId: plan.operation_id,
  });
  await mkdir(dirname(destination), { recursive: true });
  await rename(source, destination);
  const database = await writableAutomationDatabase(root);
  try {
    return applyChanges(database, plan);
  } catch (cause) {
    await rename(destination, source);
    throw cause;
  } finally {
    database.close();
  }
}

async function applyNoteMoveUndo(root: string, plan: AutomationPlanManifest) {
  const file = plan.preconditions.file_move as Record<string, unknown>;
  const from = String(file.from ?? "");
  const to = String(file.to ?? "");
  const expectedHash = String(file.sha256 ?? "");
  if (!from || !to || !expectedHash) {
    throw failure("operation_undo_invalid", "Note move Undo has no file precondition", "state");
  }
  const source = resolve(root, from);
  const destination = resolve(root, to);
  if ((await sha256File(source).catch(() => null)) !== expectedHash) {
    throw failure(
      "operation_undo_conflict",
      "Moved Note file changed after the Operation",
      "conflict",
    );
  }
  if (await Bun.file(destination).exists()) {
    throw failure(
      "operation_undo_conflict",
      "Original Note path is no longer available",
      "conflict",
    );
  }
  await recordManagedWriteReceipt(root, {
    absolutePath: destination,
    expectedHash,
    operationId: plan.operation_id,
  });
  await mkdir(dirname(destination), { recursive: true });
  await rename(source, destination);
  const database = await writableAutomationDatabase(root);
  try {
    return applyChanges(database, plan);
  } catch (cause) {
    await rename(destination, source);
    throw cause;
  } finally {
    database.close();
  }
}

function operationResult(
  plan: AutomationPlanManifest,
  changes: ReturnType<typeof applyMutationChanges>,
) {
  const primary = changes.find((change) => change.resourceId === plan.resource_id) ?? changes[0];
  const state = primary?.after.state ?? primary?.after.status ?? primary?.after.cache_state;
  return {
    operation_id: plan.operation_id,
    plan_id: plan.plan_id,
    action: plan.action,
    resource_id: plan.resource_id,
    ...(typeof state === "string" ? { state } : {}),
    reversible: plan.reversible,
    atomicity: plan.atomicity,
    items: changes.map((change) => ({
      resource_id: change.resourceId,
      resource_kind: change.resourceKind,
      change_kind: change.changeKind,
      status: change.status ?? "succeeded",
      version_before: change.versionBefore ?? null,
      version_after: change.versionAfter ?? null,
    })),
  };
}
