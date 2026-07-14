import { z } from "zod";
import { ENTITY_TYPES } from "../../domains/graph/index.ts";
import { atomicWrite } from "../../infrastructure/filesystem/atomic-write.ts";
import { sha256Text } from "../../infrastructure/filesystem/hash.ts";
import { writableGraphDatabase } from "../../infrastructure/graph/graph-db.ts";
import {
  activateGeneration,
  activeGeneration,
  ensureNode,
  ensureRelation,
} from "../../infrastructure/graph/graph-generation-repository.ts";
import { invalidateAnswers } from "../../infrastructure/retrieval/evidence-repository.ts";
import { invalidateTopics } from "../../infrastructure/topic/topic-invalidation.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import { initPlanPath } from "../workspace/init-plan.ts";

const planSchema = z.object({
  plan_id: z.string().startsWith("plan:plan_"),
  kind: z.literal("graph.mutation"),
  action: z.enum(["entity_create", "entity_merge", "relation_create", "generation_activate"]),
  root: z.string(),
  request_id: z.string().startsWith("req_"),
  operation_id: z.string().startsWith("operation:op_"),
  input: z.record(z.string(), z.unknown()),
  preconditions: z.record(z.string(), z.unknown()),
  impact: z.record(z.string(), z.unknown()),
  created_at: z.string().datetime(),
  expires_at: z.string().datetime(),
});

export async function createGraphPlan(
  root: string,
  action: z.infer<typeof planSchema>["action"],
  input: Record<string, unknown>,
  requestId: string,
) {
  const database = await writableGraphDatabase(root);
  let preconditions: Record<string, unknown> = {};
  let impact: Record<string, unknown> = {};
  try {
    if (action === "entity_merge") {
      const source = entityRow(database, String(input.source_entity_id));
      const target = entityRow(database, String(input.target_entity_id));
      if (source.entity_type !== target.entity_type)
        throw failure("entity_merge_conflict", "Entity types differ", "conflict");
      if (source.entity_id === target.entity_id)
        throw failure("entity_merge_conflict", "Entity cannot merge into itself", "conflict");
      preconditions = { source_version: source.version, target_version: target.version };
      impact = mergeImpact(database, source.node_id, target.node_id, source.entity_id);
    } else if (action === "relation_create") {
      const generation = activeGeneration(database);
      if (!generation)
        throw failure("graph_generation_not_found", "No active Graph Generation", "state");
      const subject = resolveGraphNode(database, String(input.subject_id));
      const object = resolveGraphNode(database, String(input.object_id));
      validateRelationPlan(
        database,
        subject,
        String(input.predicate),
        object,
        input.evidence_chunk_id ? String(input.evidence_chunk_id) : null,
        input.user_asserted === true,
      );
      preconditions = { active_generation_id: generation };
      impact = { subject_node_id: subject, object_node_id: object, predicate: input.predicate };
    } else if (action === "generation_activate") {
      const generation = database
        .query<{ state: string }, [string]>(
          "SELECT state FROM graph_generations WHERE generation_id = ?",
        )
        .get(String(input.generation_id));
      if (!generation || !["ready", "superseded", "active"].includes(generation.state))
        throw failure(
          "graph_generation_incomplete",
          "Generation has not passed verification",
          "state",
        );
      preconditions = {
        generation_state: generation.state,
        current_active_generation_id: activeGeneration(database),
      };
      impact = { pointer_switch: true };
    } else if (action === "entity_create") {
      const name = String(input.name ?? "").trim();
      if (!name) throw failure("entity_input_invalid", "Entity name is required", "usage");
      if (!ENTITY_TYPES.includes(String(input.entity_type) as (typeof ENTITY_TYPES)[number]))
        throw failure("entity_input_invalid", "Entity type is not registered", "usage");
      impact = { creates_entity: true, name, entity_type: input.entity_type };
    }
  } finally {
    database.close();
  }
  const now = new Date();
  const plan = planSchema.parse({
    plan_id: createResourceId("plan"),
    kind: "graph.mutation",
    action,
    root,
    request_id: requestId,
    operation_id: createResourceId("operation"),
    input,
    preconditions,
    impact,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 15 * 60_000).toISOString(),
  });
  await atomicWrite(initPlanPath(root, plan.plan_id), `${JSON.stringify(plan, null, 2)}\n`);
  return plan;
}

