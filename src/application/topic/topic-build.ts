import { createRetrievalPlan, type SearchMode } from "../../domains/retrieval/index.ts";
import { synthesizeTopic, TOPIC_SYNTHESIS_RULE_VERSION } from "../../domains/topic/index.ts";
import { sha256Text } from "../../infrastructure/filesystem/hash.ts";
import {
  readonlyModelDatabase,
  writableModelDatabase,
} from "../../infrastructure/model/model-db.ts";
import {
  activeRetrievalPointers,
  createRetrievalRecords,
  graphEvidenceForSeeds,
} from "../../infrastructure/retrieval/evidence-repository.ts";
import { hydrateCandidates } from "../../infrastructure/retrieval/search-repository.ts";
import {
  loadTopicClaims,
  localTopicGraph,
} from "../../infrastructure/topic/topic-candidate-repository.ts";
import { requireTopic, topicView } from "../../infrastructure/topic/topic-lifecycle-repository.ts";
import { topicReport } from "../../infrastructure/topic/topic-query-repository.ts";
import {
  beginTopicSynthesis,
  failTopicSynthesis,
  saveTopicSnapshot,
} from "../../infrastructure/topic/topic-snapshot-repository.ts";
import { failure, SelfFailure } from "../../shared/errors/self-error.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import { assembleContext } from "../retrieval/ask.ts";
import { searchKnowledge } from "../retrieval/search.ts";

const TOPIC_CONTEXT_PROMPT_VERSION = "topic-evidence-context-v1";

export async function buildTopic(
  root: string,
  topicId: string,
  input: { mode?: SearchMode; limit?: number; tokenBudget?: number; templateId?: string } = {},
) {
  const snapshot = await synthesizeTopicSnapshot(root, topicId, input);
  const { buildTopicArtifact } = await import("../artifact/artifact-build.ts");
  const artifact = await buildTopicArtifact(root, topicId, String(snapshot.topic_snapshot_id), {
    kind: "full",
    ...(input.templateId ? { templateId: input.templateId } : {}),
  });
  return { ...snapshot, artifact_build: artifact };
}

export async function refreshTopic(
  root: string,
  topicId: string,
  input: { mode?: SearchMode; limit?: number; tokenBudget?: number; templateId?: string } = {},
) {
  const snapshot = await synthesizeTopicSnapshot(root, topicId, { ...input, refresh: true });
  if (snapshot.unchanged) {
    const { readTopicArtifact } = await import("../artifact/artifact-queries.ts");
    try {
      return { ...snapshot, artifact_build: await readTopicArtifact(root, topicId) };
    } catch (cause) {
      if (!(cause instanceof SelfFailure) || cause.selfError.code !== "artifact_not_found")
        throw cause;
      const { buildTopicArtifact } = await import("../artifact/artifact-build.ts");
      const artifact = await buildTopicArtifact(root, topicId, String(snapshot.topic_snapshot_id), {
        kind: "refresh",
        ...(input.templateId ? { templateId: input.templateId } : {}),
      });
      return { ...snapshot, artifact_build: artifact };
    }
  }
  const { buildTopicArtifact } = await import("../artifact/artifact-build.ts");
  const artifact = await buildTopicArtifact(root, topicId, String(snapshot.topic_snapshot_id), {
    kind: "refresh",
    ...(input.templateId ? { templateId: input.templateId } : {}),
  });
  return { ...snapshot, artifact_build: artifact };
}

