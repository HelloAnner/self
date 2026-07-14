import { z } from "zod";
import { sha256Text } from "../../infrastructure/filesystem/hash.ts";
import {
  getSnapshotEntries,
  getSource,
  getSourceSnapshotSummary,
  listSources,
} from "../../infrastructure/source/source-reader.ts";
import { softDeleteSource } from "../../infrastructure/source/source-store.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { initPlanPath } from "../workspace/init-plan.ts";

const deletePlanSchema = z.object({
  plan_id: z.string().startsWith("plan:plan_"),
  kind: z.literal("source.delete"),
  source_id: z.string().startsWith("source:src_"),
  source_version: z.number().int().positive(),
  current_snapshot_id: z.string().nullable(),
  operation_id: z.string().startsWith("operation:op_"),
  request_id: z.string().startsWith("req_"),
  root: z.string(),
  created_at: z.string().datetime(),
  expires_at: z.string().datetime(),
});

export async function sourceList(root: string, state?: string) {
  return (await listSources(root, state)).map(sourceDto);
}

export async function sourceShow(root: string, sourceId: string) {
  const source = await getSource(root, sourceId);
  const snapshot = await getSourceSnapshotSummary(root, sourceId);
  return { ...sourceDto(source), spec: source.spec, snapshot };
}

export async function sourceFiles(root: string, sourceId: string, snapshotId?: string) {
  return getSnapshotEntries(root, sourceId, snapshotId);
}

export async function createSourceDeletePlan(
  root: string,
  sourceId: string,
  requestId: string,
  idempotencyKey?: string,
) {
  const { createSafetyPlan } = await import("../automation/plan-workflows.ts");
  return createSafetyPlan(
    root,
    {
      action: "source_delete",
      resourceId: sourceId,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
    requestId,
  );
}

export async function createSourcePurgePlan(
  root: string,
  sourceId: string,
  requestId: string,
  idempotencyKey?: string,
) {
  const { createSafetyPlan } = await import("../automation/plan-workflows.ts");
  return createSafetyPlan(
    root,
    {
      action: "source_purge",
      resourceId: sourceId,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
    requestId,
  );
}

export async function applySourceDeletePlan(root: string, planId: string) {
  const file = Bun.file(initPlanPath(root, planId));
  if (!(await file.exists()))
    throw failure("plan_not_found", "Source Delete Plan does not exist", "not_found");
  const parsed = deletePlanSchema.safeParse(JSON.parse(await file.text()));
  if (!parsed.success)
    throw failure("plan_not_found", "Source Delete Plan is invalid", "not_found");
  const plan = parsed.data;
  if (plan.root !== root || Date.parse(plan.expires_at) < Date.now()) {
    throw failure(
      "plan_expired",
      "Source Delete Plan is stale or belongs to another Root",
      "conflict",
    );
  }
  const source = await getSource(root, plan.source_id);
  if (source.current_snapshot_id !== plan.current_snapshot_id) {
    throw failure("source_plan_conflict", "Source Snapshot changed after Delete Plan", "conflict");
  }
  await softDeleteSource(
    root,
    plan.source_id,
    plan.source_version,
    operation(plan, "source.delete"),
  );
  return { operation_id: plan.operation_id, source_id: plan.source_id, state: "deleted" as const };
}

export async function restoreDeletedSource(
  root: string,
  sourceId: string,
  requestId: string,
  options: { ifVersion?: number; idempotencyKey?: string } = {},
) {
  const { restoreDeletedResource } = await import("../automation/restore-workflows.ts");
  return restoreDeletedResource(root, "source", sourceId, requestId, options);
}

function sourceDto(source: Awaited<ReturnType<typeof getSource>>) {
  return {
    source_id: source.source_id,
    name: source.name,
    kind: source.kind,
    mode: source.mode,
    state: source.state,
    archive_status: source.archive_status,
    ingestion_status: source.ingestion_status,
    current_snapshot_id: source.current_snapshot_id,
    current_ingestion_run_id: source.current_ingestion_run_id,
    version: source.version,
    last_error_code: source.last_error_code,
    created_at: source.created_at,
    updated_at: source.updated_at,
  };
}

function operation(plan: z.infer<typeof deletePlanSchema>, kind: string) {
  return {
    operationId: plan.operation_id,
    requestId: plan.request_id,
    kind,
    inputHash: sha256Text(
      JSON.stringify({ source_id: plan.source_id, version: plan.source_version }),
    ),
    now: new Date().toISOString(),
  };
}
