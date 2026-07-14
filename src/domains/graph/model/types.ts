export const ENTITY_TYPES = [
  "person",
  "organization",
  "project",
  "concept",
  "technology",
  "product",
  "event",
  "place",
  "work",
  "dataset",
  "method",
  "standard",
  "user_defined",
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];
export type EvidenceRole = "support" | "contradict" | "context" | "definition";
export type Directness = "direct" | "paraphrase" | "inferred";
export type ConfidenceLevel = "high" | "medium" | "low" | "disputed" | "unknown";

export type ConfidenceDimensions = {
  source_quality: number;
  directness: number;
  corroboration: number;
  freshness: number;
  extraction_quality: number;
  consistency: number;
  user_verification: number;
};

export type ConfidenceAssessment = {
  dimensions: ConfidenceDimensions;
  independent_source_count: number;
  level: ConfidenceLevel;
  score: number;
  reasons: string[];
};

export type ExtractedEntity = {
  local_id: string;
  name: string;
  type: EntityType;
  aliases: string[];
  identity_key?: string | undefined;
  evidence_excerpt: string;
};

export type ExtractedClaim = {
  statement: string;
  subject_local_id: string;
  predicate: string;
  object_local_id?: string | undefined;
  value?: string | number | boolean | undefined;
  qualifiers: Record<string, string>;
  valid_from?: string | undefined;
  valid_to?: string | undefined;
  epistemic_status: "fact" | "user_opinion" | "inference" | "unknown";
  evidence_role: EvidenceRole;
  directness: Directness;
  evidence_excerpt: string;
};

export type GraphExtraction = {
  entities: ExtractedEntity[];
  claims: ExtractedClaim[];
};
