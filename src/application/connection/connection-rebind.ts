import { z } from "zod";
import { rebindConnectionTarget } from "../../infrastructure/connection/connection-lifecycle-repository.ts";
import {
  getConnection,
  getConnectionTarget,
  listActiveTargets,
  listObservations,
} from "../../infrastructure/connection/connection-repository.ts";
import { buildInventory } from "../../infrastructure/connection/inventory.ts";
import { pathsOverlap, prepareConnectionTarget } from "../../infrastructure/connection/target.ts";
import { atomicWrite } from "../../infrastructure/filesystem/atomic-write.ts";
import { getSource } from "../../infrastructure/source/source-reader.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import { initPlanPath } from "../workspace/init-plan.ts";
import { scanConnection } from "./connection-scan.ts";

const planSchema = z.object({
  plan_id: z.string().startsWith("plan:plan_"),
  kind: z.literal("connection.rebind"),
  operation_id: z.string().startsWith("operation:op_"),
  request_id: z.string().startsWith("req_"),
  root: z.string(),
  connection_id: z.string().startsWith("connection:con_"),
  connection_revision: z.number().int().positive(),
  target_id: z.string().startsWith("target:ct_"),
  target_revision: z.number().int().positive(),
  old_path: z.string(),
  new_path: z.string(),
  new_identity_key: z.string().length(64),
  match_ratio: z.number().min(0).max(1),
  created_at: z.string().datetime(),
  expires_at: z.string().datetime(),
});

export async function createConnectionRebindPlan(
  root: string,
  connectionId: string,
  newPath: string,
  requestId: string,
) {
  const connection = await getConnection(root, connectionId);
  const current = await getConnectionTarget(root, connectionId);
  const target = await prepareConnectionTarget({
    root,
    input: newPath,
    kind: connection.kind,
    scope: current.location_scope,
    recursive: current.recursive,
  });
  await assertNoOverlap(root, connectionId, target.canonical_path);
  const observations = await listObservations(root, connectionId);
  const inventory = await buildInventory({
    target: { ...current, ...target },
    connectionKind: connection.kind,
    filters: connection.filter_policy,
    scanPolicy: { ...connection.scan_policy, write_settle_window_ms: 0 },
    previous: [],
    fullHash: true,
  });
  const knownHashes = new Set(
    observations.filter((item) => item.state === "active").map((item) => item.content_hash),
  );
  const matched = inventory.entries.filter((item) => knownHashes.has(item.content_hash)).length;
  const denominator = Math.max(knownHashes.size, inventory.entries.length, 1);
  const ratio = matched / denominator;
  if (knownHashes.size > 0 && ratio < 0.5) {
    throw failure(
      "connection_rebind_mismatch",
      "New Target fingerprint and content do not match",
      "state",
      {
        details: { match_ratio: ratio },
      },
    );
  }
  const now = new Date();
  const plan = planSchema.parse({
    plan_id: createResourceId("plan"),
    kind: "connection.rebind",
    operation_id: createResourceId("operation"),
    request_id: requestId,
    root,
    connection_id: connectionId,
    connection_revision: connection.revision,
    target_id: current.target_id,
    target_revision: current.revision,
    old_path: current.canonical_path,
    new_path: target.canonical_path,
    new_identity_key: target.target_identity_key,
    match_ratio: ratio,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 15 * 60_000).toISOString(),
  });
  await atomicWrite(initPlanPath(root, plan.plan_id), `${JSON.stringify(plan, null, 2)}\n`);
  return plan;
}

export async function applyConnectionRebindPlan(root: string, planId: string) {
  const file = Bun.file(initPlanPath(root, planId));
  if (!(await file.exists()))
    throw failure("plan_not_found", "Connection Rebind Plan does not exist", "not_found");
  const parsed = planSchema.safeParse(JSON.parse(await file.text()));
  if (!parsed.success)
    throw failure("plan_not_found", "Connection Rebind Plan is invalid", "not_found");
  const plan = parsed.data;
  if (plan.root !== root || Date.parse(plan.expires_at) < Date.now()) {
    throw failure(
      "plan_expired",
      "Connection Rebind Plan is stale or belongs to another Root",
      "conflict",
    );
  }
  const connection = await getConnection(root, plan.connection_id);
  const current = await getConnectionTarget(root, plan.connection_id);
  const target = await prepareConnectionTarget({
    root,
    input: plan.new_path,
    kind: connection.kind,
    scope: current.location_scope,
    recursive: current.recursive,
  });
  if (target.target_identity_key !== plan.new_identity_key) {
    throw failure("connection_rebind_mismatch", "New Target changed after Rebind Plan", "conflict");
  }
  await assertNoOverlap(root, plan.connection_id, target.canonical_path);
  const source = await getSource(root, connection.source_id);
  if (source.spec.locator_type !== "external_path") {
    throw failure("connection_rebind_mismatch", "Managed Sources cannot be rebound", "state");
  }
  await rebindConnectionTarget(root, {
    connectionId: plan.connection_id,
    connectionRevision: plan.connection_revision,
    targetId: plan.target_id,
    targetRevision: plan.target_revision,
    target,
    sourceId: source.source_id,
    sourceSpecJson: JSON.stringify({
      ...source.spec,
      locator: target.canonical_path,
      original_locator: plan.new_path,
    }),
    operationId: plan.operation_id,
    requestId: plan.request_id,
  });
  const scan = await scanConnection(
    root,
    plan.connection_id,
    { trigger: "manual", fullHash: true },
    plan.request_id,
  );
  return {
    operation_id: plan.operation_id,
    connection_id: plan.connection_id,
    state: "active" as const,
    scan,
  };
}

async function assertNoOverlap(root: string, connectionId: string, path: string): Promise<void> {
  const overlap = (await listActiveTargets(root)).find(
    (item) => item.connection_id !== connectionId && pathsOverlap(item.canonical_path, path),
  );
  if (overlap)
    throw failure(
      "connection_target_overlap",
      "Rebind Target overlaps another Connection",
      "conflict",
    );
}
