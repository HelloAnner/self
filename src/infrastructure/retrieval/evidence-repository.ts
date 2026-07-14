import type { Database } from "bun:sqlite";
import type { EvidenceContextItem, RetrievalPlan } from "../../domains/retrieval/index.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { sha256Text } from "../filesystem/hash.ts";
import { writableModelDatabase } from "../model/model-db.ts";

export type GraphEvidenceCandidate = Record<string, unknown> & {
  claim_id: string;
  chunk_id: string;
  role: string;
  claim_status: string;
  confidence_level: string;
};

export function activeRetrievalPointers(database: Database) {
  const fts = database
    .query<{ id: string | null }, []>(
      "SELECT active_generation_id id FROM knowledge_active_indexes WHERE index_kind = 'fts'",
    )
    .get()?.id;
  const vector = database
    .query<{ id: string | null; fingerprint: string | null }, []>(
      `SELECT a.active_vector_space_id id, v.space_fingerprint fingerprint
       FROM knowledge_active_vector_space a LEFT JOIN vector_spaces v
       ON v.vector_space_id = a.active_vector_space_id WHERE a.singleton_id = 1`,
    )
    .get();
  const graph = database
    .query<{ id: string | null }, []>(
      "SELECT active_generation_id id FROM graph_active_generation WHERE singleton_id = 1",
    )
    .get()?.id;
  return {
    ftsGenerationId: fts ?? null,
    vectorSpaceId: vector?.id ?? null,
    vectorSpaceFingerprint: vector?.fingerprint ?? null,
    graphGenerationId: graph ?? null,
  };
}

export function graphEvidenceForSeeds(
  database: Database,
  chunkIds: string[],
  limit: number,
): GraphEvidenceCandidate[] {
  if (chunkIds.length === 0) return [];
  const graphId = activeRetrievalPointers(database).graphGenerationId;
  if (!graphId) return [];
  const marks = chunkIds.map(() => "?").join(",");
  return database
    .query<GraphEvidenceCandidate, (string | number)[]>(
      `WITH seed_entities(node_id) AS (
         SELECT DISTINCT r.object_node_id
         FROM graph_generation_relations gm
         JOIN graph_relations r ON r.relation_id = gm.relation_id
         JOIN graph_nodes n ON n.node_id = r.subject_node_id
         WHERE gm.generation_id = ? AND n.external_ref_id IN (${marks})
           AND r.predicate_key = 'mentions' AND r.status IN ('accepted','proposed')
       ), candidate_claims(claim_id, route_rank) AS (
         SELECT DISTINCT e.claim_id, 0 FROM graph_claim_evidence e
         WHERE e.chunk_id IN (${marks}) AND e.state = 'active'
         UNION
         SELECT DISTINCT c.claim_id, 1 FROM graph_claims c
         JOIN graph_generation_claims gm ON gm.claim_id = c.claim_id
         WHERE gm.generation_id = ? AND c.status NOT IN ('rejected','deleted','stale','superseded')
           AND (c.subject_node_id IN (SELECT node_id FROM seed_entities)
             OR c.object_node_id IN (SELECT node_id FROM seed_entities))
       )
       SELECT c.claim_id, e.chunk_id, e.role, c.status claim_status,
         c.confidence_level, c.confidence_json, c.epistemic_status,
         c.normalized_statement, cc.route_rank
       FROM candidate_claims cc JOIN graph_claims c ON c.claim_id = cc.claim_id
       JOIN graph_claim_evidence e ON e.claim_id = c.claim_id AND e.state = 'active'
       ORDER BY cc.route_rank, CASE e.role WHEN 'contradict' THEN 0 ELSE 1 END,
         c.confidence_level, c.claim_id, e.chunk_id LIMIT ?`,
    )
    .all(graphId, ...chunkIds, ...chunkIds, graphId, limit);
}

