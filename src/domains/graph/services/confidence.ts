import type { ConfidenceAssessment, ConfidenceDimensions, Directness } from "../model/types.ts";

export function assessConfidence(input: {
  sourceQuality?: number;
  directness: Directness;
  independentSourceCount: number;
  ageDays?: number;
  extractionQuality: number;
  disputed: boolean;
  userVerification: "none" | "confirmed" | "rejected";
}): ConfidenceAssessment {
  const dimensions: ConfidenceDimensions = {
    source_quality: clamp(input.sourceQuality ?? 0.6),
    directness: input.directness === "direct" ? 1 : input.directness === "paraphrase" ? 0.7 : 0.4,
    corroboration: clamp(
      input.independentSourceCount <= 1
        ? 0.35
        : 0.65 + 0.1 * Math.min(3, input.independentSourceCount - 2),
    ),
    freshness: freshness(input.ageDays),
    extraction_quality: clamp(input.extractionQuality),
    consistency: input.disputed ? 0.15 : 1,
    user_verification:
      input.userVerification === "confirmed" ? 1 : input.userVerification === "rejected" ? 0 : 0.5,
  };
  const score = round(
    dimensions.source_quality * 0.16 +
      dimensions.directness * 0.18 +
      dimensions.corroboration * 0.18 +
      dimensions.freshness * 0.1 +
      dimensions.extraction_quality * 0.14 +
      dimensions.consistency * 0.16 +
      dimensions.user_verification * 0.08,
  );
  const level = input.disputed
    ? "disputed"
    : score >= 0.78
      ? "high"
      : score >= 0.55
        ? "medium"
        : score >= 0.3
          ? "low"
          : "unknown";
  const reasons = [
    `${input.independentSourceCount} independent source lineage${input.independentSourceCount === 1 ? "" : "s"}`,
    `${input.directness} evidence`,
    input.disputed ? "unresolved contradictory evidence" : "no unresolved conflict",
    input.userVerification === "none" ? "not user verified" : `user ${input.userVerification}`,
  ];
  return {
    dimensions,
    independent_source_count: input.independentSourceCount,
    level,
    score,
    reasons,
  };
}

function freshness(ageDays: number | undefined): number {
  if (ageDays === undefined || !Number.isFinite(ageDays)) return 0.6;
  if (ageDays <= 30) return 1;
  if (ageDays <= 365) return 0.8;
  if (ageDays <= 1_825) return 0.6;
  return 0.4;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
