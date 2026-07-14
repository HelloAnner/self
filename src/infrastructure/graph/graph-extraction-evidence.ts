import type { Database } from "bun:sqlite";
import { normalizeGraphLabel } from "../../domains/graph/index.ts";
import { sha256Text } from "../../shared/hash/sha256.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import type { ChunkInput } from "./graph-extraction.ts";

export function reuseChunkExtraction(
  database: Database,
  generationId: string,
  sourceChunkId: string,
  targetChunk: ChunkInput,
): void {
  const claims = database
    .query<
      {
        claim_id: string;
        node_id: string;
        subject_node_id: string | null;
        object_node_id: string | null;
      },
      [string]
    >(
      `SELECT c.claim_id, c.node_id, c.subject_node_id, c.object_node_id FROM graph_claim_evidence e
     JOIN graph_claims c ON c.claim_id = e.claim_id WHERE e.chunk_id = ? AND e.state = 'active'`,
    )
    .all(sourceChunkId);
  for (const claim of claims) {
    database
      .prepare(
        "INSERT OR IGNORE INTO graph_generation_claims(generation_id, claim_id) VALUES (?, ?)",
      )
      .run(generationId, claim.claim_id);
    for (const nodeId of [claim.node_id, claim.subject_node_id, claim.object_node_id].filter(
      Boolean,
    ))
      database
        .prepare(
          "INSERT OR IGNORE INTO graph_generation_nodes(generation_id, node_id) VALUES (?, ?)",
        )
        .run(generationId, nodeId);
    const relations = database
      .query<{ relation_id: string }, [string]>(
        "SELECT relation_id FROM graph_relations WHERE claim_id = ? AND deleted_at IS NULL",
      )
      .all(claim.claim_id);
    for (const relation of relations)
      database
        .prepare(
          "INSERT OR IGNORE INTO graph_generation_relations(generation_id, relation_id) VALUES (?, ?)",
        )
        .run(generationId, relation.relation_id);
    cloneClaimEvidence(database, claim.claim_id, sourceChunkId, targetChunk);
    for (const relation of relations)
      cloneRelationEvidence(database, relation.relation_id, sourceChunkId, targetChunk);
  }
}