export function createRetrievalRecords(
  database: Database,
  input: {
    retrievalRunId: string;
    contextId: string;
    plan: RetrievalPlan;
    pointers: ReturnType<typeof activeRetrievalPointers>;
    warnings: string[];
    timings: Record<string, number>;
    candidates: Array<{
      chunkId: string;
      claimId?: string;
      rank: number;
      score: number;
      routes: unknown;
      selected: boolean;
    }>;
    items: EvidenceContextItem[];
    contextHash: string;
    promptSpecVersion: string;
  },
) {
  const now = new Date().toISOString();
  database.transaction(() => {
    database
      .prepare(
        `INSERT INTO retrieval_runs(retrieval_run_id, query_hash, plan_version, mode, depth,
         state, filters_json, fts_generation_id, vector_space_id, vector_space_fingerprint,
         graph_generation_id, candidate_count, timings_json, warnings_json, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.retrievalRunId,
        input.plan.queryHash,
        input.plan.version,
        input.plan.mode,
        input.plan.depth,
        JSON.stringify(input.plan.filters),
        input.pointers.ftsGenerationId,
        input.pointers.vectorSpaceId,
        input.pointers.vectorSpaceFingerprint,
        input.pointers.graphGenerationId,
        input.candidates.length,
        JSON.stringify(input.timings),
        JSON.stringify(input.warnings),
        now,
        now,
      );
    const candidate = database.prepare(
      `INSERT INTO retrieval_candidates(retrieval_run_id, chunk_id, claim_id, rank, score,
       routes_json, selected) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of input.candidates)
      candidate.run(
        input.retrievalRunId,
        row.chunkId,
        row.claimId ?? null,
        row.rank,
        row.score,
        JSON.stringify(row.routes),
        row.selected ? 1 : 0,
      );
    const tokenCount = input.items.reduce((total, item) => total + item.tokenEstimate, 0);
    database
      .prepare(
        `INSERT INTO evidence_contexts(context_id, retrieval_run_id, context_hash, state,
         token_budget, token_count, item_count, prompt_spec_version, created_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      )
      .run(
        input.contextId,
        input.retrievalRunId,
        input.contextHash,
        input.plan.contextTokenBudget,
        tokenCount,
        input.items.length,
        input.promptSpecVersion,
        now,
      );
    const item = database.prepare(
      `INSERT INTO evidence_context_items(context_id, ordinal, evidence_key, chunk_id,
       document_id, revision_id, source_id, snapshot_id, blob_sha256, claim_id, claim_status,
       claim_confidence_level, excerpt_start, excerpt_end, excerpt_hash, role)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    input.items.forEach((row, index) => {
      item.run(
        input.contextId,
        index + 1,
        row.evidenceKey,
        row.chunkId,
        row.documentId,
        row.revisionId,
        row.sourceId,
        row.snapshotId,
        row.blobSha256,
        row.claimId ?? null,
        row.claimStatus ?? null,
        row.claimConfidenceLevel ?? null,
        row.excerptStart,
        row.excerptEnd,
        sha256Text(row.content.slice(row.excerptStart, row.excerptEnd)),
        row.role,
      );
    });
  })();
}

export async function invalidateActiveAnswers(root: string, reason: string) {
  const database = await writableModelDatabase(root);
  try {
    return invalidateAnswers(database, reason);
  } finally {
    database.close();
  }
}

export function invalidateAnswers(database: Database, reason: string) {
  const now = new Date().toISOString();
  return database.transaction(() => {
    const contexts = database
      .prepare(
        "UPDATE evidence_contexts SET state = 'stale', stale_at = ?, stale_reason = ? WHERE state = 'active'",
      )
      .run(now, reason);
    const answers = database
      .prepare(
        "UPDATE answer_runs SET cache_state = 'stale', stale_at = ?, stale_reason = ? WHERE cache_state = 'active'",
      )
      .run(now, reason);
    return { contexts: contexts.changes, answers: answers.changes };
  })();
}

export function requireAnswer(database: Database, answerId: string) {
  const answer = database
    .query<Record<string, unknown>, [string]>("SELECT * FROM answer_runs WHERE answer_id = ?")
    .get(answerId);
  if (!answer) throw failure("answer_not_found", "Answer does not exist", "not_found");
  return answer;
}
