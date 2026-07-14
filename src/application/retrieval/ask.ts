import {
  type AskDepth,
  createRetrievalPlan,
  type EvidenceContextItem,
  type SearchFilters,
  type SearchMode,
} from "../../domains/retrieval/index.ts";
import { loadSelfConfig } from "../../domains/workspace/config/codec.ts";
import { sha256Text } from "../../infrastructure/filesystem/hash.ts";
import {
  ANSWER_PROMPT_SPEC_VERSION,
  answerFromEvidence,
  type StructuredAnswer,
} from "../../infrastructure/model/answer-provider.ts";
import {
  readonlyModelDatabase,
  writableModelDatabase,
} from "../../infrastructure/model/model-db.ts";
import {
  answerView,
  saveAnswer,
  type ValidatedAnswer,
} from "../../infrastructure/retrieval/answer-repository.ts";
import {
  activeRetrievalPointers,
  createRetrievalRecords,
  graphEvidenceForSeeds,
} from "../../infrastructure/retrieval/evidence-repository.ts";
import { hydrateCandidates } from "../../infrastructure/retrieval/search-repository.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import { searchKnowledge } from "./search.ts";

export async function askKnowledge(
  root: string,
  input: {
    query: string;
    mode?: SearchMode;
    depth?: AskDepth;
    modelId?: string;
    filters?: SearchFilters;
    tokenBudget?: number;
    allowModelKnowledge?: boolean;
  },
) {
  const query = normalizeQuery(input.query);
  const config = await loadSelfConfig(root);
  const mode = input.mode ?? config.retrieval.mode;
  const depth = input.depth ?? "normal";
  if (!(["shallow", "normal", "deep"] as string[]).includes(depth))
    throw failure("ask_depth_invalid", "Ask depth is invalid", "usage");
  if (
    input.tokenBudget !== undefined &&
    (!Number.isInteger(input.tokenBudget) || input.tokenBudget < 256 || input.tokenBudget > 32_000)
  )
    throw failure(
      "context_budget_invalid",
      "Context token budget must be between 256 and 32000",
      "usage",
    );
  const queryHash = sha256Text(query);
  const plan = createRetrievalPlan({
    query,
    queryHash,
    mode,
    depth,
    ...(input.filters ? { filters: input.filters } : {}),
    ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
  });
  const started = performance.now();
  const search = await searchKnowledge(root, {
    query,
    mode,
    limit: plan.seedLimit,
    filters: plan.filters,
    explain: true,
  });
  const searchResults = search.results as Array<Record<string, unknown>>;
  let database = await readonlyModelDatabase(root);
  const pointers = activeRetrievalPointers(database);
  const graphCandidates = graphEvidenceForSeeds(
    database,
    searchResults.map((row) => String(row.chunk_id)),
    plan.graphMaxClaims,
  );
  const graphRows = hydrateCandidates(
    database,
    [...new Set(graphCandidates.map((row) => row.chunk_id))],
    plan.filters,
  );
  database.close();
  const assembled = assembleContext(
    searchResults,
    graphCandidates,
    graphRows,
    plan.contextTokenBudget,
  );
  const retrievalRunId = createResourceId("retrieval");
  const contextId = createResourceId("context");
  const contextHash = sha256Text(
    assembled.items
      .map(
        (item) =>
          `${item.chunkId}\n${item.claimId ?? ""}\n${sha256Text(item.content.slice(0, item.excerptEnd))}`,
      )
      .join("\n"),
  );
  const trace = search.trace as Record<string, unknown>;
  database = await writableModelDatabase(root);
  try {
    createRetrievalRecords(database, {
      retrievalRunId,
      contextId,
      plan,
      pointers,
      warnings: search.warnings,
      timings: {
        ...((trace.timings as Record<string, number>) ?? {}),
        graph_ms: assembled.graphMs,
        context_ms: assembled.contextMs,
        retrieval_total_ms: round(performance.now() - started),
      },
      candidates: assembled.candidates,
      items: assembled.items,
      contextHash,
      promptSpecVersion: ANSWER_PROMPT_SPEC_VERSION,
    });
  } finally {
    database.close();
  }
  const answerId = createResourceId("answer");
  if (assembled.items.length === 0 && input.allowModelKnowledge !== true) {
    const answer = standardAnswer("insufficient_evidence");
    await persist(root, {
      answerId,
      retrievalRunId,
      contextId,
      queryHash,
      promptSpecVersion: ANSWER_PROMPT_SPEC_VERSION,
      allowModelKnowledge: false,
      answer,
    });
    return readAnswer(root, answerId);
  }
  const modelId = input.modelId ?? (await defaultChatModel(root));
  if (!modelId)
    throw failure(
      "model_not_available",
      "Ask found evidence but no active Chat model is registered",
      "state",
      { suggestedActions: ["Register a Chat model or pass --model <MODEL_ID>."] },
    );
  const call = await answerFromEvidence(root, {
    modelId,
    query,
    allowModelKnowledge: input.allowModelKnowledge === true,
    evidence: assembled.items.map((item) => ({
      evidence_key: item.evidenceKey,
      content: item.content.slice(item.excerptStart, item.excerptEnd),
      ...(item.claimStatus ? { claim_status: item.claimStatus } : {}),
      ...(item.claimConfidenceLevel ? { confidence_level: item.claimConfidenceLevel } : {}),
      role: item.role,
    })),
  });
  const answer = validateAnswer(call.answer, assembled.items, input.allowModelKnowledge === true);
  await persist(root, {
    answerId,
    retrievalRunId,
    contextId,
    queryHash,
    modelId,
    invocationId: call.invocation_id,
    actualModelId: call.actual_model_id,
    promptSpecVersion: ANSWER_PROMPT_SPEC_VERSION,
    allowModelKnowledge: input.allowModelKnowledge === true,
    answer,
  });
  return readAnswer(root, answerId);
}