function cloneClaimEvidence(
  database: Database,
  claimId: string,
  sourceChunkId: string,
  target: ChunkInput,
): void {
  if (sourceChunkId === target.chunk_id) return;
  const rows = database
    .query<
      {
        role: string;
        directness: string;
        excerpt_hash: string;
        extraction_run_id: string | null;
      },
      [string, string]
    >(
      `SELECT role, directness, excerpt_hash, extraction_run_id FROM graph_claim_evidence
     WHERE claim_id = ? AND chunk_id = ? AND state = 'active'`,
    )
    .all(claimId, sourceChunkId);
  for (const row of rows) {
    const exists = database
      .query<{ found: number }, [string, string, string]>(
        "SELECT 1 found FROM graph_claim_evidence WHERE claim_id = ? AND chunk_id = ? AND excerpt_hash = ?",
      )
      .get(claimId, target.chunk_id, row.excerpt_hash);
    if (exists) continue;
    database
      .prepare(
        `INSERT OR IGNORE INTO graph_claim_evidence(claim_id, evidence_id, chunk_id, revision_id,
       role, directness, source_lineage_key, locator_json, excerpt_hash, state, extraction_run_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        claimId,
        createResourceId("evidence"),
        target.chunk_id,
        target.revision_id,
        row.role,
        row.directness,
        target.blob_sha256,
        JSON.stringify({ start_line: target.source_start_line, end_line: target.source_end_line }),
        row.excerpt_hash,
        row.extraction_run_id,
        new Date().toISOString(),
      );
  }
}

function cloneRelationEvidence(
  database: Database,
  relationId: string,
  sourceChunkId: string,
  target: ChunkInput,
): void {
  if (sourceChunkId === target.chunk_id) return;
  const rows = database
    .query<
      {
        claim_id: string | null;
        role: string;
        directness: string;
        excerpt_hash: string | null;
        locator_json: string;
      },
      [string, string]
    >(
      `SELECT claim_id, role, directness, excerpt_hash, locator_json FROM graph_relation_evidence
     WHERE relation_id = ? AND chunk_id = ? AND state = 'active'`,
    )
    .all(relationId, sourceChunkId);
  for (const row of rows) {
    const exists = database
      .query<{ found: number }, [string, string, string | null]>(
        "SELECT 1 found FROM graph_relation_evidence WHERE relation_id = ? AND chunk_id = ? AND excerpt_hash IS ?",
      )
      .get(relationId, target.chunk_id, row.excerpt_hash);
    if (exists) continue;
    database
      .prepare(
        `INSERT OR IGNORE INTO graph_relation_evidence(relation_id, evidence_id, evidence_kind,
       chunk_id, claim_id, revision_id, role, directness, locator_json, excerpt_hash, state, created_at)
       VALUES (?, ?, 'chunk', ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      )
      .run(
        relationId,
        createResourceId("evidence"),
        target.chunk_id,
        row.claim_id,
        target.revision_id,
        row.role,
        row.directness,
        row.locator_json,
        row.excerpt_hash,
        new Date().toISOString(),
      );
  }
}

export function addAlias(
  database: Database,
  entityId: string,
  alias: string,
  chunkId: string,
  origin: string,
): void {
  const normalized = normalizeGraphLabel(alias);
  const existing = database
    .query<{ alias_id: string }, [string, string, string]>(
      "SELECT alias_id FROM graph_entity_aliases WHERE entity_id = ? AND normalized_alias = ? AND evidence_chunk_id = ?",
    )
    .get(entityId, normalized, chunkId);
  if (!existing)
    database
      .prepare(
        `INSERT INTO graph_entity_aliases(alias_id, entity_id, alias, normalized_alias, scope,
     evidence_chunk_id, origin, created_at) VALUES (?, ?, ?, ?, '', ?, ?, ?)`,
      )
      .run(
        createResourceId("evidence"),
        entityId,
        alias,
        normalized,
        chunkId,
        origin,
        new Date().toISOString(),
      );
}

export function addClaimEvidence(
  database: Database,
  claimId: string,
  chunk: ChunkInput,
  runId: string,
  excerpt: string,
  role: string,
  directness: string,
): void {
  const excerptHash = sha256Text(excerpt);
  const existing = database
    .query<{ evidence_id: string }, [string, string, string]>(
      "SELECT evidence_id FROM graph_claim_evidence WHERE claim_id = ? AND chunk_id = ? AND excerpt_hash = ?",
    )
    .get(claimId, chunk.chunk_id, excerptHash);
  if (!existing)
    database
      .prepare(
        `INSERT INTO graph_claim_evidence(claim_id, evidence_id, chunk_id, revision_id, role, directness,
     source_lineage_key, locator_json, excerpt_hash, state, extraction_run_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        claimId,
        createResourceId("evidence"),
        chunk.chunk_id,
        chunk.revision_id,
        role,
        directness,
        chunk.blob_sha256,
        JSON.stringify({ start_line: chunk.source_start_line, end_line: chunk.source_end_line }),
        excerptHash,
        runId,
        new Date().toISOString(),
      );
}

export function addRelationChunkEvidence(
  database: Database,
  relationId: string,
  chunk: ChunkInput,
  runId: string,
  excerpt: string,
  role: string,
  directness: string,
  claimId?: string,
): void {
  const hash = sha256Text(excerpt);
  const existing = database
    .query<{ evidence_id: string }, [string, string, string]>(
      "SELECT evidence_id FROM graph_relation_evidence WHERE relation_id = ? AND chunk_id = ? AND excerpt_hash = ?",
    )
    .get(relationId, chunk.chunk_id, hash);
  if (!existing)
    database
      .prepare(
        `INSERT INTO graph_relation_evidence(relation_id, evidence_id, evidence_kind, chunk_id, claim_id,
     revision_id, role, directness, locator_json, excerpt_hash, state, created_at)
     VALUES (?, ?, 'chunk', ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      )
      .run(
        relationId,
        createResourceId("evidence"),
        chunk.chunk_id,
        claimId ?? null,
        chunk.revision_id,
        role,
        directness,
        JSON.stringify({
          extraction_run_id: runId,
          start_line: chunk.source_start_line,
          end_line: chunk.source_end_line,
        }),
        hash,
        new Date().toISOString(),
      );
}

export function addClaimRelation(
  database: Database,
  left: string,
  type: string,
  right: string,
): void {
  const [source, target] =
    type === "contradicts" && left.localeCompare(right) > 0 ? [right, left] : [left, right];
  database
    .prepare(
      `INSERT OR IGNORE INTO graph_claim_relations(source_claim_id, relation_type, target_claim_id,
     confidence_json, status, created_at) VALUES (?, ?, ?, '{"rule":"scope-exclusive-v1"}', 'proposed', ?)`,
    )
    .run(source, type, target, new Date().toISOString());
}

export function nodeForExternal(database: Database, kind: string, external: string): string | null {
  return (
    database
      .query<{ node_id: string }, [string, string]>(
        "SELECT node_id FROM graph_nodes WHERE node_kind = ? AND external_ref_id = ? AND deleted_at IS NULL",
      )
      .get(kind, external)?.node_id ?? null
  );
}

export function sameTimeScope(
  left: { valid_from: string | null; valid_to: string | null },
  right: { valid_from: string | null; valid_to: string | null },
): boolean {
  return left.valid_from === right.valid_from && left.valid_to === right.valid_to;
}

export function claimPosition(value: {
  object_node_id: string | null;
  value_json: string | null;
}): string {
  return value.object_node_id ?? value.value_json ?? "unknown";
}
