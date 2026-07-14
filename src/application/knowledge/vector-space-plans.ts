import { z } from "zod";
import { atomicWrite } from "../../infrastructure/filesystem/atomic-write.ts";
import { sha256Text } from "../../infrastructure/filesystem/hash.ts";
import { vectorTableName } from "../../infrastructure/knowledge/vector-index.ts";
import {
  activeVectorSpaceId,
  createVectorSpaceRecord,
  getSpace,
  vectorCoverage,
} from "../../infrastructure/knowledge/vector-space-repository.ts";
import { writableModelDatabase } from "../../infrastructure/model/model-db.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import { initPlanPath } from "../workspace/init-plan.ts";

const planSchema = z.object({
  plan_id: z.string().startsWith("plan:plan_"),
  kind: z.literal("knowledge.vector-space"),
  action: z.enum(["create", "activate", "migrate", "delete"]),
  root: z.string(),
  request_id: z.string().startsWith("req_"),
  operation_id: z.string().startsWith("operation:op_"),
  vector_space_id: z.string().nullable(),
  vector_space_version: z.number().int().positive().nullable(),
  from_vector_space_id: z.string().nullable(),
  model_id: z.string().nullable(),
  dimensions: z.number().int().positive().nullable(),
  query_instruction_id: z.string().nullable(),
  created_at: z.string().datetime(),
  expires_at: z.string().datetime(),
});

type PlanInput =
  | { action: "create"; modelId: string; dimensions: number; queryInstructionId: string }
  | { action: "activate" | "delete"; vectorSpaceId: string; vectorSpaceVersion: number }
  | {
      action: "migrate";
      fromVectorSpaceId: string;
      modelId: string;
      dimensions: number;
      queryInstructionId: string;
    };

export async function createVectorSpacePlan(root: string, input: PlanInput, requestId: string) {
  const now = new Date();
  const plan = planSchema.parse({
    plan_id: createResourceId("plan"),
    kind: "knowledge.vector-space",
    action: input.action,
    root,
    request_id: requestId,
    operation_id: createResourceId("operation"),
    vector_space_id:
      input.action === "activate" || input.action === "delete" ? input.vectorSpaceId : null,
    vector_space_version:
      input.action === "activate" || input.action === "delete" ? input.vectorSpaceVersion : null,
    from_vector_space_id: input.action === "migrate" ? input.fromVectorSpaceId : null,
    model_id: input.action === "create" || input.action === "migrate" ? input.modelId : null,
    dimensions: input.action === "create" || input.action === "migrate" ? input.dimensions : null,
    query_instruction_id:
      input.action === "create" || input.action === "migrate" ? input.queryInstructionId : null,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 15 * 60_000).toISOString(),
  });
  await atomicWrite(initPlanPath(root, plan.plan_id), `${JSON.stringify(plan, null, 2)}\n`);
  return plan;
}

