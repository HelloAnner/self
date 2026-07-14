import { sha256Text } from "../../../shared/hash/sha256.ts";
import type {
  SynthesizedClaim,
  TopicClaimCandidate,
  TopicConclusionType,
  TopicGap,
  TopicSectionDraft,
  TopicSynthesis,
} from "../model/types.ts";

export const TOPIC_SYNTHESIS_RULE_VERSION = "topic-synthesis-rules-v1";

const SECTION_META: Record<TopicConclusionType, { title: string; empty: string }> = {
  consensus: { title: "多源共识", empty: "当前没有获得多个独立来源共同支持的结论。" },
  single_source: { title: "单一来源陈述", empty: "当前没有单一来源陈述。" },
  user_opinion: { title: "用户观点", empty: "当前没有被明确识别的用户观点。" },
  inference: { title: "AI 推断", empty: "当前没有被明确标记的推断。" },
  conflict: { title: "争议与冲突", empty: "当前没有未解决冲突。" },
  unknown: { title: "未知与信息缺口", empty: "当前没有已识别的信息缺口。" },
};

export function synthesizeTopic(candidates: TopicClaimCandidate[]): TopicSynthesis {
  const claims = candidates.map(classifyClaim).sort(compareClaims);
  const gaps = knowledgeGaps(claims);
  const grouped = new Map<TopicConclusionType, SynthesizedClaim[]>();
  for (const claim of claims) {
    const rows = grouped.get(claim.conclusionType) ?? [];
    rows.push(claim);
    grouped.set(claim.conclusionType, rows);
  }
  const sections: TopicSectionDraft[] = [overview(claims, gaps)];
  for (const kind of [
    "consensus",
    "single_source",
    "user_opinion",
    "inference",
    "conflict",
  ] as const) {
    const rows = grouped.get(kind) ?? [];
    if (rows.length > 0) sections.push(claimSection(kind, rows));
  }
  if (gaps.length > 0) sections.push(gapSection(gaps));
  const conflictCount = grouped.get("conflict")?.length ?? 0;
  const consensusCount = grouped.get("consensus")?.length ?? 0;
  const healthStatus =
    claims.length === 0
      ? "insufficient"
      : conflictCount > 0
        ? "needs_review"
        : consensusCount > 0
          ? "healthy"
          : "degraded";
  const confidenceLevel = reportConfidence(claims, healthStatus);
  const uniqueLineages = new Set(claims.flatMap((claim) => claim.sourceLineages)).size;
  return {
    claims,
    sections,
    gaps,
    healthStatus,
    confidenceLevel,
    confidence: {
      method: TOPIC_SYNTHESIS_RULE_VERSION,
      decisive_rule:
        healthStatus === "needs_review"
          ? "unresolved_conflict"
          : healthStatus === "insufficient"
            ? "no_supported_claim"
            : consensusCount > 0
              ? "strongest_key_claims"
              : "single_lineage_limit",
      claim_levels: countBy(claims.map((claim) => claim.confidenceLevel)),
      unresolved_conflicts: conflictCount,
      explanation:
        "Report confidence follows key Claims, source independence, directness, and unresolved conflicts; it is not an average probability.",
    },
    coverage: {
      claims: claims.length,
      independent_source_lineages: uniqueLineages,
      evidence_items: claims.reduce((sum, claim) => sum + claim.evidence.length, 0),
      consensus_claims: consensusCount,
      conflict_claims: conflictCount,
      knowledge_gaps: gaps.length,
    },
  };
}

function classifyClaim(claim: TopicClaimCandidate): SynthesizedClaim {
  const sourceLineages = [...new Set(claim.evidence.map((item) => item.sourceLineageKey))].sort();
  const disputed = claim.status === "disputed" || claim.conflictIds.length > 0;
  const conclusionType = disputed
    ? "conflict"
    : claim.epistemicStatus === "user_opinion"
      ? "user_opinion"
      : claim.epistemicStatus === "inference"
        ? "inference"
        : sourceLineages.length >= 2
          ? "consensus"
          : "single_source";
  const clusterKey = sha256Text(
    [
      claim.subjectNodeId ?? "",
      claim.predicateKey ?? "",
      claim.qualifierHash,
      claim.conflictIds.sort().join(","),
    ].join("\n") || claim.normalizedStatement,
  );
  return {
    ...claim,
    clusterKey,
    conclusionType,
    role: disputed ? "contradicting" : conclusionType === "consensus" ? "core" : "supporting",
    independentSourceCount: sourceLineages.length,
    sourceLineages,
    confidenceExplanation: {
      inherited_claim_confidence: claim.confidence,
      independent_source_count: sourceLineages.length,
      evidence_count: claim.evidence.length,
      repost_or_duplicate_count: Math.max(0, claim.evidence.length - sourceLineages.length),
      unresolved_conflict_ids: claim.conflictIds,
      epistemic_status: claim.epistemicStatus,
      reason:
        conclusionType === "consensus"
          ? "Supported by at least two independent source lineages."
          : conclusionType === "conflict"
            ? "An unresolved Graph conflict is preserved."
            : conclusionType === "user_opinion"
              ? "The source Claim explicitly marks this as user opinion."
              : conclusionType === "inference"
                ? "The source Claim explicitly marks this as inference."
                : "Only one independent source lineage currently supports this Claim.",
    },
  };
}

