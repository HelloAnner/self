import type { Database } from "bun:sqlite";
import { canonicalJson, normalizeGraphLabel } from "../../domains/graph/index.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { sha256Text } from "../../shared/hash/sha256.ts";
import { createResourceId } from "../../shared/ids/id.ts";

export type GraphNodeInput = {
  kind: "source" | "document" | "revision" | "chunk" | "entity" | "claim" | "topic";
  externalRef?: string;
  sourceId?: string;
  label: string;
  status?: "proposed" | "active";
  sourceKind: "structural" | "explicit" | "user" | "model" | "rule";
  properties?: Record<string, unknown>;
};

export function createGeneration(
  database: Database,
  input: { kind: "incremental" | "full"; parentId?: string; modelId?: string },
): string {
  const generationId = createResourceId("generation");
  const now = new Date().toISOString();
  const watermark = graphInputWatermark(database);
  database
    .prepare(
      `INSERT INTO graph_generations(generation_id, generation_kind, state, parent_generation_id,
     input_watermark, predicate_version, extractor_version, model_route_snapshot, config_hash, started_at)
     VALUES (?, ?, 'building', ?, ?, '1', 'graph-extractor-v3', ?, ?, ?)`,
    )
    .run(
      generationId,
      input.kind,
      input.parentId ?? null,
      watermark,
      JSON.stringify(input.modelId ? { extract: input.modelId } : {}),
      sha256Text(`graph-extractor-v3\n${watermark}\n${input.modelId ?? "local"}`),
      now,
    );
  return generationId;
}

export function carryForwardStableGraph(
  database: Database,
  generationId: string,
  parentGenerationId: string,
): void {
  database
    .prepare(
      `INSERT OR IGNORE INTO graph_generation_nodes(generation_id, node_id)
     SELECT ?, n.node_id FROM graph_generation_nodes old JOIN graph_nodes n ON n.node_id = old.node_id
     WHERE old.generation_id = ? AND n.node_kind IN ('entity','claim','topic')
       AND n.status <> 'deleted'`,
    )
    .run(generationId, parentGenerationId);
  database
    .prepare(
      `INSERT OR IGNORE INTO graph_generation_claims(generation_id, claim_id)
     SELECT ?, c.claim_id FROM graph_generation_claims old JOIN graph_claims c ON c.claim_id = old.claim_id
     WHERE old.generation_id = ? AND c.status <> 'deleted'
       AND (c.status IN ('rejected','user_confirmed') OR c.origin = 'user' OR EXISTS (
         SELECT 1 FROM graph_claim_evidence e JOIN knowledge_chunks k ON k.chunk_id = e.chunk_id
         WHERE e.claim_id = c.claim_id AND e.state = 'active' AND k.state = 'active'
       ))`,
    )
    .run(generationId, parentGenerationId);
  database
    .prepare(
      `INSERT OR IGNORE INTO graph_generation_relations(generation_id, relation_id)
     SELECT ?, r.relation_id FROM graph_generation_relations old JOIN graph_relations r ON r.relation_id = old.relation_id
     WHERE old.generation_id = ? AND r.origin IN ('user','model','rule','parser')
       AND r.status NOT IN ('deprecated','deleted')
       AND (r.status = 'rejected' OR r.origin = 'user' OR EXISTS (
         SELECT 1 FROM graph_relation_evidence e LEFT JOIN knowledge_chunks k ON k.chunk_id = e.chunk_id
         WHERE e.relation_id = r.relation_id AND e.state = 'active' AND (e.chunk_id IS NULL OR k.state = 'active')
       ))`,
    )
    .run(generationId, parentGenerationId);
  const now = new Date().toISOString();
  database.exec(`
    UPDATE graph_claim_evidence SET state = 'stale' WHERE state = 'active'
      AND EXISTS (SELECT 1 FROM knowledge_chunks k WHERE k.chunk_id = graph_claim_evidence.chunk_id AND k.state <> 'active');
    UPDATE graph_relation_evidence SET state = 'stale' WHERE state = 'active' AND chunk_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM knowledge_chunks k WHERE k.chunk_id = graph_relation_evidence.chunk_id AND k.state <> 'active');
  `);
  database
    .prepare(
      `UPDATE graph_claims SET status = 'stale', updated_at = ? WHERE origin <> 'user'
     AND status NOT IN ('rejected','deleted','superseded') AND NOT EXISTS (
       SELECT 1 FROM graph_claim_evidence e WHERE e.claim_id = graph_claims.claim_id AND e.state = 'active'
     )`,
    )
    .run(now);
  database
    .prepare(
      `UPDATE graph_relations SET status = 'stale', updated_at = ? WHERE origin IN ('model','rule','parser')
     AND status NOT IN ('rejected','deleted','deprecated') AND NOT EXISTS (
       SELECT 1 FROM graph_relation_evidence e WHERE e.relation_id = graph_relations.relation_id AND e.state = 'active'
     )`,
    )
    .run(now);
}

