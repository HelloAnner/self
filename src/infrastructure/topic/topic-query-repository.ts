import type { Database } from "bun:sqlite";
import { failure } from "../../shared/errors/self-error.ts";
import { sha256Text } from "../../shared/hash/sha256.ts";

export function topicReport(database: Database, topicId: string, snapshotId?: string) {
  const topic = database
    .query<Record<string, unknown>, [string]>("SELECT * FROM topics WHERE topic_id = ?")
    .get(topicId);
  if (!topic) throw failure("topic_not_found", "Topic does not exist", "not_found");
  const selected =
    snapshotId ?? (topic.latest_snapshot_id ? String(topic.latest_snapshot_id) : null);
  if (!selected)
    throw failure("topic_not_built", "Topic has no completed synthesis snapshot", "state");
  const snapshot = database
    .query<Record<string, unknown>, [string, string]>(
      "SELECT * FROM topic_snapshots WHERE topic_snapshot_id = ? AND topic_id = ?",
    )
    .get(selected, topicId);
  if (!snapshot)
    throw failure("topic_snapshot_not_found", "Topic Snapshot does not exist", "not_found");
  const sections = database
    .query<Record<string, unknown>, [string]>(
      "SELECT * FROM topic_report_sections WHERE topic_snapshot_id = ? ORDER BY ordinal",
    )
    .all(selected)
    .map((section) => ({
      ...parseJson(section),
      conclusions: database
        .query<Record<string, unknown>, [string]>(
          `SELECT * FROM topic_report_conclusions WHERE section_id = ? ORDER BY ordinal`,
        )
        .all(String(section.section_id))
        .map((conclusion) => ({
          ...parseJson(conclusion),
          citations: database
            .query<Record<string, unknown>, [string]>(
              `SELECT tc.topic_citation_id, tc.claim_id, tc.evidence_id, tc.chunk_id,
               tc.revision_id, tc.source_id, tc.snapshot_id, tc.blob_sha256,
               tc.excerpt_start, tc.excerpt_end, tc.excerpt_hash, tc.source_lineage_key,
               tc.directness, tc.role, tc.validation_rule,
               substr(k.content_text, tc.excerpt_start + 1,
                 tc.excerpt_end - tc.excerpt_start) excerpt_text,
               k.content_hash chunk_content_hash,
               r.normalized_content_hash revision_content_hash,
               d.document_id,
               s.name source_name, s.kind source_kind,
               (SELECT e.logical_path FROM source_snapshot_entries e
                WHERE e.snapshot_id = tc.snapshot_id AND e.blob_sha256 = tc.blob_sha256
                ORDER BY e.logical_path LIMIT 1) logical_path
               FROM topic_report_citations tc
               JOIN knowledge_chunks k ON k.chunk_id = tc.chunk_id
               JOIN knowledge_revisions r ON r.revision_id = tc.revision_id
               JOIN knowledge_documents d ON d.document_id = k.document_id
               JOIN sources s ON s.source_id = tc.source_id
               WHERE tc.conclusion_id = ?
               ORDER BY source_lineage_key, topic_citation_id`,
            )
            .all(String(conclusion.conclusion_id)),
        })),
    }));
  const gaps = database
    .query<Record<string, unknown>, [string]>(
      "SELECT * FROM topic_knowledge_gaps WHERE topic_snapshot_id = ? ORDER BY ordinal",
    )
    .all(selected)
    .map(parseJson);
  const claims = database
    .query<Record<string, unknown>, [string]>(
      `SELECT sc.*, c.normalized_statement, c.epistemic_status, c.status claim_status,
       c.subject_node_id, c.predicate_key, c.object_node_id, c.valid_from, c.valid_to
       FROM topic_snapshot_claims sc JOIN graph_claims c ON c.claim_id = sc.claim_id
       WHERE sc.topic_snapshot_id = ? ORDER BY sc.conclusion_type, sc.cluster_key, sc.claim_id`,
    )
    .all(selected)
    .map(parseJson);
  const graphNodes = database
    .query<Record<string, unknown>, [string]>(
      `SELECT n.node_id, n.node_kind, n.canonical_label, n.status, sn.role
       FROM topic_snapshot_nodes sn JOIN graph_nodes n ON n.node_id = sn.node_id
       WHERE sn.topic_snapshot_id = ? ORDER BY n.node_kind, n.node_id`,
    )
    .all(selected);
  const graphRelations = database
    .query<Record<string, unknown>, [string]>(
      `SELECT r.relation_id, r.subject_node_id, r.predicate_key, r.object_node_id,
       r.status, r.confidence_level, sr.role FROM topic_snapshot_relations sr
       JOIN graph_relations r ON r.relation_id = sr.relation_id
       WHERE sr.topic_snapshot_id = ? ORDER BY r.relation_id`,
    )
    .all(selected);
  return {
    topic: parseJson(topic),
    snapshot: parseJson(snapshot),
    report: { sections, knowledge_gaps: gaps },
    knowledge_snapshot: {
      claims,
      local_graph: {
        nodes: graphNodes,
        relations: graphRelations,
        node_count: graphNodes.length,
        relation_count: graphRelations.length,
      },
    },
  };
}

