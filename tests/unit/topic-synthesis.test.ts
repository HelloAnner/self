import { describe, expect, test } from "bun:test";
import { synthesizeTopic, type TopicClaimCandidate } from "../../src/domains/topic/index.ts";

describe("Topic trusted synthesis", () => {
  test("separates consensus, opinion, inference, conflict, and source lineages", () => {
    const consensus = claim("claim:clm_consensus", "fact", {
      lineages: ["original-a", "original-b", "original-a"],
    });
    const opinion = claim("claim:clm_opinion", "user_opinion");
    const inference = claim("claim:clm_inference", "inference");
    const conflict = claim("claim:clm_conflict", "fact", {
      status: "disputed",
      conflictIds: ["conflict:cfs_one"],
    });
    const result = synthesizeTopic([consensus, opinion, inference, conflict]);

    expect(result.claims.map((row) => row.conclusionType).sort()).toEqual([
      "conflict",
      "consensus",
      "inference",
      "user_opinion",
    ]);
    expect(result.claims.find((row) => row.claimId === consensus.claimId)).toMatchObject({
      independentSourceCount: 2,
      conclusionType: "consensus",
    });
    expect(result.healthStatus).toBe("needs_review");
    expect(result.confidenceLevel).toBe("disputed");
    expect(result.gaps.some((gap) => gap.relatedClaimIds.includes(conflict.claimId))).toBeTrue();
  });

  test("does not fill an evidence-free topic", () => {
    const result = synthesizeTopic([]);
    expect(result.healthStatus).toBe("insufficient");
    expect(result.confidenceLevel).toBe("unknown");
    expect(result.sections.map((section) => section.kind)).toEqual(["overview", "unknown"]);
    expect(result.sections[0]?.summary).toContain("资料不足");
  });

  test("keeps one lineage as a single-source statement despite reposts", () => {
    const result = synthesizeTopic([
      claim("claim:clm_repost", "fact", { lineages: ["same-blob", "same-blob", "same-blob"] }),
    ]);
    expect(result.claims[0]).toMatchObject({
      conclusionType: "single_source",
      independentSourceCount: 1,
    });
    expect(result.gaps[0]?.severity).toBe("medium");
  });
});

function claim(
  claimId: string,
  epistemicStatus: TopicClaimCandidate["epistemicStatus"],
  options: { lineages?: string[]; status?: string; conflictIds?: string[] } = {},
): TopicClaimCandidate {
  const lineages = options.lineages ?? [`lineage-${claimId}`];
  return {
    claimId,
    nodeId: `graph-node:gn_${claimId}`,
    subjectNodeId: "graph-node:gn_subject",
    predicateKey: "describes",
    objectNodeId: null,
    qualifierHash: "a".repeat(64),
    normalizedStatement: `Statement for ${claimId}`,
    epistemicStatus,
    status: options.status ?? "accepted",
    confidenceLevel: options.status === "disputed" ? "disputed" : "medium",
    confidence: { level: "medium" },
    origin: "model",
    conflictIds: options.conflictIds ?? [],
    evidence: lineages.map((lineage, index) => ({
      evidenceId: `evidence:evd_${index}_${claimId}`,
      chunkId: `chunk:chk_${index}_${claimId}`,
      revisionId: `revision:rev_${index}_${claimId}`,
      sourceId: `source:src_${index}_${claimId}`,
      snapshotId: `snapshot:snp_${index}_${claimId}`,
      blobSha256: `${index}`.padEnd(64, "0"),
      content: `Evidence ${index}`,
      sourceLineageKey: lineage,
      role: "support",
      directness: "direct",
    })),
  };
}