export function assembleContext(
  seeds: Array<Record<string, unknown>>,
  graphCandidates: Array<Record<string, unknown>>,
  graphRows: Array<Record<string, unknown>>,
  budget: number,
) {
  const graphStarted = performance.now();
  const graphByChunk = new Map(graphRows.map((row) => [String(row.chunk_id), row]));
  const raw = [
    ...graphCandidates.map((candidate, index) => ({
      row: graphByChunk.get(String(candidate.chunk_id)),
      claim: candidate,
      score: 2 - index / 100,
      role: candidate.role === "contradict" ? "graph_contradict" : "graph_support",
    })),
    ...seeds.map((row, index) => ({
      row,
      claim: null,
      score: Number(row.score ?? 0) + 1 - index / 100,
      role: "seed",
    })),
  ].filter((entry) => entry.row);
  const graphMs = round(performance.now() - graphStarted);
  const contextStarted = performance.now();
  const seen = new Set<string>();
  const items: EvidenceContextItem[] = [];
  let used = 0;
  for (const entry of raw) {
    const row = entry.row as Record<string, unknown>;
    const claimId = entry.claim ? String(entry.claim.claim_id) : undefined;
    const identity = `${row.chunk_id}|${claimId ?? "seed"}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const content = String(row.content_text ?? "");
    const available = budget - used;
    if (available < 64) break;
    const tokens = Math.min(Number(row.token_estimate ?? Math.ceil(content.length / 4)), available);
    const end = Math.min(content.length, Math.max(1, tokens * 4));
    items.push({
      evidenceKey: `E${items.length + 1}`,
      chunkId: String(row.chunk_id),
      documentId: String(row.document_id),
      revisionId: String(row.revision_id),
      sourceId: String(row.source_id),
      snapshotId: String(row.snapshot_id),
      blobSha256: String(row.blob_sha256),
      content,
      excerptStart: 0,
      excerptEnd: end,
      tokenEstimate: tokens,
      role: entry.role as EvidenceContextItem["role"],
      ...(claimId ? { claimId } : {}),
      ...(entry.claim
        ? {
            claimStatus: String(entry.claim.claim_status),
            claimConfidenceLevel: String(entry.claim.confidence_level),
          }
        : {}),
    });
    used += tokens;
  }
  const selected = new Set(items.map((item) => `${item.chunkId}|${item.claimId ?? "seed"}`));
  const candidates = raw.map((entry, index) => {
    const row = entry.row as Record<string, unknown>;
    const claimId = entry.claim ? String(entry.claim.claim_id) : undefined;
    return {
      chunkId: String(row.chunk_id),
      ...(claimId ? { claimId } : {}),
      rank: index + 1,
      score: entry.score,
      routes: claimId ? ["graph"] : (row.routes ?? ["fts"]),
      selected: selected.has(`${row.chunk_id}|${claimId ?? "seed"}`),
    };
  });
  const uniqueCandidates = [
    ...new Map(
      candidates.map((candidate) => [
        `${candidate.chunkId}|${candidate.claimId ?? "seed"}`,
        candidate,
      ]),
    ).values(),
  ].map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  return {
    items,
    candidates: uniqueCandidates,
    graphMs,
    contextMs: round(performance.now() - contextStarted),
  };
}

function validateAnswer(
  value: StructuredAnswer,
  items: EvidenceContextItem[],
  allowModelKnowledge: boolean,
): ValidatedAnswer {
  const evidence = new Map(items.map((item, index) => [item.evidenceKey, { item, index }]));
  const statements = value.statements.map((statement) => {
    if (statement.conclusion_type === "model_knowledge") {
      if (!allowModelKnowledge || statement.citations.length > 0)
        throw unsupported("Model knowledge was not explicitly allowed");
      return {
        text: statement.text,
        conclusionType: "model_knowledge" as const,
        confidenceLevel: "unknown" as const,
        citations: [],
      };
    }
    if (statement.conclusion_type !== "unknown" && statement.citations.length === 0)
      throw unsupported("A factual statement has no Citation");
    const citations = statement.citations.map((citation) => {
      const selected = evidence.get(citation.evidence_key);
      if (!selected) throw unsupported("A Citation references unknown evidence");
      const scoped = selected.item.content.slice(
        selected.item.excerptStart,
        selected.item.excerptEnd,
      );
      const grounded = locateGroundedText(scoped, citation.supporting_excerpt);
      if (!grounded) throw unsupported("A Citation excerpt is not present in its Chunk");
      const start = selected.item.excerptStart + grounded.start;
      return {
        evidenceKey: citation.evidence_key,
        contextOrdinal: selected.index + 1,
        excerptStart: start,
        excerptEnd: selected.item.excerptStart + grounded.end,
        excerpt: grounded.text,
      };
    });
    let statementText = statement.text;
    if (["fact", "single_source", "user_opinion", "conflict"].includes(statement.conclusion_type)) {
      const groundedStatement = citations
        .map((citation) => locateGroundedText(citation.excerpt, statement.text))
        .find(Boolean);
      if (!groundedStatement)
        throw unsupported("A factual statement is not an exact assertion from cited evidence");
      statementText = groundedStatement.text;
    }
    if (statement.conclusion_type === "inference" && statement.citations.length < 2)
      throw unsupported("An inference requires at least two cited evidence items");
    const claimItems = statement.citations.flatMap((citation) => {
      const found = evidence.get(citation.evidence_key)?.item;
      return found ? [found] : [];
    });
    const disputed = claimItems.some(
      (item) => item.claimStatus === "disputed" || item.role === "graph_contradict",
    );
    const sources = new Set(claimItems.map((item) => item.sourceId)).size;
    const conclusionType = disputed
      ? "conflict"
      : statement.conclusion_type === "fact" && sources < 2
        ? "single_source"
        : statement.conclusion_type;
    const confidenceLevel: ValidatedAnswer["statements"][number]["confidenceLevel"] = disputed
      ? "disputed"
      : strongestConfidence(claimItems.map((item) => item.claimConfidenceLevel));
    return { text: statementText, conclusionType, confidenceLevel, citations };
  });
  const hasConflict = statements.some((statement) => statement.conclusionType === "conflict");
  const resultKind = hasConflict ? "conflicted" : value.result_kind;
  const summary =
    resultKind === "conflicted"
      ? "现有资料存在冲突；以下结论保留各自证据。"
      : statements.map((statement) => statement.text).join("\n") || standardMessage(resultKind);
  return { resultKind, summary, statements };
}

function strongestConfidence(values: Array<string | undefined>) {
  if (values.includes("high")) return "high" as const;
  if (values.includes("medium")) return "medium" as const;
  if (values.includes("low")) return "low" as const;
  return "unknown" as const;
}

function standardAnswer(kind: "insufficient_evidence" | "cannot_determine"): ValidatedAnswer {
  return { resultKind: kind, summary: standardMessage(kind), statements: [] };
}

function standardMessage(kind: string) {
  return kind === "insufficient_evidence" ? "资料不足：知识库中没有可用证据。" : "无法判断。";
}

function unsupported(message: string) {
  return failure("answer_citation_unsupported", message, "external", { retryable: false });
}

function locateGroundedText(content: string, requested: string) {
  const exact = content.indexOf(requested);
  if (exact >= 0) return { start: exact, end: exact + requested.length, text: requested };
  const source = normalizedCharacters(content);
  const target = normalizedCharacters(requested)
    .map((item) => item.character)
    .join("");
  if (target.length < 4) return null;
  const at = source
    .map((item) => item.character)
    .join("")
    .indexOf(target);
  if (at < 0) return null;
  const start = source[at]?.sourceIndex;
  const last = source[at + target.length - 1]?.sourceIndex;
  if (start === undefined || last === undefined) return null;
  const end = last + ([...content.slice(last)][0]?.length ?? 0);
  return { start, end, text: content.slice(start, end) };
}

function normalizedCharacters(value: string) {
  const output: Array<{ character: string; sourceIndex: number }> = [];
  let sourceIndex = 0;
  for (const original of value) {
    for (const character of original.normalize("NFKC").toLocaleLowerCase())
      if (/^[\p{L}\p{N}]$/u.test(character)) output.push({ character, sourceIndex });
    sourceIndex += original.length;
  }
  return output;
}

async function defaultChatModel(root: string): Promise<string | null> {
  const database = await readonlyModelDatabase(root);
  try {
    return (
      database
        .query<{ model_id: string }, []>(
          `SELECT m.model_id FROM models m JOIN model_providers p ON p.provider_id = m.provider_id
           WHERE m.capability = 'chat' AND m.state = 'active' AND p.state = 'active'
           AND p.circuit_state <> 'open' ORDER BY m.created_at, m.model_id LIMIT 1`,
        )
        .get()?.model_id ?? null
    );
  } finally {
    database.close();
  }
}

async function persist(root: string, input: Parameters<typeof saveAnswer>[1]) {
  const database = await writableModelDatabase(root);
  try {
    saveAnswer(database, input);
  } finally {
    database.close();
  }
}

async function readAnswer(root: string, answerId: string) {
  const database = await readonlyModelDatabase(root);
  try {
    return answerView(database, answerId);
  } finally {
    database.close();
  }
}

function normalizeQuery(value: string) {
  const query = value.normalize("NFKC").trim();
  if (!query || query.includes("\0"))
    throw failure("ask_input_invalid", "Ask Query is invalid", "usage");
  return query;
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}