export function ensureNode(
  database: Database,
  generationId: string,
  input: GraphNodeInput,
): string {
  const existing = input.externalRef
    ? database
        .query<{ node_id: string }, [string, string]>(
          "SELECT node_id FROM graph_nodes WHERE node_kind = ? AND external_ref_id = ? AND deleted_at IS NULL",
        )
        .get(input.kind, input.externalRef)
    : null;
  const nodeId = existing?.node_id ?? createResourceId("graph-node");
  const now = new Date().toISOString();
  if (!existing)
    database
      .prepare(
        `INSERT INTO graph_nodes(node_id, node_kind, external_ref_id, source_id, canonical_label,
       normalized_label, status, source_kind, properties_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        nodeId,
        input.kind,
        input.externalRef ?? null,
        input.sourceId ?? null,
        input.label,
        normalizeGraphLabel(input.label),
        input.status ?? "active",
        input.sourceKind,
        canonicalJson(input.properties ?? {}),
        now,
        now,
      );
  else
    database
      .prepare(
        `UPDATE graph_nodes SET canonical_label = ?, normalized_label = ?, source_id = COALESCE(?, source_id),
       properties_json = ?, updated_at = ? WHERE node_id = ?`,
      )
      .run(
        input.label,
        normalizeGraphLabel(input.label),
        input.sourceId ?? null,
        canonicalJson(input.properties ?? {}),
        now,
        nodeId,
      );
  database
    .prepare("INSERT OR IGNORE INTO graph_generation_nodes(generation_id, node_id) VALUES (?, ?)")
    .run(generationId, nodeId);
  return nodeId;
}

export function ensureRelation(
  database: Database,
  generationId: string,
  input: {
    subjectNodeId: string;
    predicate: string;
    objectNodeId: string;
    qualifiers?: Record<string, unknown>;
    origin: "structural" | "explicit_link" | "parser" | "user" | "model" | "rule";
    status: "proposed" | "accepted";
    confidenceLevel?: "high" | "medium" | "low" | "disputed" | "unknown";
    confidence?: Record<string, unknown>;
    claimId?: string;
    extractionRunId?: string;
  },
): string {
  const predicate = database
    .query<
      {
        subject_kinds_json: string;
        object_kinds_json: string;
        symmetric: number;
        evidence_required: number;
      },
      [string]
    >(
      "SELECT subject_kinds_json, object_kinds_json, symmetric, evidence_required FROM graph_predicates WHERE predicate_key = ? AND status = 'active'",
    )
    .get(input.predicate);
  if (!predicate)
    throw failure("unknown_predicate", `Unknown Predicate: ${input.predicate}`, "state");
  let subject = input.subjectNodeId;
  let object = input.objectNodeId;
  if (predicate.symmetric === 1 && subject.localeCompare(object) > 0)
    [subject, object] = [object, subject];
  validateDomain(
    database,
    subject,
    object,
    predicate.subject_kinds_json,
    predicate.object_kinds_json,
  );
  const qualifiersJson = canonicalJson(input.qualifiers ?? {});
  const qualifierHash = sha256Text(qualifiersJson);
  const existing = database
    .query<{ relation_id: string }, [string, string, string, string, string]>(
      `SELECT relation_id FROM graph_relations WHERE subject_node_id = ? AND predicate_key = ?
     AND object_node_id = ? AND qualifier_hash = ? AND origin = ? AND deleted_at IS NULL`,
    )
    .get(subject, input.predicate, object, qualifierHash, input.origin);
  const relationId = existing?.relation_id ?? createResourceId("relation");
  const now = new Date().toISOString();
  if (!existing)
    database
      .prepare(
        `INSERT INTO graph_relations(relation_id, subject_node_id, predicate_key, object_node_id,
       qualifier_hash, qualifiers_json, origin, status, confidence_level, confidence_json,
       claim_id, extraction_run_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        relationId,
        subject,
        input.predicate,
        object,
        qualifierHash,
        qualifiersJson,
        input.origin,
        input.status,
        input.confidenceLevel ?? (input.origin === "structural" ? "high" : "medium"),
        canonicalJson(input.confidence ?? {}),
        input.claimId ?? null,
        input.extractionRunId ?? null,
        now,
        now,
      );
  database
    .prepare(
      "INSERT OR IGNORE INTO graph_generation_relations(generation_id, relation_id) VALUES (?, ?)",
    )
    .run(generationId, relationId);
  return relationId;
}

export function activeGeneration(database: Database): string | null {
  return (
    database
      .query<{ id: string | null }, []>(
        "SELECT active_generation_id id FROM graph_active_generation WHERE singleton_id = 1",
      )
      .get()?.id ?? null
  );
}

export function verifyGeneration(database: Database, generationId: string) {
  const checks = {
    missing_nodes: scalar(
      database,
      `SELECT COUNT(*) count FROM graph_generation_nodes m LEFT JOIN graph_nodes n ON n.node_id = m.node_id WHERE m.generation_id = ? AND n.node_id IS NULL`,
      generationId,
    ),
    invalid_relation_nodes: scalar(
      database,
      `SELECT COUNT(*) count FROM graph_generation_relations m JOIN graph_relations r ON r.relation_id = m.relation_id LEFT JOIN graph_nodes s ON s.node_id = r.subject_node_id LEFT JOIN graph_nodes o ON o.node_id = r.object_node_id WHERE m.generation_id = ? AND (s.node_id IS NULL OR o.node_id IS NULL)`,
      generationId,
    ),
    machine_relations_without_evidence: scalar(
      database,
      `SELECT COUNT(*) count FROM graph_generation_relations m JOIN graph_relations r ON r.relation_id = m.relation_id JOIN graph_predicates p ON p.predicate_key = r.predicate_key LEFT JOIN graph_relation_evidence e ON e.relation_id = r.relation_id AND e.state = 'active' WHERE m.generation_id = ? AND p.evidence_required = 1 AND r.origin IN ('model','rule','parser','explicit_link') GROUP BY r.relation_id HAVING COUNT(e.evidence_id) = 0`,
      generationId,
    ),
    machine_claims_without_evidence: scalar(
      database,
      `SELECT COUNT(*) count FROM graph_generation_claims m JOIN graph_claims c ON c.claim_id = m.claim_id LEFT JOIN graph_claim_evidence e ON e.claim_id = c.claim_id AND e.state = 'active' WHERE m.generation_id = ? AND c.origin <> 'user' GROUP BY c.claim_id HAVING COUNT(e.evidence_id) = 0`,
      generationId,
    ),
    redirect_cycles: redirectCycleCount(database),
  };
  const failed = Object.entries(checks).filter(([, value]) => value > 0);
  return { status: failed.length === 0 ? ("pass" as const) : ("fail" as const), checks };
}

export function finalizeGeneration(database: Database, generationId: string): void {
  const counts = database
    .query<{ nodes: number; relations: number; claims: number }, [string, string, string]>(
      `SELECT
      (SELECT COUNT(*) FROM graph_generation_nodes WHERE generation_id = ?) nodes,
      (SELECT COUNT(*) FROM graph_generation_relations WHERE generation_id = ?) relations,
      (SELECT COUNT(*) FROM graph_generation_claims WHERE generation_id = ?) claims`,
    )
    .get(generationId, generationId, generationId);
  const verification = verifyGeneration(database, generationId);
  if (verification.status !== "pass") {
    database
      .prepare(
        "UPDATE graph_generations SET state = 'failed', failure_json = ?, completed_at = ? WHERE generation_id = ?",
      )
      .run(JSON.stringify(verification), new Date().toISOString(), generationId);
    throw failure("graph_generation_incomplete", "Graph Generation failed verification", "state", {
      details: verification,
    });
  }
  database
    .prepare(
      `UPDATE graph_generations SET state = 'ready', node_count = ?, relation_count = ?, claim_count = ?,
     completed_at = ? WHERE generation_id = ?`,
    )
    .run(
      counts?.nodes ?? 0,
      counts?.relations ?? 0,
      counts?.claims ?? 0,
      new Date().toISOString(),
      generationId,
    );
}

export function activateGeneration(database: Database, generationId: string): void {
  const row = database
    .query<{ state: string }, [string]>(
      "SELECT state FROM graph_generations WHERE generation_id = ?",
    )
    .get(generationId);
  if (!row)
    throw failure("graph_generation_not_found", "Graph Generation does not exist", "not_found");
  if (!["ready", "active", "superseded"].includes(row.state))
    throw failure(
      "graph_generation_incomplete",
      "Only a verified Generation can be activated",
      "state",
    );
  const previous = activeGeneration(database);
  const now = new Date().toISOString();
  database.transaction(() => {
    if (previous && previous !== generationId)
      database
        .prepare("UPDATE graph_generations SET state = 'superseded' WHERE generation_id = ?")
        .run(previous);
    database
      .prepare(
        "UPDATE graph_generations SET state = 'active', activated_at = ? WHERE generation_id = ?",
      )
      .run(now, generationId);
    database
      .prepare(
        "UPDATE graph_active_generation SET previous_generation_id = active_generation_id, active_generation_id = ?, updated_at = ? WHERE singleton_id = 1",
      )
      .run(generationId, now);
  })();
}

export function graphInputWatermark(database: Database): string {
  const rows = database
    .query<{ document_id: string; revision_id: string }, []>(
      `SELECT document_id, current_revision_id revision_id FROM knowledge_documents
     WHERE state = 'active' ORDER BY document_id`,
    )
    .all();
  return sha256Text(rows.map((row) => `${row.document_id}:${row.revision_id}`).join("\n"));
}

function validateDomain(
  database: Database,
  subject: string,
  object: string,
  subjectJson: string,
  objectJson: string,
) {
  const rows = database
    .query<{ node_id: string; node_kind: string }, [string, string]>(
      "SELECT node_id, node_kind FROM graph_nodes WHERE node_id IN (?, ?)",
    )
    .all(subject, object);
  const kinds = new Map(rows.map((row) => [row.node_id, row.node_kind]));
  if (
    !(JSON.parse(subjectJson) as string[]).includes(kinds.get(subject) ?? "") ||
    !(JSON.parse(objectJson) as string[]).includes(kinds.get(object) ?? "")
  )
    throw failure(
      "predicate_domain_mismatch",
      "Predicate Domain/Range does not accept these node kinds",
      "state",
    );
}

function scalar(database: Database, sql: string, value: string): number {
  const rows = database.query<{ count: number }, [string]>(sql).all(value);
  return rows.reduce((sum, row) => sum + row.count, 0);
}

function redirectCycleCount(database: Database): number {
  return (
    database
      .query<{ count: number }, []>(
        `WITH RECURSIVE walk(source, current, path, cycle) AS (
       SELECT source_entity_id, target_entity_id, '|' || source_entity_id || '|', 0 FROM graph_entity_redirects
       UNION ALL
       SELECT walk.source, r.target_entity_id, walk.path || r.source_entity_id || '|',
              instr(walk.path, '|' || r.target_entity_id || '|') > 0
       FROM walk JOIN graph_entity_redirects r ON r.source_entity_id = walk.current WHERE walk.cycle = 0
     ) SELECT COUNT(*) count FROM walk WHERE cycle = 1`,
      )
      .get()?.count ?? 0
  );
}
