import type { Database } from "bun:sqlite";
import type { TopicSynthesis } from "../../domains/topic/index.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { sha256Text } from "../../shared/hash/sha256.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import type { TopicRow } from "./topic-lifecycle-repository.ts";

export function beginTopicSynthesis(
  database: Database,
  input: {
    synthesisRunId: string;
    topicId: string;
    contextId: string;
    parentSnapshotId: string | null;
    mode: "text" | "vector" | "hybrid";
    scopeVersion: number;
    pointers: {
      ftsGenerationId: string | null;
      vectorSpaceId: string | null;
      graphGenerationId: string | null;
    };
    inputWatermark: string;
    inputHash: string;
    ruleVersion: string;
  },
) {
  database
    .prepare(
      `INSERT INTO topic_synthesis_runs(synthesis_run_id, topic_id, context_id,
       parent_snapshot_id, run_kind, state, retrieval_mode, scope_version, fts_generation_id,
       vector_space_id, graph_generation_id, input_watermark, input_hash,
       synthesis_rule_version, created_at) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.synthesisRunId,
      input.topicId,
      input.contextId,
      input.parentSnapshotId,
      input.parentSnapshotId ? "rebuild" : "full",
      input.mode,
      input.scopeVersion,
      input.pointers.ftsGenerationId,
      input.pointers.vectorSpaceId,
      input.pointers.graphGenerationId,
      input.inputWatermark,
      input.inputHash,
      input.ruleVersion,
      new Date().toISOString(),
    );
}

export function failTopicSynthesis(database: Database, runId: string, cause: unknown) {
  database
    .prepare(
      `UPDATE topic_synthesis_runs SET state = 'failed', error_json = ?, completed_at = ?
       WHERE synthesis_run_id = ? AND state = 'running'`,
    )
    .run(
      JSON.stringify({ code: failureCode(cause), message: safeMessage(cause) }),
      new Date().toISOString(),
      runId,
    );
}

export function saveTopicSnapshot(
  database: Database,
  input: {
    topic: TopicRow;
    synthesisRunId: string;
    inputHash: string;
    scope: Record<string, unknown>;
    watermarks: Record<string, unknown>;
    synthesis: TopicSynthesis;
    graph: { nodes: Array<Record<string, unknown>>; relations: Array<Record<string, unknown>> };
    timings: Record<string, number>;
    warnings: string[];
    candidateCount: number;
  },
) {
  const snapshotId = createResourceId("topic-snapshot");
  const now = new Date().toISOString();
  return database.transaction(() => {
    const current = database
      .query<{ latest_snapshot_id: string | null; version: number }, [string]>(
        "SELECT latest_snapshot_id, version FROM topics WHERE topic_id = ?",
      )
      .get(input.topic.topic_id);
    if (!current) throw failure("topic_not_found", "Topic does not exist", "not_found");
    if (current.version !== input.topic.version)
      throw failure(
        "topic_version_conflict",
        "Topic changed while synthesis was running",
        "conflict",
      );
    const parentId = current.latest_snapshot_id;
    const sequence = nextSequence(database, input.topic.topic_id);
    const changes = snapshotChanges(database, parentId, input.synthesis);
    const snapshotHash = sha256Text(
      JSON.stringify({
        input_hash: input.inputHash,
        scope: input.scope,
        claims: input.synthesis.claims.map((claim) => ({
          id: claim.claimId,
          cluster: claim.clusterKey,
          type: claim.conclusionType,
          confidence: claim.confidenceLevel,
          lineages: claim.sourceLineages,
        })),
        sections: input.synthesis.sections.map(sectionFingerprint),
        gaps: input.synthesis.gaps,
      }),
    );
    database
      .prepare(
        `INSERT INTO topic_snapshots(topic_snapshot_id, topic_id, synthesis_run_id,
         parent_snapshot_id, sequence, snapshot_hash, scope_json, watermarks_json,
         health_status, confidence_level, confidence_json, coverage_json,
         change_summary_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshotId,
        input.topic.topic_id,
        input.synthesisRunId,
        parentId,
        sequence,
        snapshotHash,
        JSON.stringify(input.scope),
        JSON.stringify(input.watermarks),
        input.synthesis.healthStatus,
        input.synthesis.confidenceLevel,
        JSON.stringify(input.synthesis.confidence),
        JSON.stringify(input.synthesis.coverage),
        JSON.stringify(changes.summary),
        now,
      );
    insertClaims(database, snapshotId, input.synthesis);
    insertLocalGraph(database, snapshotId, input.graph, input.synthesis);
    insertReport(database, snapshotId, parentId, input.synthesis, changes.sectionKinds, now);
    database
      .prepare(
        `UPDATE topic_synthesis_runs SET state = 'ready', candidate_count = ?, claim_count = ?,
         timings_json = ?, warnings_json = ?, completed_at = ? WHERE synthesis_run_id = ?`,
      )
      .run(
        input.candidateCount,
        input.synthesis.claims.length,
        JSON.stringify(input.timings),
        JSON.stringify(input.warnings),
        now,
        input.synthesisRunId,
      );
    database
      .prepare(
        `UPDATE topics SET latest_snapshot_id = ?, status = 'active', stale_reason = NULL,
         stale_at = NULL, updated_at = ? WHERE topic_id = ?`,
      )
      .run(snapshotId, now, input.topic.topic_id);
    return { topic_snapshot_id: snapshotId, sequence, snapshot_hash: snapshotHash };
  })();
}

