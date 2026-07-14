import type { Database } from "bun:sqlite";
import { failure } from "../../shared/errors/self-error.ts";
import {
  append,
  impactDigest,
  stateChange,
  topicAndArtifactChanges,
  uniqueIds,
} from "./impact-helpers.ts";
import type { MutationDescription, PlannedMutationChange } from "./mutation-types.ts";

type Row = Record<string, unknown>;

export function describeSourceDelete(database: Database, sourceId: string): MutationDescription {
  const source = database
    .query<Row, [string]>(
      "SELECT source_id, state, version, current_snapshot_id, deleted_at FROM sources WHERE source_id = ?",
    )
    .get(sourceId);
  if (!source) throw failure("source_not_found", "Source does not exist", "not_found");
  if (source.state === "deleted")
    throw failure("source_deleted", "Source is already deleted", "state");
  const changes: PlannedMutationChange[] = [];
  append(
    changes,
    stateChange(
      "source",
      sourceId,
      { source_id: sourceId },
      source,
      "state",
      "deleted",
      "deleted",
      { deleted_at: "$now" },
    ),
  );
  const connections = database
    .query<Row, [string]>(
      `SELECT connection_id, state, revision FROM data_connections
       WHERE source_id = ? AND state NOT IN ('detached','deleted')`,
    )
    .all(sourceId);
  for (const connection of connections) {
    const id = String(connection.connection_id);
    append(
      changes,
      stateChange(
        "connection",
        id,
        { connection_id: id },
        connection,
        "state",
        "detached",
        "detached",
      ),
    );
  }
  const documents = database
    .query<Row, [string]>(
      "SELECT document_id, state, version, deleted_at FROM knowledge_documents WHERE source_id = ?",
    )
    .all(sourceId);
  for (const document of documents) {
    const id = String(document.document_id);
    append(
      changes,
      stateChange("document", id, { document_id: id }, document, "state", "deleted", "tombstoned", {
        deleted_at: "$now",
      }),
    );
  }
  const chunks = database
    .query<Row, [string]>(
      `SELECT c.chunk_id, c.state, c.tombstoned_at FROM knowledge_chunks c JOIN knowledge_documents d
       ON d.document_id = c.document_id WHERE d.source_id = ?`,
    )
    .all(sourceId);
  for (const chunk of chunks) {
    const id = String(chunk.chunk_id);
    append(
      changes,
      stateChange("chunk", id, { chunk_id: id }, chunk, "state", "tombstoned", "tombstoned", {
        tombstoned_at: "$now",
      }),
    );
  }
  const graphNodes = database
    .query<Row, [string, string, string]>(
      `SELECT n.node_id, n.status, n.version FROM graph_nodes n
       WHERE n.external_ref_id = ? OR n.external_ref_id IN (
         SELECT document_id FROM knowledge_documents WHERE source_id = ?
         UNION SELECT c.chunk_id FROM knowledge_chunks c JOIN knowledge_documents d
           ON d.document_id = c.document_id WHERE d.source_id = ?
       )`,
    )
    .all(sourceId, sourceId, sourceId);
  for (const node of graphNodes) {
    if (["deleted", "rejected", "redirected"].includes(String(node.status))) continue;
    const id = String(node.node_id);
    append(
      changes,
      stateChange("graph_node", id, { node_id: id }, node, "status", "stale", "invalidated"),
    );
  }
  const claimEvidence = database
    .query<Row, [string]>(
      `SELECT e.claim_id, e.evidence_id, e.state FROM graph_claim_evidence e
       JOIN knowledge_chunks c ON c.chunk_id = e.chunk_id JOIN knowledge_documents d
       ON d.document_id = c.document_id WHERE d.source_id = ?`,
    )
    .all(sourceId);
  for (const evidence of claimEvidence) {
    const claimId = String(evidence.claim_id);
    const evidenceId = String(evidence.evidence_id);
    append(
      changes,
      stateChange(
        "claim_evidence",
        `${claimId}::${evidenceId}`,
        { claim_id: claimId, evidence_id: evidenceId },
        evidence,
        "state",
        "stale",
        "invalidated",
      ),
    );
  }
  const relationEvidence = database
    .query<Row, [string]>(
      `SELECT e.relation_id, e.evidence_id, e.state FROM graph_relation_evidence e
       JOIN knowledge_chunks c ON c.chunk_id = e.chunk_id JOIN knowledge_documents d
       ON d.document_id = c.document_id WHERE d.source_id = ?`,
    )
    .all(sourceId);
  for (const evidence of relationEvidence) {
    const relationId = String(evidence.relation_id);
    const evidenceId = String(evidence.evidence_id);
    append(
      changes,
      stateChange(
        "relation_evidence",
        `${relationId}::${evidenceId}`,
        { relation_id: relationId, evidence_id: evidenceId },
        evidence,
        "state",
        "stale",
        "invalidated",
      ),
    );
  }
  const claimIds = uniqueIds(claimEvidence.map((row) => row.claim_id));
  for (const claimId of claimIds) {
    const claim = database
      .query<Row, [string]>("SELECT claim_id, status, version FROM graph_claims WHERE claim_id = ?")
      .get(claimId);
    if (!claim || ["deleted", "rejected", "superseded"].includes(String(claim.status))) continue;
    append(
      changes,
      stateChange("claim", claimId, { claim_id: claimId }, claim, "status", "stale", "invalidated"),
    );
  }
  const relationIds = uniqueIds(relationEvidence.map((row) => row.relation_id));
  for (const relationId of relationIds) {
    const relation = database
      .query<Row, [string]>(
        "SELECT relation_id, status, version FROM graph_relations WHERE relation_id = ?",
      )
      .get(relationId);
    if (!relation || ["deleted", "rejected", "deprecated"].includes(String(relation.status)))
      continue;
    append(
      changes,
      stateChange(
        "relation",
        relationId,
        { relation_id: relationId },
        relation,
        "status",
        "stale",
        "invalidated",
      ),
    );
  }
  const contexts = database
    .query<Row, [string]>(
      `SELECT DISTINCT c.context_id, c.state, c.stale_at, c.stale_reason FROM evidence_contexts c
       JOIN evidence_context_items i ON i.context_id = c.context_id WHERE i.source_id = ?`,
    )
    .all(sourceId);
  for (const context of contexts) {
    const id = String(context.context_id);
    append(
      changes,
      stateChange(
        "evidence_context",
        id,
        { context_id: id },
        context,
        "state",
        "stale",
        "invalidated",
        { stale_at: "$now", stale_reason: `source_deleted:${sourceId}` },
      ),
    );
  }
  const answers = database
    .query<Row, [string]>(
      `SELECT DISTINCT a.answer_id, a.cache_state, a.stale_at, a.stale_reason FROM answer_runs a
       JOIN evidence_context_items i ON i.context_id = a.context_id WHERE i.source_id = ?`,
    )
    .all(sourceId);
  for (const answer of answers) {
    const id = String(answer.answer_id);
    append(
      changes,
      stateChange("answer", id, { answer_id: id }, answer, "cache_state", "stale", "invalidated", {
        stale_at: "$now",
        stale_reason: `source_deleted:${sourceId}`,
      }),
    );
  }
  const topicIds = uniqueIds([
    ...database
      .query<{ topic_id: string }, [string]>(
        `SELECT DISTINCT s.topic_id FROM topic_report_citations c
         JOIN topic_report_conclusions rc ON rc.conclusion_id = c.conclusion_id
         JOIN topic_report_sections rs ON rs.section_id = rc.section_id
         JOIN topic_snapshots s ON s.topic_snapshot_id = rs.topic_snapshot_id
         JOIN topics t ON t.latest_snapshot_id = s.topic_snapshot_id WHERE c.source_id = ?`,
      )
      .all(sourceId)
      .map((row) => row.topic_id),
    ...claimIds.flatMap((claimId) =>
      database
        .query<{ topic_id: string }, [string]>(
          `SELECT DISTINCT t.topic_id FROM topics t JOIN topic_snapshot_claims c
           ON c.topic_snapshot_id = t.latest_snapshot_id WHERE c.claim_id = ?`,
        )
        .all(claimId)
        .map((row) => row.topic_id),
    ),
  ]);
  const downstream = topicAndArtifactChanges(
    database,
    topicIds,
    `source_deleted:${sourceId}`,
    true,
  );
  changes.push(...downstream.changes);
  const digest = impactDigest(changes);
  return {
    preconditions: {
      source_version: source.version,
      source_state: source.state,
      current_snapshot_id: source.current_snapshot_id,
      impact_hash: digest,
    },
    impact: {
      connections: connections.map((row) => row.connection_id),
      documents: documents.map((row) => row.document_id),
      chunks: chunks.map((row) => row.chunk_id),
      claims: claimIds,
      relations: relationIds,
      topics: topicIds,
      artifacts: downstream.artifactIds,
      evidence_contexts: contexts.map((row) => row.context_id),
      answers: answers.map((row) => row.answer_id),
      change_count: changes.length,
      impact_hash: digest,
    },
    changes,
    inverse: { action: "source_restore", source_id: sourceId },
    reversible: true,
    targets: [
      {
        resourceId: sourceId,
        resourceKind: "source",
        role: "primary",
        expectedVersion: Number(source.version),
        expectedState: String(source.state),
      },
      ...topicIds.map((id) => ({
        resourceId: id,
        resourceKind: "topic",
        role: "affected" as const,
      })),
      ...downstream.artifactIds.map((id) => ({
        resourceId: id,
        resourceKind: "artifact",
        role: "affected" as const,
      })),
    ],
  };
}