export function topicHistory(database: Database, topicId: string) {
  const exists = database
    .query<{ topic_id: string }, [string]>("SELECT topic_id FROM topics WHERE topic_id = ?")
    .get(topicId);
  if (!exists) throw failure("topic_not_found", "Topic does not exist", "not_found");
  return database
    .query<Record<string, unknown>, [string]>(
      `SELECT s.topic_snapshot_id, s.parent_snapshot_id, s.sequence, s.snapshot_hash,
       s.health_status, s.confidence_level, s.coverage_json, s.change_summary_json,
       s.created_at, r.synthesis_run_id, r.retrieval_mode, r.input_watermark,
       r.synthesis_rule_version, r.candidate_count, r.claim_count, r.timings_json,
       r.warnings_json FROM topic_snapshots s JOIN topic_synthesis_runs r
       ON r.synthesis_run_id = s.synthesis_run_id WHERE s.topic_id = ?
       ORDER BY s.sequence DESC`,
    )
    .all(topicId)
    .map(parseJson);
}

export function traceTopicSection(database: Database, sectionId: string) {
  const section = database
    .query<Record<string, unknown>, [string]>(
      `SELECT s.*, ts.topic_id, ts.synthesis_run_id, ts.sequence snapshot_sequence,
       ts.snapshot_hash, ts.watermarks_json FROM topic_report_sections s
       JOIN topic_snapshots ts ON ts.topic_snapshot_id = s.topic_snapshot_id
       WHERE s.section_id = ?`,
    )
    .get(sectionId);
  if (!section) throw failure("section_not_found", "Report Section does not exist", "not_found");
  const conclusions = database
    .query<Record<string, unknown>, [string]>(
      "SELECT * FROM topic_report_conclusions WHERE section_id = ? ORDER BY ordinal",
    )
    .all(sectionId)
    .map((conclusion) => {
      const citations = database
        .query<Record<string, unknown>, [string]>(
          `SELECT tc.*, substr(k.content_text, tc.excerpt_start + 1,
           tc.excerpt_end - tc.excerpt_start) excerpt_text,
           d.document_id FROM topic_report_citations tc
           JOIN knowledge_chunks k ON k.chunk_id = tc.chunk_id
           JOIN knowledge_documents d ON d.document_id = k.document_id
           WHERE tc.conclusion_id = ? ORDER BY tc.topic_citation_id`,
        )
        .all(String(conclusion.conclusion_id))
        .map((citation) => ({
          ...citation,
          excerpt_hash_matches: sha256Text(String(citation.excerpt_text)) === citation.excerpt_hash,
        }));
      return { ...parseJson(conclusion), citations };
    });
  return {
    target_id: sectionId,
    section: parseJson(section),
    conclusions,
    evidence_chains: (
      conclusions as Array<Record<string, unknown> & { citations: Array<Record<string, unknown>> }>
    ).flatMap((conclusion) =>
      conclusion.citations.map((citation) => ({
        conclusion_id: String(conclusion.conclusion_id),
        claim_id: citation.claim_id,
        chunk_id: citation.chunk_id,
        revision_id: citation.revision_id,
        snapshot_id: citation.snapshot_id,
        source_id: citation.source_id,
        blob_sha256: citation.blob_sha256,
      })),
    ),
  };
}

function parseJson(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      key.endsWith("_json") && typeof value === "string" ? JSON.parse(value) : value,
    ]),
  );
}
