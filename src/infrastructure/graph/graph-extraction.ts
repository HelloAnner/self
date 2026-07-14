import type { Database } from "bun:sqlite";
import {
  assessConfidence,
  canonicalJson,
  type GraphExtraction,
  normalizeGraphLabel,
} from "../../domains/graph/index.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { sha256Text } from "../../shared/hash/sha256.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import { extractGraphFromChunk, GRAPH_PROMPT_SPEC_VERSION } from "../model/structured-provider.ts";
import { alignClaimsAndConfidence } from "./graph-claim-alignment.ts";
import { writableGraphDatabase } from "./graph-db.ts";
import {
  addAlias,
  addClaimEvidence,
  addRelationChunkEvidence,
  nodeForExternal,
  reuseChunkExtraction,
} from "./graph-extraction-evidence.ts";
import { ensureNode, ensureRelation } from "./graph-generation-repository.ts";

export type ChunkInput = {
  chunk_id: string;
  content_text: string;
  content_hash: string;
  revision_id: string;
  source_id: string;
  blob_sha256: string;
  source_start_line: number | null;
  source_end_line: number | null;
};

export async function extractGenerationClaims(
  root: string,
  generationId: string,
  input: { modelId: string; maxChunks?: number },
): Promise<{
  chunks_processed: number;
  chunks_reused: number;
  chunks_failed: number;
  failure_codes: string[];
  entities: number;
  claims: number;
}> {
  const initial = await writableGraphDatabase(root);
  const predicates = initial
    .query<{ predicate_key: string }, []>(
      `SELECT predicate_key FROM graph_predicates WHERE layer IN ('semantic','claim') AND status = 'active'
       AND subject_kinds_json LIKE '%"entity"%' AND object_kinds_json LIKE '%"entity"%'
       ORDER BY predicate_key`,
    )
    .all()
    .map((row) => row.predicate_key);
  const chunks = initial
    .query<ChunkInput, [number]>(
      `SELECT c.chunk_id, c.content_text, c.content_hash, r.revision_id, d.source_id, r.blob_sha256,
     rc.source_start_line, rc.source_end_line FROM knowledge_chunks c
     JOIN knowledge_documents d ON d.document_id = c.document_id
     JOIN knowledge_revisions r ON r.revision_id = d.current_revision_id
     JOIN knowledge_revision_chunks rc ON rc.revision_id = r.revision_id AND rc.chunk_id = c.chunk_id
     WHERE c.state = 'active' AND d.state = 'active' ORDER BY c.chunk_id LIMIT ?`,
    )
    .all(Math.min(10_000, Math.max(1, input.maxChunks ?? 10_000)));
  initial.close();
  let processed = 0;
  let reused = 0;
  let entityCount = 0;
  let claimCount = 0;
  let failed = 0;
  const failureCodes = new Set<string>();
  for (const chunk of chunks) {
    const inputHash = sha256Text(
      `${chunk.content_hash}\n${input.modelId}\n${GRAPH_PROMPT_SPEC_VERSION}`,
    );
    const check = await writableGraphDatabase(root);
    const existing = check
      .query<
        { extraction_run_id: string; state: string; input_chunk_id: string | null },
        [string, string]
      >(
        `SELECT extraction_run_id, state, input_chunk_id FROM graph_extraction_runs
       WHERE run_kind = 'entity_claim' AND input_hash = ? AND model_id = ? AND schema_version = '1'`,
      )
      .get(inputHash, input.modelId);
    if (existing?.state === "succeeded") {
      reuseChunkExtraction(check, generationId, existing.input_chunk_id ?? chunk.chunk_id, chunk);
      check.close();
      reused += 1;
      continue;
    }
    check.close();
    const extractionRunId = existing?.extraction_run_id ?? createResourceId("extraction");
    if (!existing) {
      const db = await writableGraphDatabase(root);
      try {
        db.prepare(
          `INSERT INTO graph_extraction_runs(extraction_run_id, generation_id, run_kind, state,
           input_revision_id, input_chunk_id, model_id, prompt_spec_version, schema_version,
           input_hash, started_at) VALUES (?, ?, 'entity_claim', 'running', ?, ?, ?, ?, '1', ?, ?)`,
        ).run(
          extractionRunId,
          generationId,
          chunk.revision_id,
          chunk.chunk_id,
          input.modelId,
          GRAPH_PROMPT_SPEC_VERSION,
          inputHash,
          new Date().toISOString(),
        );
      } finally {
        db.close();
      }
    }
    try {
      const result = await extractGraphFromChunk(root, {
        modelId: input.modelId,
        content: chunk.content_text,
        allowedPredicates: predicates,
      });
      const db = await writableGraphDatabase(root);
      try {
        db.transaction(() =>
          publishExtraction(db, generationId, extractionRunId, chunk, result.extraction),
        )();
        db.prepare(
          `UPDATE graph_extraction_runs SET state = 'succeeded', output_hash = ?, completed_at = ?
           WHERE extraction_run_id = ?`,
        ).run(
          sha256Text(canonicalJson(result.extraction as unknown as Record<string, unknown>)),
          new Date().toISOString(),
          extractionRunId,
        );
      } finally {
        db.close();
      }
      processed += 1;
      entityCount += result.extraction.entities.length;
      claimCount += result.extraction.claims.length;
    } catch (cause) {
      const db = await writableGraphDatabase(root);
      try {
        db.prepare(
          "UPDATE graph_extraction_runs SET state = 'failed', error_json = ?, completed_at = ? WHERE extraction_run_id = ?",
        ).run(
          JSON.stringify({ code: errorCode(cause) }),
          new Date().toISOString(),
          extractionRunId,
        );
      } finally {
        db.close();
      }
      const code = errorCode(cause);
      if (!["model_response_invalid", "unknown_predicate"].includes(code)) throw cause;
      failed += 1;
      failureCodes.add(code);
    }
  }
  const final = await writableGraphDatabase(root);
  try {
    alignClaimsAndConfidence(final, generationId);
  } finally {
    final.close();
  }
  return {
    chunks_processed: processed,
    chunks_reused: reused,
    chunks_failed: failed,
    failure_codes: [...failureCodes].sort(),
    entities: entityCount,
    claims: claimCount,
  };
}