export async function applyVectorSpacePlan(root: string, planId: string) {
  const file = Bun.file(initPlanPath(root, planId));
  if (!(await file.exists()))
    throw failure("plan_not_found", "VectorSpace Plan does not exist", "not_found");
  const parsed = planSchema.safeParse(JSON.parse(await file.text()));
  if (!parsed.success) throw failure("plan_not_found", "VectorSpace Plan is invalid", "not_found");
  const plan = parsed.data;
  if (plan.root !== root || Date.parse(plan.expires_at) < Date.now())
    throw failure(
      "plan_expired",
      "VectorSpace Plan is stale or belongs to another Root",
      "conflict",
    );
  if (plan.action === "create" || plan.action === "migrate") {
    if (!plan.model_id || !plan.dimensions || !plan.query_instruction_id)
      throw failure("plan_not_found", "VectorSpace create Plan is incomplete", "not_found");
    const created = await createVectorSpaceRecord(root, {
      modelId: plan.model_id,
      dimensions: plan.dimensions,
      queryInstructionId: plan.query_instruction_id,
    });
    await recordOperation(root, plan, created.vector_space_id, created);
    return {
      operation_id: plan.operation_id,
      ...created,
      migrated_from: plan.from_vector_space_id,
    };
  }
  if (!plan.vector_space_id || !plan.vector_space_version)
    throw failure("plan_not_found", "VectorSpace Plan target is incomplete", "not_found");
  const database = await writableModelDatabase(root);
  try {
    const space = getSpace(database, plan.vector_space_id);
    if (space.version !== plan.vector_space_version)
      throw failure(
        "vector_space_plan_conflict",
        "VectorSpace changed after Plan creation",
        "conflict",
      );
    const now = new Date().toISOString();
    if (plan.action === "activate") {
      const coverage = vectorCoverage(database, space);
      if (
        !["ready", "deprecated"].includes(space.state) ||
        coverage.expected === 0 ||
        coverage.covered !== coverage.expected
      )
        throw failure(
          "vector_space_not_ready",
          "VectorSpace has not passed activation coverage",
          "state",
          {
            details: coverage,
          },
        );
      database.transaction(() => {
        const previous = activeVectorSpaceId(database);
        if (previous && previous !== space.vector_space_id)
          database
            .prepare(
              `UPDATE vector_spaces SET state = 'deprecated', deprecated_at = ?, updated_at = ?,
               version = version + 1 WHERE vector_space_id = ?`,
            )
            .run(now, now, previous);
        database
          .prepare(
            `UPDATE vector_spaces SET state = 'ready', deprecated_at = NULL, updated_at = ?,
             version = version + 1 WHERE vector_space_id = ?`,
          )
          .run(now, space.vector_space_id);
        database
          .prepare(
            `UPDATE knowledge_active_vector_space SET active_vector_space_id = ?,
             previous_vector_space_id = ?, activated_at = ?, updated_at = ? WHERE singleton_id = 1`,
          )
          .run(space.vector_space_id, previous, now, now);
      })();
      const result = { vector_space_id: space.vector_space_id, state: "ready", active: true };
      await recordOperationWithDatabase(database, plan, space.vector_space_id, result);
      return { operation_id: plan.operation_id, ...result };
    }
    if (activeVectorSpaceId(database) === space.vector_space_id)
      throw failure("vector_space_active", "Active VectorSpace cannot be deleted", "conflict");
    const table = vectorTableName(space.dimensions);
    database.transaction(() => {
      database.prepare(`DELETE FROM ${table} WHERE vector_space_id = ?`).run(space.vector_space_id);
      database
        .prepare("DELETE FROM retrieval_query_cache WHERE vector_space_id = ?")
        .run(space.vector_space_id);
      database
        .prepare("DELETE FROM knowledge_embeddings WHERE vector_space_id = ?")
        .run(space.vector_space_id);
      database
        .prepare(
          `UPDATE vector_spaces SET state = 'deleted', deleted_at = ?, updated_at = ?,
           version = version + 1 WHERE vector_space_id = ?`,
        )
        .run(now, now, space.vector_space_id);
    })();
    const result = { vector_space_id: space.vector_space_id, state: "deleted" };
    await recordOperationWithDatabase(database, plan, space.vector_space_id, result);
    return { operation_id: plan.operation_id, ...result };
  } finally {
    database.close();
  }
}

async function recordOperation(
  root: string,
  plan: z.infer<typeof planSchema>,
  targetId: string,
  result: Record<string, unknown>,
) {
  const database = await writableModelDatabase(root);
  try {
    await recordOperationWithDatabase(database, plan, targetId, result);
  } finally {
    database.close();
  }
}

async function recordOperationWithDatabase(
  database: Awaited<ReturnType<typeof writableModelDatabase>>,
  plan: z.infer<typeof planSchema>,
  targetId: string,
  result: Record<string, unknown>,
) {
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT OR REPLACE INTO operations(operation_id, request_id, kind, status, target_id,
       input_hash, result_json, created_at, completed_at)
       VALUES (?, ?, ?, 'succeeded', ?, ?, ?, ?, ?)`,
    )
    .run(
      plan.operation_id,
      plan.request_id,
      `vector-space.${plan.action}`,
      targetId,
      sha256Text(JSON.stringify(plan)),
      JSON.stringify(result),
      plan.created_at,
      now,
    );
}