async function synthesizeTopicSnapshot(
  root: string,
  topicId: string,
  input: {
    mode?: SearchMode;
    limit?: number;
    tokenBudget?: number;
    refresh?: boolean;
    templateId?: string;
  } = {},
) {
  const limit = input.limit ?? 50;
  const tokenBudget = input.tokenBudget ?? 24_000;
  if (!Number.isInteger(limit) || limit < 5 || limit > 100)
    throw failure("topic_candidate_limit_invalid", "Topic candidate limit must be 5..100", "usage");
  if (!Number.isInteger(tokenBudget) || tokenBudget < 1_024 || tokenBudget > 64_000)
    throw failure(
      "topic_context_budget_invalid",
      "Topic token budget must be 1024..64000",
      "usage",
    );
  let database = await readonlyModelDatabase(root);
  const topic = requireTopic(database, topicId);
  if (topic.status === "deleted") {
    database.close();
    throw failure("topic_deleted", "Deleted Topic cannot be built", "state");
  }
  const view = topicView(database, topicId);
  if (input.refresh && topic.status === "active" && topic.latest_snapshot_id) {
    const report = topicReport(database, topicId, topic.latest_snapshot_id);
    const snapshot = report.snapshot as Record<string, unknown>;
    database.close();
    return {
      topic_snapshot_id: topic.latest_snapshot_id,
      sequence: snapshot.sequence,
      snapshot_hash: snapshot.snapshot_hash,
      unchanged: true,
      incremental: {
        retrieval_skipped: true,
        reason: "topic_inputs_not_invalidated",
        sections_reused: ((report.report as Record<string, unknown>).sections as unknown[]).length,
        sections_rebuilt: 0,
      },
      report,
    };
  }
  database.close();
  const aliases = view.aliases as string[];
  const query = [topic.name, ...aliases, topic.scope_text].join(" ");
  const mode = input.mode ?? "text";
  const started = performance.now();
  const search = await searchKnowledge(root, { query, mode, limit, explain: true });
  const searchRows = search.results as Array<Record<string, unknown>>;
  database = await readonlyModelDatabase(root);
  const pointers = activeRetrievalPointers(database);
  const graphCandidates = graphEvidenceForSeeds(
    database,
    searchRows.map((row) => String(row.chunk_id)),
    Math.min(400, limit * 4),
  );
  const graphRows = hydrateCandidates(
    database,
    [...new Set(graphCandidates.map((row) => row.chunk_id))],
    {},
  );
  database.close();
  const plan = createRetrievalPlan({
    query,
    queryHash: sha256Text(query),
    mode,
    depth: "deep",
    tokenBudget,
  });
  const assembled = assembleContext(searchRows, graphCandidates, graphRows, tokenBudget);
  const retrievalRunId = createResourceId("retrieval");
  const contextId = createResourceId("context");
  const contextHash = sha256Text(
    assembled.items
      .map((item) => `${item.chunkId}\n${item.claimId ?? ""}\n${sha256Text(item.content)}`)
      .join("\n"),
  );
  database = await writableModelDatabase(root);
  try {
    createRetrievalRecords(database, {
      retrievalRunId,
      contextId,
      plan,
      pointers,
      warnings: search.warnings,
      timings: {
        ...(((search.trace as Record<string, unknown>).timings as Record<string, number>) ?? {}),
        graph_ms: assembled.graphMs,
        context_ms: assembled.contextMs,
      },
      candidates: assembled.candidates,
      items: assembled.items,
      contextHash,
      promptSpecVersion: TOPIC_CONTEXT_PROMPT_VERSION,
    });
  } finally {
    database.close();
  }
  database = await readonlyModelDatabase(root);
  let claims = loadTopicClaims(database, [
    ...new Set(graphCandidates.map((row) => String(row.claim_id))),
  ]);
  const excluded = exclusionTerms(topic.exclude_text);
  const beforeExclusion = claims.length;
  claims = claims.filter((claim) => !matchesExclusion(claim, excluded));
  const graph = localTopicGraph(
    database,
    claims.map((claim) => claim.claimId),
  );
  database.close();
  const synthesis = synthesizeTopic(claims);
  const watermark = JSON.stringify({
    fts_generation_id: pointers.ftsGenerationId,
    vector_space_id: pointers.vectorSpaceId,
    vector_space_fingerprint: pointers.vectorSpaceFingerprint,
    graph_generation_id: pointers.graphGenerationId,
    topic_version: topic.version,
  });
  const inputHash = sha256Text(
    JSON.stringify({
      query,
      scope: topic.scope_text,
      exclude: topic.exclude_text,
      watermark,
      claims: claims.map((claim) => ({
        id: claim.claimId,
        status: claim.status,
        confidence: claim.confidenceLevel,
        evidence: claim.evidence.map((item) => [item.evidenceId, item.blobSha256]),
      })),
      rule: TOPIC_SYNTHESIS_RULE_VERSION,
    }),
  );
  const synthesisRunId = createResourceId("synthesis");
  const warnings = [...search.warnings];
  if (beforeExclusion > claims.length) warnings.push("topic_exclusions_applied");
  if (claims.length === 0) warnings.push("topic_claims_unavailable");
  database = await writableModelDatabase(root);
  try {
    beginTopicSynthesis(database, {
      synthesisRunId,
      topicId,
      contextId,
      parentSnapshotId: topic.latest_snapshot_id,
      mode,
      scopeVersion: topic.version,
      pointers,
      inputWatermark: watermark,
      inputHash,
      ruleVersion: TOPIC_SYNTHESIS_RULE_VERSION,
    });
    try {
      const saved = saveTopicSnapshot(database, {
        topic,
        synthesisRunId,
        inputHash,
        scope: {
          name: topic.name,
          scope: topic.scope_text,
          exclude: topic.exclude_text,
          aliases,
          version: topic.version,
        },
        watermarks: JSON.parse(watermark) as Record<string, unknown>,
        synthesis,
        graph,
        timings: {
          total_ms: Math.round((performance.now() - started) * 100) / 100,
          graph_ms: assembled.graphMs,
          context_ms: assembled.contextMs,
        },
        warnings,
        candidateCount: assembled.candidates.length,
      });
      const report = topicReport(database, topicId, saved.topic_snapshot_id);
      const sections = ((report.report as Record<string, unknown>).sections ?? []) as Array<
        Record<string, unknown>
      >;
      return {
        ...saved,
        synthesis_run_id: synthesisRunId,
        retrieval_run_id: retrievalRunId,
        context_id: contextId,
        unchanged: false,
        incremental: {
          retrieval_skipped: false,
          sections_reused: sections.filter((section) => section.change_kind === "unchanged").length,
          sections_rebuilt: sections.filter((section) => section.change_kind !== "unchanged")
            .length,
        },
        report,
      };
    } catch (cause) {
      failTopicSynthesis(database, synthesisRunId, cause);
      throw cause;
    }
  } finally {
    database.close();
  }
}

function exclusionTerms(value: string) {
  return value
    .split(/[,，;；\n]/u)
    .map((item) => item.normalize("NFKC").trim().toLocaleLowerCase())
    .filter(Boolean);
}

function matchesExclusion(
  claim: { normalizedStatement: string; evidence: Array<{ content: string }> },
  terms: string[],
) {
  if (terms.length === 0) return false;
  const text =
    `${claim.normalizedStatement}\n${claim.evidence.map((item) => item.content).join("\n")}`
      .normalize("NFKC")
      .toLocaleLowerCase();
  return terms.some((term) => text.includes(term));
}
