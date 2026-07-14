export type SearchMode = "text" | "vector" | "hybrid";

export type SearchFilters = {
  sourceId?: string;
  pathPrefix?: string;
  mediaType?: string;
  tag?: string;
  since?: string;
  until?: string;
};

export type RouteCandidate = {
  chunk_id: string;
  rank: number;
  raw_score: number;
  route: "fts" | "vector";
  distance?: number;
};

export type AskDepth = "shallow" | "normal" | "deep";

export type RetrievalPlan = {
  version: "retrieval-plan-v1";
  query: string;
  queryHash: string;
  mode: SearchMode;
  depth: AskDepth;
  seedLimit: number;
  graphDepth: number;
  graphMaxClaims: number;
  contextTokenBudget: number;
  filters: SearchFilters;
};

export type EvidenceContextItem = {
  evidenceKey: string;
  chunkId: string;
  documentId: string;
  revisionId: string;
  sourceId: string;
  snapshotId: string;
  blobSha256: string;
  content: string;
  excerptStart: number;
  excerptEnd: number;
  tokenEstimate: number;
  role: "seed" | "graph_support" | "graph_contradict";
  claimId?: string;
  claimStatus?: string;
  claimConfidenceLevel?: string;
};

export type AnswerConclusionType =
  | "fact"
  | "single_source"
  | "user_opinion"
  | "inference"
  | "conflict"
  | "unknown"
  | "model_knowledge";