export function describeNoteDelete(database: Database, noteId: string): MutationDescription {
  const note = database
    .query<Row, [string]>(
      "SELECT note_id, source_id, state, version, deleted_at FROM knowledge_notes WHERE note_id = ?",
    )
    .get(noteId);
  if (!note) throw failure("note_not_found", "Note does not exist", "not_found");
  if (note.state === "deleted") throw failure("note_deleted", "Note is already deleted", "state");
  const source = describeSourceDelete(database, String(note.source_id));
  const noteChange = stateChange(
    "note",
    noteId,
    { note_id: noteId },
    note,
    "state",
    "deleted",
    "deleted",
    { deleted_at: "$now" },
  );
  const changes = [...(noteChange ? [noteChange] : []), ...source.changes];
  return {
    ...source,
    preconditions: {
      note_version: note.version,
      note_state: note.state,
      source: source.preconditions,
      impact_hash: impactDigest(changes),
    },
    impact: { ...source.impact, note_id: noteId, change_count: changes.length },
    changes,
    inverse: { action: "note_restore", note_id: noteId },
    targets: [
      {
        resourceId: noteId,
        resourceKind: "note",
        role: "primary",
        expectedVersion: Number(note.version),
        expectedState: String(note.state),
      },
      ...source.targets.map((target) => ({ ...target, role: "affected" as const })),
    ],
  };
}
