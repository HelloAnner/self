export const PAGE_IR_COMPONENT_TYPES = [
  "hero",
  "conclusion_cards",
  "evidence_blocks",
  "timeline",
  "comparison_matrix",
  "knowledge_graph",
  "conflicts",
  "knowledge_gaps",
  "source_directory",
] as const;

export type PageIrComponentType = (typeof PAGE_IR_COMPONENT_TYPES)[number];

export type PageIrCitation = {
  citationId: string;
  topicCitationId: string;
  claimId: string;
  chunkId: string;
  revisionId: string;
  snapshotId: string;
  sourceId: string;
  sourceName: string;
  sourceKind: string;
  logicalPath: string | null;
  excerpt: string;
  excerptHash: string;
  directness: string;
  role: string;
};

export type PageIrComponent = {
  key: string;
  type: PageIrComponentType;
  title: string;
  topicSectionId: string | null;
  confidenceLevel: string | null;
  healthStatus: string | null;
  contentHash: string;
  dependencyHash: string;
  payload: Record<string, unknown>;
};

export type PageIrV1 = {
  schema: "self.page-ir";
  version: 1;
  artifact: {
    artifactId: string;
    buildId: string;
    parentBuildId: string | null;
    buildKind: "full" | "refresh" | "render";
  };
  topic: {
    topicId: string;
    snapshotId: string;
    title: string;
    scope: string;
    description: string | null;
    snapshotSequence: number;
    healthStatus: string;
    confidenceLevel: string;
    coverage: Record<string, unknown>;
    generatedAt: string;
  };
  template: { id: string; version: string };
  theme: { id: string; version: string };
  components: PageIrComponent[];
  citations: PageIrCitation[];
};

export type ArtifactBuildKind = PageIrV1["artifact"]["buildKind"];
