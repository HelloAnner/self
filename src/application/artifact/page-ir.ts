import type {
  ArtifactBuildKind,
  PageIrCitation,
  PageIrComponent,
  PageIrComponentType,
  PageIrV1,
} from "../../domains/artifact/index.ts";
import { sha256Text } from "../../shared/hash/sha256.ts";

type Row = Record<string, unknown>;

export function createTopicPageIr(
  report: Row,
  input: {
    artifactId: string;
    buildId: string;
    parentBuildId: string | null;
    buildKind: ArtifactBuildKind;
    templateId: string;
    templateVersion: string;
    themeId: string;
    themeVersion: string;
  },
): PageIrV1 {
  const topic = row(report.topic);
  const snapshot = row(report.snapshot);
  const reportData = row(report.report);
  const knowledge = row(report.knowledge_snapshot);
  const sections = rows(reportData.sections);
  const claims = rows(knowledge.claims);
  const graph = row(knowledge.local_graph);
  const citations = collectCitations(sections);
  const components: PageIrComponent[] = [];
  const overview = sections.find((section) => section.section_kind === "overview");
  components.push(
    component(
      "hero",
      "hero",
      String(topic.name),
      overview ? String(overview.section_id) : null,
      String(snapshot.confidence_level),
      String(snapshot.health_status),
      {
        eyebrow: "SELF / EVIDENCE DOSSIER",
        summary: overview ? String(overview.summary_text) : "资料不足。",
        scope: String(topic.scope_text),
        description: topic.description ? String(topic.description) : null,
        metrics: row(snapshot.coverage_json),
        sequence: Number(snapshot.sequence),
      },
      [String(snapshot.snapshot_hash)],
    ),
  );
  for (const section of sections.filter(
    (item) => !["overview", "unknown", "conflict"].includes(String(item.section_kind)),
  ))
    components.push(sectionCards(section));
  components.push(evidenceComponent(citations));
  const temporal = claims.filter((claim) => claim.valid_from || claim.valid_to);
  if (temporal.length > 0) components.push(timelineComponent(temporal));
  if (claims.length > 1) components.push(comparisonComponent(claims));
  if (rows(graph.nodes).length > 0) components.push(graphComponent(graph));
  const conflict = sections.find((section) => section.section_kind === "conflict");
  if (conflict) components.push(conflictComponent(conflict));
  const gaps = rows(reportData.knowledge_gaps);
  if (gaps.length > 0) components.push(gapsComponent(gaps));
  components.push(sourceComponent(citations));
  return {
    schema: "self.page-ir",
    version: 1,
    artifact: {
      artifactId: input.artifactId,
      buildId: input.buildId,
      parentBuildId: input.parentBuildId,
      buildKind: input.buildKind,
    },
    topic: {
      topicId: String(topic.topic_id),
      snapshotId: String(snapshot.topic_snapshot_id),
      title: String(topic.name),
      scope: String(topic.scope_text),
      description: topic.description ? String(topic.description) : null,
      snapshotSequence: Number(snapshot.sequence),
      healthStatus: String(snapshot.health_status),
      confidenceLevel: String(snapshot.confidence_level),
      coverage: row(snapshot.coverage_json),
      generatedAt: String(snapshot.created_at),
    },
    template: { id: input.templateId, version: input.templateVersion },
    theme: { id: input.themeId, version: input.themeVersion },
    components,
    citations,
  };
}

function sectionCards(section: Row) {
  const conclusions = rows(section.conclusions).map((conclusion) => {
    const statement = String(conclusion.statement_text);
    const type = String(conclusion.conclusion_type);
    return {
      conclusion_id: `conclusion-${sha256Text(`${type}\n${statement}`).slice(0, 20)}`,
      statement,
      type,
      confidence: String(conclusion.confidence_level),
      explanation: row(conclusion.explanation_json),
      citation_ids: rows(conclusion.citations).map(pageCitationId),
    };
  });
  return component(
    `section-${String(section.section_kind)}`,
    "conclusion_cards",
    String(section.title),
    String(section.section_id),
    String(section.confidence_level),
    String(section.health_status),
    { summary: String(section.summary_text), kind: String(section.section_kind), conclusions },
    conclusions.flatMap((item) => [item.conclusion_id, ...item.citation_ids]),
  );
}

function evidenceComponent(citations: PageIrCitation[]) {
  return component(
    "evidence-ledger",
    "evidence_blocks",
    "证据账本",
    null,
    null,
    null,
    { citations },
    citations.flatMap((item) => [item.citationId, item.excerptHash]),
  );
}

function timelineComponent(claims: Row[]) {
  const events = claims.map((claim) => ({
    claim_id: String(claim.claim_id),
    label: String(claim.normalized_statement),
    from: claim.valid_from ? String(claim.valid_from) : null,
    to: claim.valid_to ? String(claim.valid_to) : null,
    confidence: String(claim.confidence_level),
  }));
  return component(
    "timeline",
    "timeline",
    "时间脉络",
    null,
    null,
    null,
    { events },
    claimIds(claims),
  );
}

