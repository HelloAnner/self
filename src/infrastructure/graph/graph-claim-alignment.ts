import type { Database } from "bun:sqlite";
import { assessConfidence } from "../../domains/graph/index.ts";
import { sha256Text } from "../../shared/hash/sha256.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import { addClaimRelation, claimPosition, sameTimeScope } from "./graph-extraction-evidence.ts";

type AlignedClaim = {
  claim_id: string;
  subject_node_id: string | null;
  predicate_key: string | null;
  object_node_id: string | null;
  value_json: string | null;
  qualifier_hash: string;
  qualifiers_json: string;
  valid_from: string | null;
  valid_to: string | null;
  status: string;
};

export function alignClaimsAndConfidence(database: Database, generationId: string) {
  const claims = database
    .query<AlignedClaim, [string]>(
      `SELECT c.claim_id, c.subject_node_id, c.predicate_key, c.object_node_id, c.value_json,
       c.qualifier_hash, c.qualifiers_json, c.valid_from, c.valid_to, c.status
       FROM graph_generation_claims m JOIN graph_claims c ON c.claim_id = m.claim_id
       WHERE m.generation_id = ? ORDER BY c.claim_id`,
    )
    .all(generationId);
  resolveImplicitConflictSets(database);
  for (let leftIndex = 0; leftIndex < claims.length; leftIndex += 1) {
    const left = claims[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < claims.length; rightIndex += 1) {
      const right = claims[rightIndex];
      if (!isConflictCandidate(left, right)) continue;
      createConflict(database, left, right);
    }
  }
  for (const claim of claims) recalculateClaimConfidence(database, claim.claim_id);
}

export function recalculateClaimConfidence(database: Database, claimId: string): void {
  const row = database
    .query<{ status: string }, [string]>("SELECT status FROM graph_claims WHERE claim_id = ?")
    .get(claimId);
  if (!row) return;
  const evidence = database
    .query<
      { directness: "direct" | "paraphrase" | "inferred"; source_lineage_key: string | null },
      [string]
    >(
      "SELECT directness, source_lineage_key FROM graph_claim_evidence WHERE claim_id = ? AND state = 'active'",
    )
    .all(claimId);
  const independent = new Set(evidence.map((item) => item.source_lineage_key).filter(Boolean)).size;
  const disputed =
    database
      .query<{ count: number }, [string]>(
        `SELECT COUNT(*) count FROM graph_conflict_members m JOIN graph_conflict_sets c
         ON c.conflict_id = m.conflict_id WHERE m.claim_id = ?
         AND c.status IN ('proposed','confirmed','partially_resolved')`,
      )
      .get(claimId)?.count ?? 0;
  const directness = evidence.some((item) => item.directness === "direct")
    ? "direct"
    : evidence.some((item) => item.directness === "paraphrase")
      ? "paraphrase"
      : "inferred";
  const verification =
    row.status === "user_confirmed" ? "confirmed" : row.status === "rejected" ? "rejected" : "none";
  const confidence = assessConfidence({
    directness,
    independentSourceCount: Math.max(1, independent),
    extractionQuality: 0.85,
    disputed: disputed > 0,
    userVerification: verification,
  });
  database
    .prepare(
      `UPDATE graph_claims SET confidence_level = ?, confidence_json = ?, status = CASE
       WHEN ? = 1 AND status NOT IN ('rejected','user_confirmed') THEN 'disputed'
       WHEN ? = 0 AND status = 'disputed' THEN 'proposed' ELSE status END,
       updated_at = ? WHERE claim_id = ?`,
    )
    .run(
      confidence.level,
      JSON.stringify(confidence),
      disputed > 0 ? 1 : 0,
      disputed > 0 ? 1 : 0,
      new Date().toISOString(),
      claimId,
    );
  database
    .prepare(
      `UPDATE graph_relations SET confidence_level = ?, confidence_json = ?, updated_at = ?
       WHERE claim_id = ? AND deleted_at IS NULL`,
    )
    .run(confidence.level, JSON.stringify(confidence), new Date().toISOString(), claimId);
}

function isConflictCandidate(
  left: AlignedClaim,
  right: AlignedClaim | undefined,
): right is AlignedClaim {
  return Boolean(
    right &&
      left.subject_node_id === right.subject_node_id &&
      left.predicate_key === right.predicate_key &&
      left.qualifier_hash === right.qualifier_hash &&
      sameTimeScope(left, right) &&
      claimPosition(left) !== claimPosition(right) &&
      sameConflictScope(left.qualifiers_json, right.qualifiers_json),
  );
}

function createConflict(database: Database, left: AlignedClaim, right: AlignedClaim) {
  const scopeHash = sha256Text(
    `${left.qualifier_hash}\n${left.valid_from ?? ""}\n${left.valid_to ?? ""}`,
  );
  const conflictKey = sha256Text(`${left.subject_node_id}\n${left.predicate_key}\n${scopeHash}`);
  let conflict = database
    .query<{ conflict_id: string }, [string]>(
      "SELECT conflict_id FROM graph_conflict_sets WHERE conflict_key = ?",
    )
    .get(conflictKey);
  if (!conflict) {
    conflict = { conflict_id: createResourceId("conflict") };
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO graph_conflict_sets(conflict_id, conflict_key, subject_node_id, predicate_key,
         qualifier_scope_hash, status, summary, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?, ?)`,
      )
      .run(
        conflict.conflict_id,
        conflictKey,
        left.subject_node_id,
        left.predicate_key,
        scopeHash,
        "Mutually exclusive Claim positions",
        now,
        now,
      );
  }
  const insert = database.prepare(
    `INSERT OR IGNORE INTO graph_conflict_members(conflict_id, claim_id, position_key, role,
     created_at) VALUES (?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  insert.run(conflict.conflict_id, left.claim_id, sha256Text(claimPosition(left)), "position", now);
  insert.run(
    conflict.conflict_id,
    right.claim_id,
    sha256Text(claimPosition(right)),
    "counter_position",
    now,
  );
  addClaimRelation(database, left.claim_id, "contradicts", right.claim_id);
}

function sameConflictScope(leftJson: string, rightJson: string): boolean {
  const left = JSON.parse(leftJson) as Record<string, unknown>;
  const right = JSON.parse(rightJson) as Record<string, unknown>;
  const leftScope = typeof left.conflict_scope === "string" ? left.conflict_scope.trim() : "";
  const rightScope = typeof right.conflict_scope === "string" ? right.conflict_scope.trim() : "";
  return leftScope.length > 0 && leftScope === rightScope;
}

function resolveImplicitConflictSets(database: Database): void {
  database
    .prepare(
      `UPDATE graph_conflict_sets SET status = 'resolved',
       resolution_json = '{"rule":"explicit-conflict-scope-required-v1"}', updated_at = ?
       WHERE status IN ('proposed','confirmed','partially_resolved')
       AND summary = 'Mutually exclusive Claim positions'
       AND NOT EXISTS (
         SELECT 1 FROM graph_conflict_members m JOIN graph_claims c ON c.claim_id = m.claim_id
         WHERE m.conflict_id = graph_conflict_sets.conflict_id
         AND json_extract(c.qualifiers_json, '$.conflict_scope') IS NOT NULL
         AND trim(json_extract(c.qualifiers_json, '$.conflict_scope')) <> ''
       )`,
    )
    .run(new Date().toISOString());
}