function publishExtraction(
  database: Database,
  generationId: string,
  runId: string,
  chunk: ChunkInput,
  value: GraphExtraction,
) {
  const byLocal = new Map<string, { entityId: string; nodeId: string }>();
  for (const entity of value.entities) {
    const normalized = normalizeGraphLabel(entity.name);
    const existing = entity.identity_key
      ? database
          .query<{ entity_id: string; node_id: string }, [string, string]>(
            "SELECT entity_id, node_id FROM graph_entities WHERE entity_type = ? AND identity_key = ? AND status <> 'deleted'",
          )
          .get(entity.type, entity.identity_key)
      : database
          .query<{ entity_id: string; node_id: string }, [string, string, string]>(
            `SELECT e.entity_id, e.node_id FROM graph_entities e JOIN graph_entity_aliases a ON a.entity_id = e.entity_id
           WHERE e.entity_type = ? AND e.normalized_name = ? AND a.evidence_chunk_id = ? AND e.status <> 'deleted'`,
          )
          .get(entity.type, normalized, chunk.chunk_id);
    const entityId = existing?.entity_id ?? createResourceId("entity");
    const nodeId =
      existing?.node_id ??
      ensureNode(database, generationId, {
        kind: "entity",
        label: entity.name,
        status: "proposed",
        sourceKind: "model",
        properties: { entity_type: entity.type },
      });
    if (!existing)
      database
        .prepare(
          `INSERT INTO graph_entities(entity_id, node_id, entity_type, canonical_name, normalized_name,
         identity_key, status, origin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'proposed', 'model', ?, ?)`,
        )
        .run(
          entityId,
          nodeId,
          entity.type,
          entity.name,
          normalized,
          entity.identity_key ?? null,
          new Date().toISOString(),
          new Date().toISOString(),
        );
    database
      .prepare("INSERT OR IGNORE INTO graph_generation_nodes(generation_id, node_id) VALUES (?, ?)")
      .run(generationId, nodeId);
    addAlias(database, entityId, entity.name, chunk.chunk_id, "model");
    for (const alias of entity.aliases)
      addAlias(database, entityId, alias, chunk.chunk_id, "model");
    byLocal.set(entity.local_id, { entityId, nodeId });
    const chunkNode = nodeForExternal(database, "chunk", chunk.chunk_id);
    if (chunkNode) {
      const relationId = ensureRelation(database, generationId, {
        subjectNodeId: chunkNode,
        predicate: "mentions",
        objectNodeId: nodeId,
        origin: "model",
        status: "proposed",
        confidenceLevel: "medium",
        confidence: { grounded_excerpt_hash: sha256Text(entity.evidence_excerpt) },
        extractionRunId: runId,
      });
      addRelationChunkEvidence(
        database,
        relationId,
        chunk,
        runId,
        entity.evidence_excerpt,
        "definition",
        "direct",
      );
    }
  }
  for (const claim of value.claims) {
    const subject = byLocal.get(claim.subject_local_id);
    const object = claim.object_local_id ? byLocal.get(claim.object_local_id) : undefined;
    if (!subject || (claim.object_local_id && !object))
      throw failure("model_response_invalid", "Claim Entity resolution failed", "external");
    const qualifierJson = canonicalJson(claim.qualifiers);
    const qualifierHash = sha256Text(qualifierJson);
    const normalizedStatement = normalizeGraphLabel(claim.statement);
    const valueJson = claim.value === undefined ? null : JSON.stringify(claim.value);
    const existing = database
      .query<{ claim_id: string; node_id: string }, [string, string, string, string | null]>(
        `SELECT claim_id, node_id FROM graph_claims WHERE normalized_statement = ? AND qualifier_hash = ?
       AND subject_node_id = ? AND COALESCE(object_node_id, value_json) = COALESCE(?, value_json) AND deleted_at IS NULL`,
      )
      .get(normalizedStatement, qualifierHash, subject.nodeId, object?.nodeId ?? valueJson);
    const claimId = existing?.claim_id ?? createResourceId("claim");
    const confidence = assessConfidence({
      directness: claim.directness,
      independentSourceCount: 1,
      extractionQuality: 0.85,
      disputed: false,
      userVerification: "none",
    });
    const claimNode =
      existing?.node_id ??
      ensureNode(database, generationId, {
        kind: "claim",
        externalRef: claimId,
        label: claim.statement,
        status: "proposed",
        sourceKind: "model",
        properties: { predicate: claim.predicate },
      });
    if (!existing)
      database
        .prepare(
          `INSERT INTO graph_claims(claim_id, node_id, subject_node_id, predicate_key, object_node_id,
         value_json, qualifier_hash, qualifiers_json, normalized_statement, valid_from, valid_to,
         epistemic_status, status, confidence_level, confidence_json, origin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, 'model', ?, ?)`,
        )
        .run(
          claimId,
          claimNode,
          subject.nodeId,
          claim.predicate,
          object?.nodeId ?? null,
          valueJson,
          qualifierHash,
          qualifierJson,
          normalizedStatement,
          claim.valid_from ?? null,
          claim.valid_to ?? null,
          claim.epistemic_status,
          confidence.level,
          JSON.stringify(confidence),
          new Date().toISOString(),
          new Date().toISOString(),
        );
    database
      .prepare("INSERT OR IGNORE INTO graph_generation_nodes(generation_id, node_id) VALUES (?, ?)")
      .run(generationId, claimNode);
    database
      .prepare(
        "INSERT OR IGNORE INTO graph_generation_claims(generation_id, claim_id) VALUES (?, ?)",
      )
      .run(generationId, claimId);
    addClaimEvidence(
      database,
      claimId,
      chunk,
      runId,
      claim.evidence_excerpt,
      claim.evidence_role,
      claim.directness,
    );
    if (object) {
      const relationId = ensureRelation(database, generationId, {
        subjectNodeId: subject.nodeId,
        predicate: claim.predicate,
        objectNodeId: object.nodeId,
        qualifiers: claim.qualifiers,
        origin: "model",
        status: "proposed",
        confidenceLevel: confidence.level,
        confidence,
        claimId,
        extractionRunId: runId,
      });
      addRelationChunkEvidence(
        database,
        relationId,
        chunk,
        runId,
        claim.evidence_excerpt,
        claim.evidence_role,
        claim.directness,
        claimId,
      );
    }
  }
}

function errorCode(cause: unknown): string {
  return cause && typeof cause === "object" && "selfError" in cause
    ? String((cause as { selfError: { code: string } }).selfError.code)
    : "graph_extraction_failed";
}
