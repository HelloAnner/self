export type TopicConclusionType =
  | "consensus"
  | "single_source"
  | "user_opinion"
  | "inference"
  | "conflict"
  | "unknown";

export type TopicConfidenceLevel = "high" | "medium" | "low" | "disputed" | "unknown";

export type TopicEvidence = {
  evidenceId: string;
  chunkId: string;
  revisionId: string;
  sourceId: string;
  snapshotId: string;
  blobSha256: string;
  content: string;
  sourceLineageKey: string;
  role: "support" | "contradict" | "context" | "definition";
  directness: "direct" | "paraphrase" | "inferred";
};

export type TopicClaimCandidate = {
  claimId: string;
  nodeId: string;
  subjectNodeId: string | null;
  predicateKey: string | null;
  objectNodeId: string | null;
  qualifierHash: string;
  normalizedStatement: string;
  epistemicStatus: "fact" | "user_opinion" | "inference" | "unknown";
  status: string;
  confidenceLevel: TopicConfidenceLevel;
  confidence: Record<string, unknown>;
  origin: string;
  conflictIds: string[];
  evidence: TopicEvidence[];
};

export type SynthesizedClaim = TopicClaimCandidate & {
  clusterKey: string;
  conclusionType: Exclude<TopicConclusionType, "unknown">;
  role: "core" | "supporting" | "contradicting" | "context" | "excluded";
  independentSourceCount: number;
  sourceLineages: string[];
  confidenceExplanation: Record<string, unknown>;
};

export type TopicGap = {
  question: string;
  reason: string;
  severity: "high" | "medium" | "low";
  relatedClaimIds: string[];
};

export type TopicSectionDraft = {
  kind: "overview" | TopicConclusionType;
  title: string;
  summary: string;
  confidenceLevel: TopicConfidenceLevel;
  confidence: Record<string, unknown>;
  coverage: Record<string, unknown>;
  healthStatus: "healthy" | "degraded" | "needs_review" | "insufficient";
  conclusions: Array<{
    statement: string;
    conclusionType: TopicConclusionType;
    confidenceLevel: TopicConfidenceLevel;
    claim?: SynthesizedClaim;
    explanation: Record<string, unknown>;
  }>;
};

export type TopicSynthesis = {
  claims: SynthesizedClaim[];
  sections: TopicSectionDraft[];
  gaps: TopicGap[];
  healthStatus: "healthy" | "degraded" | "needs_review" | "insufficient";
  confidenceLevel: TopicConfidenceLevel;
  confidence: Record<string, unknown>;
  coverage: Record<string, unknown>;
};
