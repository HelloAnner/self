import type { Database } from "bun:sqlite";
import { failure } from "../../shared/errors/self-error.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import { sha256Text } from "../filesystem/hash.ts";
import { traceTopicSection } from "../topic/topic-query-repository.ts";
import { hydrateCandidates } from "./search-repository.ts";

export type ValidatedAnswer = {
  resultKind: "answered" | "insufficient_evidence" | "conflicted" | "cannot_determine";
  summary: string;
  statements: Array<{
    text: string;
    conclusionType:
      | "fact"
      | "single_source"
      | "user_opinion"
      | "inference"
      | "conflict"
      | "unknown"
      | "model_knowledge";
    confidenceLevel: "high" | "medium" | "low" | "disputed" | "unknown";
    citations: Array<{
      evidenceKey: string;
      contextOrdinal: number;
      excerptStart: number;
      excerptEnd: number;
      excerpt: string;
    }>;
  }>;
};

export function saveAnswer(
  database: Database,
  input: {
    answerId: string;
    retrievalRunId: string;
    contextId: string;
    queryHash: string;
    modelId?: string;
    invocationId?: string;
    actualModelId?: string;
    promptSpecVersion: string;
    allowModelKnowledge: boolean;
    answer: ValidatedAnswer;
  },
) {
  const now = new Date().toISOString();
  database.transaction(() => {
    database
      .prepare(
        `INSERT INTO answer_runs(answer_id, retrieval_run_id, context_id, query_hash, model_id,
         invocation_id, provider_actual_model_id, prompt_spec_version, allow_model_knowledge,
         result_kind, status, cache_state, summary_text, answer_hash, validation_json,
         created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'succeeded', 'active',
         ?, ?, ?, ?, ?)`,
      )
      .run(
        input.answerId,
        input.retrievalRunId,
        input.contextId,
        input.queryHash,
        input.modelId ?? null,
        input.invocationId ?? null,
        input.actualModelId ?? null,
        input.promptSpecVersion,
        input.allowModelKnowledge ? 1 : 0,
        input.answer.resultKind,
        input.answer.summary,
        sha256Text(JSON.stringify(input.answer)),
        JSON.stringify({ rule: "citation-exact-substring-v1", status: "passed" }),
        now,
        now,
      );
    const statementInsert = database.prepare(
      `INSERT INTO answer_statements(statement_id, answer_id, ordinal, statement_text,
       conclusion_type, confidence_level, support_status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const citationInsert = database.prepare(
      `INSERT INTO answer_citations(citation_id, answer_id, statement_id, context_id,
       context_ordinal, excerpt_start, excerpt_end, excerpt_hash, support_status,
       validation_rule, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'supported',
       'citation-exact-substring-v1', ?)`,
    );
    input.answer.statements.forEach((statement, index) => {
      const statementId = createResourceId("statement");
      statementInsert.run(
        statementId,
        input.answerId,
        index + 1,
        statement.text,
        statement.conclusionType,
        statement.confidenceLevel,
        statement.conclusionType === "model_knowledge"
          ? "external"
          : statement.citations.length > 0
            ? "supported"
            : "not_applicable",
      );
      for (const citation of statement.citations)
        citationInsert.run(
          createResourceId("citation"),
          input.answerId,
          statementId,
          input.contextId,
          citation.contextOrdinal,
          citation.excerptStart,
          citation.excerptEnd,
          sha256Text(citation.excerpt),
          now,
        );
    });
  })();
}

export function answerView(
  database: Database,
  answerId: string,
): Record<string, unknown> & { statements: Array<Record<string, unknown>> } {
  const answer = database
    .query<Record<string, unknown>, [string]>("SELECT * FROM answer_runs WHERE answer_id = ?")
    .get(answerId);
  if (!answer) throw failure("answer_not_found", "Answer does not exist", "not_found");
  const statements = database
    .query<Record<string, unknown>, [string]>(
      "SELECT * FROM answer_statements WHERE answer_id = ? ORDER BY ordinal",
    )
    .all(answerId)
    .map((statement) => ({
      ...statement,
      citations: database
        .query<Record<string, unknown>, [string]>(
          `SELECT c.*, i.evidence_key, i.chunk_id, i.document_id, i.revision_id, i.source_id,
           i.snapshot_id, i.blob_sha256, i.claim_id, i.claim_confidence_level
           FROM answer_citations c JOIN evidence_context_items i
           ON i.context_id = c.context_id AND i.ordinal = c.context_ordinal
           WHERE c.statement_id = ? ORDER BY c.citation_id`,
        )
        .all(String(statement.statement_id)),
    }));
  return { ...parseJson(answer), statements };
}

export function traceObject(database: Database, id: string) {
  if (id.startsWith("answer:")) return answerTrace(database, id);
  if (id.startsWith("section:")) return traceTopicSection(database, id);
  if (id.startsWith("claim:")) return claimTrace(database, id);
  if (id.startsWith("chunk:")) return chunkTrace(database, id);
  throw failure(
    "trace_target_unsupported",
    "Trace supports Answer, Report Section, Claim, or Chunk IDs",
    "usage",
  );
}

function answerTrace(database: Database, answerId: string) {
  const answer = answerView(database, answerId);
  const retrieval = database
    .query<Record<string, unknown>, [string]>(
      "SELECT * FROM retrieval_runs WHERE retrieval_run_id = ?",
    )
    .get(String(answer.retrieval_run_id));
  const context = database
    .query<Record<string, unknown>, [string]>(
      "SELECT * FROM evidence_contexts WHERE context_id = ?",
    )
    .get(String(answer.context_id));
  const contextItems = database
    .query<Record<string, unknown>, [string]>(
      `SELECT i.*, substr(c.content_text, i.excerpt_start + 1,
       i.excerpt_end - i.excerpt_start) excerpt_text
       FROM evidence_context_items i JOIN knowledge_chunks c ON c.chunk_id = i.chunk_id
       WHERE i.context_id = ? ORDER BY i.ordinal`,
    )
    .all(String(answer.context_id))
    .map((item) => ({
      ...item,
      excerpt_hash_matches: sha256Text(String(item.excerpt_text)) === item.excerpt_hash,
    }));
  return {
    target_id: answerId,
    answer,
    context: context ? { ...parseJson(context), items: contextItems } : null,
    retrieval: retrieval ? parseJson(retrieval) : null,
    evidence_chains: uniqueCitations(answer).map((citation) => ({
      citation_id: citation.citation_id,
      claim_id: citation.claim_id,
      chunk_id: citation.chunk_id,
      revision_id: citation.revision_id,
      snapshot_id: citation.snapshot_id,
      source_id: citation.source_id,
      blob_sha256: citation.blob_sha256,
    })),
  };
}

function claimTrace(database: Database, claimId: string) {
  const claim = database
    .query<Record<string, unknown>, [string]>("SELECT * FROM graph_claims WHERE claim_id = ?")
    .get(claimId);
  if (!claim) throw failure("claim_not_found", "Claim does not exist", "not_found");
  const evidence = database
    .query<Record<string, unknown>, [string]>(
      `SELECT e.*, c.document_id, d.source_id, d.current_revision_id revision_id,
       r.snapshot_id, r.blob_sha256 FROM graph_claim_evidence e
       JOIN knowledge_chunks c ON c.chunk_id = e.chunk_id
       JOIN knowledge_documents d ON d.document_id = c.document_id
       JOIN knowledge_revisions r ON r.revision_id = e.revision_id
       WHERE e.claim_id = ? ORDER BY e.evidence_id`,
    )
    .all(claimId);
  return { target_id: claimId, claim: parseJson(claim), evidence: evidence.map(parseJson) };
}

function chunkTrace(database: Database, chunkId: string) {
  const rows = hydrateCandidates(database, [chunkId], {});
  const chunk = rows[0];
  if (!chunk) throw failure("chunk_not_found", "Chunk does not exist or is inactive", "not_found");
  return { target_id: chunkId, chunk };
}

function uniqueCitations(answer: Record<string, unknown>) {
  const statements = answer.statements as Array<Record<string, unknown>>;
  const rows = statements.flatMap(
    (statement) => statement.citations as Array<Record<string, unknown>>,
  );
  return [...new Map(rows.map((row) => [String(row.citation_id), row])).values()];
}

function parseJson(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      key.endsWith("_json") && typeof value === "string" ? JSON.parse(value) : value,
    ]),
  );
}