function comparisonComponent(claims: Row[]) {
  const columns = [...new Set(claims.map((claim) => String(claim.conclusion_type)))];
  const entries = claims.map((claim) => ({
    claim_id: String(claim.claim_id),
    category: String(claim.conclusion_type),
    statement: String(claim.normalized_statement),
    confidence: String(claim.confidence_level),
    sources: Number(claim.independent_source_count),
  }));
  return component(
    "comparison",
    "comparison_matrix",
    "结论对照",
    null,
    null,
    null,
    { columns, entries },
    claimIds(claims),
  );
}

function graphComponent(graph: Row) {
  const nodes = rows(graph.nodes).map((node) => ({
    id: String(node.node_id),
    label: String(node.canonical_label),
    kind: String(node.node_kind),
    role: String(node.role),
  }));
  const edges = rows(graph.relations).map((edge) => ({
    id: String(edge.relation_id),
    source: String(edge.subject_node_id),
    target: String(edge.object_node_id),
    label: String(edge.predicate_key),
    confidence: String(edge.confidence_level),
  }));
  return component(
    "knowledge-graph",
    "knowledge_graph",
    "局部知识图谱",
    null,
    null,
    null,
    { nodes, edges },
    [...nodes.map((node) => node.id), ...edges.map((edge) => edge.id)],
  );
}

function conflictComponent(section: Row) {
  const positions = rows(section.conclusions).map((conclusion) => {
    const statement = String(conclusion.statement_text);
    return {
      conclusion_id: `position-${sha256Text(statement).slice(0, 20)}`,
      statement,
      confidence: String(conclusion.confidence_level),
      citation_ids: rows(conclusion.citations).map(pageCitationId),
    };
  });
  return component(
    "conflicts",
    "conflicts",
    String(section.title),
    String(section.section_id),
    String(section.confidence_level),
    String(section.health_status),
    { summary: String(section.summary_text), positions },
    positions.flatMap((item) => [item.conclusion_id, ...item.citation_ids]),
  );
}

function gapsComponent(gaps: Row[]) {
  const items = gaps.map((gap) => ({
    gap_id: `gap-${sha256Text(String(gap.question_text)).slice(0, 20)}`,
    question: String(gap.question_text),
    reason: String(gap.reason),
    severity: String(gap.severity),
    related_claim_ids: array(gap.related_claim_ids_json).map(String),
  }));
  return component(
    "knowledge-gaps",
    "knowledge_gaps",
    "未知与待查",
    null,
    "unknown",
    "insufficient",
    { items },
    items.flatMap((item) => [item.gap_id, ...item.related_claim_ids]),
  );
}

function sourceComponent(citations: PageIrCitation[]) {
  const unique = new Map<string, PageIrCitation>();
  for (const citation of citations) unique.set(citation.sourceId, citation);
  const sources = [...unique.values()].map((citation) => ({
    source_id: citation.sourceId,
    name: citation.sourceName,
    kind: citation.sourceKind,
    logical_path: citation.logicalPath,
    citation_count: citations.filter((item) => item.sourceId === citation.sourceId).length,
  }));
  return component(
    "source-directory",
    "source_directory",
    "资料目录",
    null,
    null,
    null,
    { sources },
    sources.map((source) => source.source_id),
  );
}

function collectCitations(sections: Row[]): PageIrCitation[] {
  const citations = new Map<string, PageIrCitation>();
  for (const section of sections)
    for (const conclusion of rows(section.conclusions))
      for (const citation of rows(conclusion.citations)) {
        const citationId = pageCitationId(citation);
        citations.set(citationId, {
          citationId,
          topicCitationId: String(citation.topic_citation_id),
          claimId: String(citation.claim_id),
          chunkId: String(citation.chunk_id),
          revisionId: String(citation.revision_id),
          snapshotId: String(citation.snapshot_id),
          sourceId: String(citation.source_id),
          sourceName: String(citation.source_name),
          sourceKind: String(citation.source_kind),
          logicalPath: citation.logical_path ? String(citation.logical_path) : null,
          excerpt: String(citation.excerpt_text),
          excerptHash: String(citation.excerpt_hash),
          directness: String(citation.directness),
          role: String(citation.role),
        });
      }
  return [...citations.values()].sort((left, right) =>
    left.citationId.localeCompare(right.citationId),
  );
}

function pageCitationId(citation: Row) {
  return `cite-${sha256Text(
    `${String(citation.claim_id)}\n${String(citation.chunk_id)}\n${String(citation.excerpt_hash)}`,
  ).slice(0, 20)}`;
}

function component(
  key: string,
  type: PageIrComponentType,
  title: string,
  topicSectionId: string | null,
  confidenceLevel: string | null,
  healthStatus: string | null,
  payload: Record<string, unknown>,
  dependencies: string[],
): PageIrComponent {
  return {
    key,
    type,
    title,
    topicSectionId,
    confidenceLevel,
    healthStatus,
    contentHash: sha256Text(JSON.stringify(payload)),
    dependencyHash: sha256Text([...dependencies].sort().join("\n")),
    payload,
  };
}

function claimIds(claims: Row[]) {
  return claims.map((claim) => String(claim.claim_id));
}

function row(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
}

function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter((item) => row(item) === item) : [];
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