function overview(claims: SynthesizedClaim[], gaps: TopicGap[]): TopicSectionDraft {
  const kinds = countBy(claims.map((claim) => claim.conclusionType));
  const conflicts = Number(kinds.conflict ?? 0);
  const healthStatus =
    claims.length === 0 ? "insufficient" : conflicts > 0 ? "needs_review" : "healthy";
  return {
    kind: "overview",
    title: "综合概览",
    summary:
      claims.length === 0
        ? "资料不足：当前 Topic 范围内没有可核验 Claim。"
        : `已综合 ${claims.length} 条 Claim，识别 ${Number(kinds.consensus ?? 0)} 条多源共识、${conflicts} 条争议和 ${gaps.length} 个信息缺口。`,
    confidenceLevel: reportConfidence(claims, healthStatus),
    confidence: { method: TOPIC_SYNTHESIS_RULE_VERSION, key_claim_count: claims.length },
    coverage: { claims: claims.length, gaps: gaps.length, conclusion_types: kinds },
    healthStatus,
    conclusions: [],
  };
}

function claimSection(
  kind: Exclude<TopicConclusionType, "unknown">,
  claims: SynthesizedClaim[],
): TopicSectionDraft {
  const lineages = new Set(claims.flatMap((claim) => claim.sourceLineages)).size;
  const disputed = kind === "conflict";
  return {
    kind,
    title: SECTION_META[kind].title,
    summary: `${claims.length} 条结论，来自 ${lineages} 个独立来源谱系。${disputed ? "冲突双方均被保留，尚未裁决。" : ""}`,
    confidenceLevel: disputed
      ? "disputed"
      : strongest(claims.map((claim) => claim.confidenceLevel)),
    confidence: {
      method: TOPIC_SYNTHESIS_RULE_VERSION,
      independent_source_lineages: lineages,
      unresolved_conflict: disputed,
      explanation: disputed
        ? "Unresolved positions are displayed together."
        : "Section confidence follows its strongest supported key Claims while preserving weaker labels per conclusion.",
    },
    coverage: { claims: claims.length, independent_source_lineages: lineages },
    healthStatus: disputed ? "needs_review" : kind === "single_source" ? "degraded" : "healthy",
    conclusions: claims.map((claim) => ({
      statement: claim.normalizedStatement,
      conclusionType: kind,
      confidenceLevel: disputed ? "disputed" : claim.confidenceLevel,
      claim,
      explanation: claim.confidenceExplanation,
    })),
  };
}

function gapSection(gaps: TopicGap[]): TopicSectionDraft {
  return {
    kind: "unknown",
    title: SECTION_META.unknown.title,
    summary: `${gaps.length} 个问题尚无充分资料，系统不补写未知内容。`,
    confidenceLevel: "unknown",
    confidence: { method: TOPIC_SYNTHESIS_RULE_VERSION, reason: "knowledge_gaps" },
    coverage: { knowledge_gaps: gaps.length },
    healthStatus: "insufficient",
    conclusions: gaps.map((gap) => ({
      statement: gap.question,
      conclusionType: "unknown",
      confidenceLevel: "unknown",
      explanation: { reason: gap.reason, severity: gap.severity },
    })),
  };
}

function knowledgeGaps(claims: SynthesizedClaim[]): TopicGap[] {
  if (claims.length === 0)
    return [
      {
        question: "当前主题有哪些可由原始资料直接支持的核心结论？",
        reason: "No evidence-backed Claim was retrieved for the Topic scope.",
        severity: "high",
        relatedClaimIds: [],
      },
    ];
  const gaps: TopicGap[] = [];
  const conflicts = claims.filter((claim) => claim.conclusionType === "conflict");
  if (conflicts.length > 0)
    gaps.push({
      question: "哪些新增原始证据可以解决当前互不兼容的说法？",
      reason: "At least one unresolved Graph conflict remains.",
      severity: "high",
      relatedClaimIds: conflicts.map((claim) => claim.claimId),
    });
  const single = claims.filter((claim) => claim.conclusionType === "single_source");
  if (single.length > 0)
    gaps.push({
      question: "哪些单一来源陈述可以获得独立来源印证？",
      reason: "One or more Claims have only one independent source lineage.",
      severity: "medium",
      relatedClaimIds: single.map((claim) => claim.claimId),
    });
  return gaps;
}

function reportConfidence(
  claims: SynthesizedClaim[],
  health: "healthy" | "degraded" | "needs_review" | "insufficient",
) {
  if (health === "needs_review") return "disputed" as const;
  if (health === "insufficient" || claims.length === 0) return "unknown" as const;
  const key = claims.filter((claim) => claim.role === "core");
  return strongest((key.length > 0 ? key : claims).map((claim) => claim.confidenceLevel));
}

function strongest(values: string[]) {
  if (values.includes("high")) return "high" as const;
  if (values.includes("medium")) return "medium" as const;
  if (values.includes("low")) return "low" as const;
  if (values.includes("disputed")) return "disputed" as const;
  return "unknown" as const;
}

function countBy(values: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

function compareClaims(left: SynthesizedClaim, right: SynthesizedClaim) {
  return (
    left.conclusionType.localeCompare(right.conclusionType) ||
    left.clusterKey.localeCompare(right.clusterKey) ||
    left.claimId.localeCompare(right.claimId)
  );
}