export async function applyGraphPlan(root: string, planId: string) {
  const file = Bun.file(initPlanPath(root, planId));
  if (!(await file.exists()))
    throw failure("plan_not_found", "Graph Plan does not exist", "not_found");
  const parsed = planSchema.safeParse(JSON.parse(await file.text()));
  if (!parsed.success) throw failure("plan_not_found", "Graph Plan is invalid", "not_found");
  const plan = parsed.data;
  if (plan.root !== root || Date.parse(plan.expires_at) < Date.now())
    throw failure("plan_expired", "Graph Plan is stale or belongs to another Root", "conflict");
  const database = await writableGraphDatabase(root);
  try {
    const result = database.transaction(() => apply(database, plan))();
    invalidateAnswers(database, `graph_mutation:${plan.action}`);
    invalidateTopics(database, { reason: `graph_mutation:${plan.action}` });
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
        `graph.${plan.action}`,
        String(result.target_id),
        sha256Text(JSON.stringify(plan)),
        JSON.stringify(result),
        plan.created_at,
        now,
      );
    return { operation_id: plan.operation_id, ...result };
  } finally {
    database.close();
  }
}

function apply(
  database: Awaited<ReturnType<typeof writableGraphDatabase>>,
  plan: z.infer<typeof planSchema>,
): Record<string, unknown> {
  if (plan.action === "generation_activate") {
    const id = String(plan.input.generation_id);
    const row = database
      .query<{ state: string }, [string]>(
        "SELECT state FROM graph_generations WHERE generation_id = ?",
      )
      .get(id);
    if (!row || row.state !== plan.preconditions.generation_state)
      throw failure("graph_version_conflict", "Generation changed after Plan creation", "conflict");
    activateGeneration(database, id);
    return { target_id: id, generation_id: id, state: "active" };
  }
  const generationId = activeGeneration(database);
  if (!generationId)
    throw failure("graph_generation_not_found", "No active Graph Generation", "state");
  if (plan.action === "entity_create") {
    const entityId = createResourceId("entity");
    const name = String(plan.input.name);
    const entityType = String(plan.input.entity_type);
    const now = new Date().toISOString();
    const nodeId = ensureNode(database, generationId, {
      kind: "entity",
      externalRef: entityId,
      label: name,
      sourceKind: "user",
      properties: { entity_type: entityType },
    });
    database
      .prepare(
        `INSERT INTO graph_entities(entity_id, node_id, entity_type, canonical_name, normalized_name,
       description, identity_key, status, origin, user_confirmed, created_at, updated_at)
       VALUES (?, ?, ?, ?, lower(?), ?, ?, 'active', 'user', 1, ?, ?)`,
      )
      .run(
        entityId,
        nodeId,
        entityType,
        name,
        name,
        optionalString(plan.input.description),
        optionalString(plan.input.identity_key),
        now,
        now,
      );
    return { target_id: entityId, entity_id: entityId, node_id: nodeId, status: "active" };
  }
  if (plan.action === "relation_create") {
    if (activeGeneration(database) !== plan.preconditions.active_generation_id)
      throw failure(
        "graph_version_conflict",
        "Active Generation changed after Plan creation",
        "conflict",
      );
    const subject = resolveGraphNode(database, String(plan.input.subject_id));
    const object = resolveGraphNode(database, String(plan.input.object_id));
    const evidence = plan.input.evidence_chunk_id ? String(plan.input.evidence_chunk_id) : null;
    validateRelationPlan(
      database,
      subject,
      String(plan.input.predicate),
      object,
      evidence,
      plan.input.user_asserted === true,
    );
    const relationId = ensureRelation(database, generationId, {
      subjectNodeId: subject,
      predicate: String(plan.input.predicate),
      objectNodeId: object,
      origin: "user",
      status: "accepted",
      confidenceLevel: plan.input.user_asserted === true && !evidence ? "medium" : "high",
      confidence: { user_asserted: plan.input.user_asserted === true },
    });
    if (evidence) addUserRelationEvidence(database, relationId, evidence);
    return { target_id: relationId, relation_id: relationId, status: "accepted" };
  }
  const source = entityRow(database, String(plan.input.source_entity_id));
  const target = entityRow(database, String(plan.input.target_entity_id));
  if (
    source.version !== plan.preconditions.source_version ||
    target.version !== plan.preconditions.target_version
  )
    throw failure("graph_version_conflict", "Entity changed after Plan creation", "conflict");
  if (redirectWouldCycle(database, source.entity_id, target.entity_id))
    throw failure(
      "entity_redirect_cycle",
      "Entity merge would create a Redirect cycle",
      "conflict",
    );
  const now = new Date().toISOString();
  const aliases = database
    .query<Record<string, unknown>, [string]>(
      "SELECT * FROM graph_entity_aliases WHERE entity_id = ?",
    )
    .all(source.entity_id);
  for (const alias of aliases)
    database
      .prepare(
        `INSERT OR IGNORE INTO graph_entity_aliases(alias_id, entity_id, alias, normalized_alias, language,
     scope, evidence_chunk_id, origin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        createResourceId("evidence"),
        target.entity_id,
        String(alias.alias),
        String(alias.normalized_alias),
        optionalString(alias.language),
        String(alias.scope ?? ""),
        optionalString(alias.evidence_chunk_id),
        String(alias.origin),
        String(alias.created_at),
      );
  database
    .prepare(
      "INSERT INTO graph_entity_redirects(source_entity_id, target_entity_id, operation_id, reason, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      source.entity_id,
      target.entity_id,
      plan.operation_id,
      String(plan.input.reason ?? "user merge"),
      now,
    );
  database
    .prepare(
      "UPDATE graph_entities SET status = 'redirected', version = version + 1, updated_at = ? WHERE entity_id = ?",
    )
    .run(now, source.entity_id);
  database
    .prepare(
      "UPDATE graph_nodes SET status = 'redirected', version = version + 1, updated_at = ? WHERE node_id = ?",
    )
    .run(now, source.node_id);
  database
    .prepare("UPDATE graph_entities SET version = version + 1, updated_at = ? WHERE entity_id = ?")
    .run(now, target.entity_id);
  return {
    target_id: target.entity_id,
    source_entity_id: source.entity_id,
    target_entity_id: target.entity_id,
    redirect_created: true,
    impact: plan.impact,
  };
}

function entityRow(database: Awaited<ReturnType<typeof writableGraphDatabase>>, id: string) {
  const row = database
    .query<
      { entity_id: string; node_id: string; entity_type: string; status: string; version: number },
      [string]
    >(
      "SELECT entity_id, node_id, entity_type, status, version FROM graph_entities WHERE entity_id = ?",
    )
    .get(id);
  if (!row) throw failure("entity_not_found", "Entity does not exist", "not_found");
  if (["deleted", "redirected"].includes(row.status))
    throw failure("entity_merge_conflict", "Entity is not mergeable", "conflict");
  return row;
}

function resolveGraphNode(
  database: Awaited<ReturnType<typeof writableGraphDatabase>>,
  id: string,
): string {
  const node =
    database
      .query<{ node_id: string }, [string, string]>(
        "SELECT node_id FROM graph_nodes WHERE node_id = ? OR external_ref_id = ? LIMIT 1",
      )
      .get(id, id) ??
    database
      .query<{ node_id: string }, [string]>(
        "SELECT node_id FROM graph_entities WHERE entity_id = ?",
      )
      .get(id) ??
    database
      .query<{ node_id: string }, [string]>("SELECT node_id FROM graph_claims WHERE claim_id = ?")
      .get(id);
  if (!node) throw failure("graph_node_not_found", `Graph node does not exist: ${id}`, "not_found");
  return node.node_id;
}

function optionalString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function validateRelationPlan(
  database: Awaited<ReturnType<typeof writableGraphDatabase>>,
  subject: string,
  predicate: string,
  object: string,
  evidence: string | null,
  userAsserted: boolean,
) {
  const definition = database
    .query<
      { subject_kinds_json: string; object_kinds_json: string; evidence_required: number },
      [string]
    >(
      "SELECT subject_kinds_json, object_kinds_json, evidence_required FROM graph_predicates WHERE predicate_key = ? AND status = 'active'",
    )
    .get(predicate);
  if (!definition) throw failure("unknown_predicate", `Unknown Predicate: ${predicate}`, "state");
  const subjectKind = database
    .query<{ node_kind: string }, [string]>("SELECT node_kind FROM graph_nodes WHERE node_id = ?")
    .get(subject)?.node_kind;
  const objectKind = database
    .query<{ node_kind: string }, [string]>("SELECT node_kind FROM graph_nodes WHERE node_id = ?")
    .get(object)?.node_kind;
  if (
    !(JSON.parse(definition.subject_kinds_json) as string[]).includes(subjectKind ?? "") ||
    !(JSON.parse(definition.object_kinds_json) as string[]).includes(objectKind ?? "")
  )
    throw failure("predicate_domain_mismatch", "Predicate Domain/Range mismatch", "state");
  if (definition.evidence_required === 1 && !evidence && !userAsserted)
    throw failure(
      "evidence_required",
      "Relation needs a Chunk Evidence or --user-asserted",
      "state",
    );
  if (
    evidence &&
    !database.query("SELECT chunk_id FROM knowledge_chunks WHERE chunk_id = ?").get(evidence)
  )
    throw failure("chunk_not_found", "Evidence Chunk does not exist", "not_found");
}

function addUserRelationEvidence(
  database: Awaited<ReturnType<typeof writableGraphDatabase>>,
  relationId: string,
  chunkId: string,
) {
  const row = database
    .query<
      {
        revision_id: string;
        content_hash: string;
        source_start_line: number | null;
        source_end_line: number | null;
      },
      [string]
    >(
      `SELECT rc.revision_id, c.content_hash, rc.source_start_line, rc.source_end_line FROM knowledge_chunks c
     JOIN knowledge_documents d ON d.document_id = c.document_id JOIN knowledge_revision_chunks rc
     ON rc.chunk_id = c.chunk_id AND rc.revision_id = d.current_revision_id WHERE c.chunk_id = ?`,
    )
    .get(chunkId);
  if (!row) throw failure("chunk_not_found", "Evidence Chunk is not active", "not_found");
  database
    .prepare(
      `INSERT INTO graph_relation_evidence(relation_id, evidence_id, evidence_kind, chunk_id,
     revision_id, role, directness, locator_json, excerpt_hash, state, created_at)
     VALUES (?, ?, 'chunk', ?, ?, 'support', 'direct', ?, ?, 'active', ?)`,
    )
    .run(
      relationId,
      createResourceId("evidence"),
      chunkId,
      row.revision_id,
      JSON.stringify({ start_line: row.source_start_line, end_line: row.source_end_line }),
      row.content_hash,
      new Date().toISOString(),
    );
}

function mergeImpact(
  database: Awaited<ReturnType<typeof writableGraphDatabase>>,
  sourceNode: string,
  targetNode: string,
  sourceEntity: string,
) {
  return {
    aliases:
      database
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) count FROM graph_entity_aliases WHERE entity_id = ?",
        )
        .get(sourceEntity)?.count ?? 0,
    relations:
      database
        .query<{ count: number }, [string, string]>(
          "SELECT COUNT(*) count FROM graph_relations WHERE subject_node_id = ? OR object_node_id = ?",
        )
        .get(sourceNode, sourceNode)?.count ?? 0,
    claims:
      database
        .query<{ count: number }, [string, string]>(
          "SELECT COUNT(*) count FROM graph_claims WHERE subject_node_id = ? OR object_node_id = ?",
        )
        .get(sourceNode, sourceNode)?.count ?? 0,
    target_node_id: targetNode,
  };
}

function redirectWouldCycle(
  database: Awaited<ReturnType<typeof writableGraphDatabase>>,
  source: string,
  target: string,
): boolean {
  if (source === target) return true;
  let current: string | undefined = target;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    if (current === source) return true;
    visited.add(current);
    current = database
      .query<{ target_entity_id: string }, [string]>(
        "SELECT target_entity_id FROM graph_entity_redirects WHERE source_entity_id = ?",
      )
      .get(current)?.target_entity_id;
  }
  return false;
}