function insertClaims(database: Database, snapshotId: string, synthesis: TopicSynthesis) {
  const insert = database.prepare(
    `INSERT INTO topic_snapshot_claims(topic_snapshot_id, claim_id, cluster_key,
     conclusion_type, role, independent_source_count, evidence_count, source_lineages_json,
     confidence_level, confidence_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const claim of synthesis.claims)
    insert.run(
      snapshotId,
      claim.claimId,
      claim.clusterKey,
      claim.conclusionType,
      claim.role,
      claim.independentSourceCount,
      claim.evidence.length,
      JSON.stringify(claim.sourceLineages),
      claim.confidenceLevel,
      JSON.stringify(claim.confidenceExplanation),
    );
}

function insertLocalGraph(
  database: Database,
  snapshotId: string,
  graph: { nodes: Array<Record<string, unknown>>; relations: Array<Record<string, unknown>> },
  synthesis: TopicSynthesis,
) {
  const claimNodes = new Set(synthesis.claims.map((claim) => claim.nodeId));
  const nodeInsert = database.prepare(
    `INSERT INTO topic_snapshot_nodes(topic_snapshot_id, node_id, node_kind, role)
     VALUES (?, ?, ?, ?)`,
  );
  for (const node of graph.nodes)
    nodeInsert.run(
      snapshotId,
      String(node.node_id),
      String(node.node_kind),
      claimNodes.has(String(node.node_id)) ? "supporting" : "core",
    );
  const disputedClaims = new Set(
    synthesis.claims
      .filter((claim) => claim.conclusionType === "conflict")
      .map((claim) => claim.claimId),
  );
  const relationInsert = database.prepare(
    `INSERT INTO topic_snapshot_relations(topic_snapshot_id, relation_id, predicate_key, role)
     VALUES (?, ?, ?, ?)`,
  );
  for (const relation of graph.relations)
    relationInsert.run(
      snapshotId,
      String(relation.relation_id),
      String(relation.predicate_key),
      disputedClaims.has(String(relation.claim_id)) ? "contradicting" : "supporting",
    );
}

function insertReport(
  database: Database,
  snapshotId: string,
  parentSnapshotId: string | null,
  synthesis: TopicSynthesis,
  changes: Map<string, "added" | "modified" | "unchanged">,
  now: string,
) {
  const outline = synthesis.sections.map((section, index) => ({
    ordinal: index + 1,
    kind: section.kind,
    title: section.title,
  }));
  database
    .prepare(
      `INSERT INTO topic_report_outlines(topic_snapshot_id, outline_json, outline_hash, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(snapshotId, JSON.stringify(outline), sha256Text(JSON.stringify(outline)), now);
  const previous = previousSections(database, parentSnapshotId);
  const sectionInsert = database.prepare(
    `INSERT INTO topic_report_sections(section_id, topic_snapshot_id, parent_section_id,
     ordinal, section_kind, title, summary_text, confidence_level, confidence_json,
     coverage_json, health_status, content_hash, change_kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const conclusionInsert = database.prepare(
    `INSERT INTO topic_report_conclusions(conclusion_id, section_id, ordinal, statement_text,
     conclusion_type, confidence_level, support_status, explanation_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const citationInsert = database.prepare(
    `INSERT INTO topic_report_citations(topic_citation_id, conclusion_id, claim_id,
     evidence_id, chunk_id, revision_id, source_id, snapshot_id, blob_sha256, excerpt_start,
     excerpt_end, excerpt_hash, source_lineage_key, directness, role, validation_rule, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'chunk-full-sha256-v1', ?)`,
  );
  synthesis.sections.forEach((section, sectionIndex) => {
    const sectionId = createResourceId("section");
    const hash = sha256Text(JSON.stringify(sectionFingerprint(section)));
    sectionInsert.run(
      sectionId,
      snapshotId,
      previous.get(section.kind)?.section_id ?? null,
      sectionIndex + 1,
      section.kind,
      section.title,
      section.summary,
      section.confidenceLevel,
      JSON.stringify(section.confidence),
      JSON.stringify(section.coverage),
      section.healthStatus,
      hash,
      changes.get(section.kind) ?? "added",
      now,
    );
    section.conclusions.forEach((conclusion, conclusionIndex) => {
      const conclusionId = createResourceId("conclusion");
      conclusionInsert.run(
        conclusionId,
        sectionId,
        conclusionIndex + 1,
        conclusion.statement,
        conclusion.conclusionType,
        conclusion.confidenceLevel,
        conclusion.claim ? "supported" : "not_applicable",
        JSON.stringify(conclusion.explanation),
      );
      const supportedClaim = conclusion.claim;
      if (supportedClaim)
        for (const evidence of supportedClaim.evidence)
          citationInsert.run(
            createResourceId("topic-citation"),
            conclusionId,
            supportedClaim.claimId,
            evidence.evidenceId,
            evidence.chunkId,
            evidence.revisionId,
            evidence.sourceId,
            evidence.snapshotId,
            evidence.blobSha256,
            0,
            evidence.content.length,
            sha256Text(evidence.content),
            evidence.sourceLineageKey,
            evidence.directness,
            evidence.role,
            now,
          );
    });
  });
  const gapInsert = database.prepare(
    `INSERT INTO topic_knowledge_gaps(knowledge_gap_id, topic_snapshot_id, ordinal,
     question_text, reason, severity, status, related_claim_ids_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
  );
  synthesis.gaps.forEach((gap, index) => {
    gapInsert.run(
      createResourceId("knowledge-gap"),
      snapshotId,
      index + 1,
      gap.question,
      gap.reason,
      gap.severity,
      JSON.stringify(gap.relatedClaimIds),
      now,
    );
  });
}

function snapshotChanges(database: Database, parentId: string | null, synthesis: TopicSynthesis) {
  const previousClaims = parentId
    ? database
        .query<{ claim_id: string }, [string]>(
          "SELECT claim_id FROM topic_snapshot_claims WHERE topic_snapshot_id = ?",
        )
        .all(parentId)
        .map((row) => row.claim_id)
    : [];
  const currentClaims = synthesis.claims.map((claim) => claim.claimId);
  const old = new Set(previousClaims);
  const current = new Set(currentClaims);
  const previous = previousSections(database, parentId);
  const sectionKinds = new Map<string, "added" | "modified" | "unchanged">();
  for (const section of synthesis.sections) {
    const before = previous.get(section.kind);
    const hash = sha256Text(JSON.stringify(sectionFingerprint(section)));
    sectionKinds.set(
      section.kind,
      before ? (before.content_hash === hash ? "unchanged" : "modified") : "added",
    );
  }
  return {
    sectionKinds,
    summary: {
      claims_added: currentClaims.filter((id) => !old.has(id)),
      claims_removed: previousClaims.filter((id) => !current.has(id)),
      claims_unchanged: currentClaims.filter((id) => old.has(id)).length,
      sections: Object.fromEntries(sectionKinds),
    },
  };
}

function previousSections(database: Database, snapshotId: string | null) {
  if (!snapshotId) return new Map<string, { section_id: string; content_hash: string }>();
  const rows = database
    .query<{ section_kind: string; section_id: string; content_hash: string }, [string]>(
      `SELECT section_kind, section_id, content_hash FROM topic_report_sections
       WHERE topic_snapshot_id = ?`,
    )
    .all(snapshotId);
  return new Map(rows.map((row) => [row.section_kind, row]));
}

function nextSequence(database: Database, topicId: string) {
  return (
    (database
      .query<{ sequence: number }, [string]>(
        "SELECT sequence FROM topic_snapshots WHERE topic_id = ? ORDER BY sequence DESC LIMIT 1",
      )
      .get(topicId)?.sequence ?? 0) + 1
  );
}

function sectionFingerprint(section: TopicSynthesis["sections"][number]) {
  return {
    kind: section.kind,
    title: section.title,
    summary: section.summary,
    confidence: section.confidenceLevel,
    coverage: section.coverage,
    conclusions: section.conclusions.map((row) => ({
      statement: row.statement,
      type: row.conclusionType,
      confidence: row.confidenceLevel,
      claim: row.claim?.claimId ?? null,
    })),
  };
}

function failureCode(cause: unknown) {
  return cause && typeof cause === "object" && "selfError" in cause
    ? String((cause as { selfError: { code: string } }).selfError.code)
    : "topic_synthesis_failed";
}

function safeMessage(cause: unknown) {
  return cause instanceof Error ? cause.message.slice(0, 500) : "Topic synthesis failed";
}
