import type { Database } from "bun:sqlite";
import type { TopicClaimCandidate, TopicEvidence } from "../../domains/topic/index.ts";

type ClaimRow = {
  claim_id: string;
  node_id: string;
  subject_node_id: string | null;
  predicate_key: string | null;
  object_node_id: string | null;
  qualifier_hash: string;
  normalized_statement: string;
  epistemic_status: TopicClaimCandidate["epistemicStatus"];
  status: string;
  confidence_level: TopicClaimCandidate["confidenceLevel"];
  confidence_json: string;
  origin: string;
};

type EvidenceRow = {
  claim_id: string;
  evidence_id: string;
  chunk_id: string;
  revision_id: string;
  source_id: string;
  snapshot_id: string;
  blob_sha256: string;
  content_text: string;
  source_lineage_key: string | null;
  role: TopicEvidence["role"];
  directness: TopicEvidence["directness"];
};

export function loadTopicClaims(database: Database, claimIds: string[]): TopicClaimCandidate[] {
  if (claimIds.length === 0) return [];
  const ids = [...new Set(claimIds)];
  const marks = ids.map(() => "?").join(",");
  const claims = database
    .query<ClaimRow, string[]>(
      `SELECT claim_id, node_id, subject_node_id, predicate_key, object_node_id, qualifier_hash,
       normalized_statement, epistemic_status, status, confidence_level, confidence_json, origin
       FROM graph_claims WHERE claim_id IN (${marks})
       AND status NOT IN ('rejected','deleted','stale','superseded') ORDER BY claim_id`,
    )
    .all(...ids);
  const evidence = database
    .query<EvidenceRow, string[]>(
      `SELECT e.claim_id, e.evidence_id, e.chunk_id, e.revision_id, d.source_id,
       r.snapshot_id, r.blob_sha256, c.content_text, e.source_lineage_key, e.role, e.directness
       FROM graph_claim_evidence e JOIN knowledge_chunks c ON c.chunk_id = e.chunk_id
       JOIN knowledge_documents d ON d.document_id = c.document_id
       JOIN knowledge_revisions r ON r.revision_id = e.revision_id
       WHERE e.claim_id IN (${marks}) AND e.state = 'active' ORDER BY e.claim_id, e.evidence_id`,
    )
    .all(...ids);
  const conflicts = database
    .query<{ claim_id: string; conflict_id: string }, string[]>(
      `SELECT m.claim_id, m.conflict_id FROM graph_conflict_members m
       JOIN graph_conflict_sets c ON c.conflict_id = m.conflict_id
       WHERE m.claim_id IN (${marks})
       AND c.status IN ('proposed','confirmed','partially_resolved')
       ORDER BY m.claim_id, m.conflict_id`,
    )
    .all(...ids);
  const byClaim = new Map<string, TopicEvidence[]>();
  for (const row of evidence) {
    const rows = byClaim.get(row.claim_id) ?? [];
    rows.push({
      evidenceId: row.evidence_id,
      chunkId: row.chunk_id,
      revisionId: row.revision_id,
      sourceId: row.source_id,
      snapshotId: row.snapshot_id,
      blobSha256: row.blob_sha256,
      content: row.content_text,
      sourceLineageKey: row.source_lineage_key ?? `${row.source_id}:${row.blob_sha256}`,
      role: row.role,
      directness: row.directness,
    });
    byClaim.set(row.claim_id, rows);
  }
  const conflictsByClaim = new Map<string, string[]>();
  for (const row of conflicts) {
    const rows = conflictsByClaim.get(row.claim_id) ?? [];
    rows.push(row.conflict_id);
    conflictsByClaim.set(row.claim_id, rows);
  }
  return claims.flatMap((row) => {
    const rows = byClaim.get(row.claim_id) ?? [];
    if (rows.length === 0) return [];
    return [
      {
        claimId: row.claim_id,
        nodeId: row.node_id,
        subjectNodeId: row.subject_node_id,
        predicateKey: row.predicate_key,
        objectNodeId: row.object_node_id,
        qualifierHash: row.qualifier_hash,
        normalizedStatement: row.normalized_statement,
        epistemicStatus: row.epistemic_status,
        status: row.status,
        confidenceLevel: row.confidence_level,
        confidence: JSON.parse(row.confidence_json) as Record<string, unknown>,
        origin: row.origin,
        conflictIds: conflictsByClaim.get(row.claim_id) ?? [],
        evidence: rows,
      },
    ];
  });
}

export function localTopicGraph(database: Database, claimIds: string[]) {
  if (claimIds.length === 0) return { nodes: [], relations: [] };
  const marks = claimIds.map(() => "?").join(",");
  const nodes = database
    .query<Record<string, unknown>, string[]>(
      `SELECT DISTINCT n.node_id, n.node_kind, n.canonical_label, n.status
       FROM graph_claims c JOIN graph_nodes n ON n.node_id IN
       (c.node_id, c.subject_node_id, c.object_node_id)
       WHERE c.claim_id IN (${marks}) ORDER BY n.node_kind, n.node_id`,
    )
    .all(...claimIds);
  const relations = database
    .query<Record<string, unknown>, string[]>(
      `SELECT relation_id, subject_node_id, predicate_key, object_node_id, status,
       confidence_level, claim_id FROM graph_relations WHERE claim_id IN (${marks})
       AND status NOT IN ('rejected','deleted','stale') ORDER BY relation_id`,
    )
    .all(...claimIds);
  return { nodes, relations };
}
