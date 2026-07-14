import { z } from "zod";
import { loadSelfConfig } from "../../domains/workspace/config/codec.ts";
import { failure, SelfFailure } from "../../shared/errors/self-error.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import { sha256Text } from "../filesystem/hash.ts";
import { writableModelDatabase } from "./model-db.ts";
import { getModel } from "./model-repository.ts";

const citationSchema = z
  .object({
    evidence_key: z.string().min(1).max(100),
    supporting_excerpt: z.string().min(1).max(2_000),
  })
  .strict();
const statementSchema = z
  .object({
    text: z.string().min(1).max(4_000),
    conclusion_type: z.enum([
      "fact",
      "single_source",
      "user_opinion",
      "inference",
      "conflict",
      "unknown",
      "model_knowledge",
    ]),
    citations: z.array(citationSchema).max(12),
  })
  .strict();
const answerSchema = z
  .object({
    result_kind: z.enum(["answered", "insufficient_evidence", "conflicted", "cannot_determine"]),
    summary: z.string().min(1).max(8_000),
    statements: z.array(statementSchema).max(30),
  })
  .strict();

export type StructuredAnswer = z.infer<typeof answerSchema>;
export const ANSWER_PROMPT_SPEC_VERSION = "answer-grounded-v1";

export async function answerFromEvidence(
  root: string,
  input: {
    modelId: string;
    query: string;
    allowModelKnowledge: boolean;
    evidence: Array<{
      evidence_key: string;
      content: string;
      claim_status?: string;
      confidence_level?: string;
      role: string;
    }>;
  },
): Promise<{
  answer: StructuredAnswer;
  invocation_id: string;
  actual_model_id: string;
}> {
  const model = await getModel(root, input.modelId);
  if (model.capability !== "chat" || model.state !== "active")
    throw failure("model_not_available", "Model is not an active Chat model", "state");
  if (model.provider_state !== "active" || model.circuit_state === "open")
    throw failure("model_provider_unavailable", "Model Provider circuit is open", "external");
  if (model.provider_type !== "test_deterministic" && (await loadSelfConfig(root)).models.offline)
    throw failure(
      "model_network_disabled",
      "Hosted model calls are disabled in offline mode",
      "state",
    );
  const invocationId = createResourceId("invocation");
  const started = performance.now();
  await startInvocation(root, invocationId, model, input);
  try {
    const raw =
      model.provider_type === "test_deterministic"
        ? fixtureAnswer(input)
        : await hostedAnswer(model, input);
    const parsed = answerSchema.safeParse(raw.value);
    if (!parsed.success)
      throw failure(
        "model_response_invalid",
        "Structured Provider response does not match answer-grounded-v1",
        "external",
        {
          details: {
            issues: parsed.error.issues.slice(0, 10).map((issue) => ({
              path: issue.path.join("."),
              code: issue.code,
              message: issue.message,
            })),
          },
        },
      );
    await finishInvocation(
      root,
      invocationId,
      raw.actualModel,
      raw.promptTokens,
      performance.now() - started,
    );
    return {
      answer: parsed.data,
      invocation_id: invocationId,
      actual_model_id: raw.actualModel,
    };
  } catch (cause) {
    const error =
      cause instanceof SelfFailure
        ? cause
        : failure("model_response_invalid", "Structured answer failed validation", "external");
    await failInvocation(root, invocationId, error.selfError.code, performance.now() - started);
    throw error;
  }
}

async function hostedAnswer(
  model: Record<string, unknown>,
  input: Parameters<typeof answerFromEvidence>[1],
) {
  const envName = String(model.api_key_env ?? "");
  const apiKey = process.env[envName];
  if (!apiKey)
    throw failure(
      "model_credentials_missing",
      `Provider credential environment ${envName} is missing`,
      "external",
    );
  const response = await fetch(
    `${String(model.endpoint_identity).replace(/\/$/, "")}/chat/completions`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model.provider_model_id,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Answer only from evidence_candidates unless allow_model_knowledge is true. Return exactly one JSON object matching output_contract. Every fact, single_source, user_opinion, inference, or conflict statement MUST cite evidence_key and copy supporting_excerpt character-for-character from that evidence content. For fact, single_source, user_opinion, and conflict, statement text itself MUST also be copied exactly from inside supporting_excerpt. Inference requires at least two citations. Never invent a citation. Preserve conflicts and unknowns. model_knowledge statements are allowed only when explicitly enabled and must have zero citations.",
          },
          {
            role: "user",
            content: JSON.stringify({
              schema_version: ANSWER_PROMPT_SPEC_VERSION,
              query: input.query,
              allow_model_knowledge: input.allowModelKnowledge,
              output_contract: {
                result_kind: "answered | insufficient_evidence | conflicted | cannot_determine",
                summary: "string",
                statements: [
                  {
                    text: "for fact/single_source/user_opinion/conflict: exactly the same copied string as one supporting_excerpt; inference may synthesize",
                    conclusion_type:
                      "fact | single_source | user_opinion | inference | conflict | unknown | model_knowledge",
                    citations: [
                      { evidence_key: "provided key", supporting_excerpt: "exact substring" },
                    ],
                  },
                ],
              },
              direct_statement_example: {
                text: "The exact sentence copied from evidence.",
                conclusion_type: "single_source",
                citations: [
                  {
                    evidence_key: "E1",
                    supporting_excerpt: "The exact sentence copied from evidence.",
                  },
                ],
              },
              evidence_candidates: input.evidence,
            }),
          },
        ],
      }),
      signal: AbortSignal.timeout(90_000),
    },
  );
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const value =
      body.error && typeof body.error === "object" ? (body.error as Record<string, unknown>) : body;
    throw failure(
      "model_call_failed",
      `Chat Provider returned HTTP ${response.status}`,
      "external",
      {
        retryable: response.status === 429 || response.status >= 500,
        details: {
          provider_code: String(value.code ?? value.type ?? "unknown").slice(0, 100),
          provider_message: String(value.message ?? "request rejected").slice(0, 300),
        },
      },
    );
  }
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const message = (choices[0] as Record<string, unknown> | undefined)?.message as
    | Record<string, unknown>
    | undefined;
  let value: unknown;
  try {
    value = JSON.parse(String(message?.content ?? ""));
  } catch {
    throw failure("model_response_invalid", "Chat Provider did not return JSON", "external");
  }
  const usage = body.usage as Record<string, unknown> | undefined;
  return {
    value,
    actualModel: String(body.model ?? model.provider_model_id),
    promptTokens: usage ? Number(usage.prompt_tokens ?? 0) : null,
  };
}

function fixtureAnswer(input: Parameters<typeof answerFromEvidence>[1]) {
  if (input.query.includes("FORCE_CANNOT_DETERMINE"))
    return {
      value: {
        result_kind: "cannot_determine",
        summary: "无法判断。",
        statements: [{ text: "无法判断。", conclusion_type: "unknown", citations: [] }],
      },
      actualModel: "fixture-answer-v1",
      promptTokens: Math.ceil(JSON.stringify(input).length / 4),
    };
  if (input.evidence.length === 0 && input.allowModelKnowledge)
    return {
      value: {
        result_kind: "answered",
        summary: "Fixture external model knowledge.",
        statements: [
          {
            text: "Fixture external model knowledge.",
            conclusion_type: "model_knowledge",
            citations: [],
          },
        ],
      },
      actualModel: "fixture-answer-v1",
      promptTokens: Math.ceil(JSON.stringify(input).length / 4),
    };
  const selected = input.evidence.slice(
    0,
    input.evidence.some((item) => item.claim_status === "disputed") ? 2 : 1,
  );
  const invalid = input.query.includes("FORCE_UNSUPPORTED_CITATION");
  const conflicted = selected.some(
    (item) => item.claim_status === "disputed" || item.role === "graph_contradict",
  );
  const statements = selected.map((item) => {
    const excerpt = invalid ? "not present in evidence" : evidenceExcerpt(item.content);
    return {
      text: statementText(excerpt),
      conclusion_type: conflicted ? "conflict" : "single_source",
      citations: [{ evidence_key: item.evidence_key, supporting_excerpt: excerpt }],
    };
  });
  return {
    value: {
      result_kind: conflicted ? "conflicted" : "answered",
      summary: conflicted ? "现有资料存在冲突。" : (statements[0]?.text ?? "无法判断。"),
      statements,
    },
    actualModel: "fixture-answer-v1",
    promptTokens: Math.ceil(JSON.stringify(input).length / 4),
  };
}

function evidenceExcerpt(content: string): string {
  const lines = content.split(/\r?\n/u).map((line) => line.trim());
  return (
    lines.find((line) => line.startsWith("@claim ")) ??
    lines.find((line) => Boolean(line) && !line.startsWith("#")) ??
    content
  ).slice(0, 600);
}

function statementText(excerpt: string): string {
  if (!excerpt.startsWith("@claim ")) return excerpt;
  return excerpt.slice(7).split("|")[3] || excerpt;
}

async function startInvocation(
  root: string,
  id: string,
  model: Record<string, unknown>,
  input: Parameters<typeof answerFromEvidence>[1],
) {
  const db = await writableModelDatabase(root);
  try {
    db.prepare(
      `INSERT INTO model_invocations(invocation_id, provider_id, model_id, operation_kind,
       input_hash, input_count, status, created_at) VALUES (?, ?, ?, 'retrieval.ask', ?, ?,
       'running', ?)`,
    ).run(
      id,
      String(model.provider_id),
      String(model.model_id),
      sha256Text(`${input.query}\n${JSON.stringify(input.evidence)}`),
      Math.max(1, input.evidence.length),
      new Date().toISOString(),
    );
  } finally {
    db.close();
  }
}

async function finishInvocation(
  root: string,
  id: string,
  actual: string,
  tokens: number | null,
  duration: number,
) {
  const db = await writableModelDatabase(root);
  try {
    db.prepare(
      "UPDATE model_invocations SET status = 'succeeded', provider_actual_model_id = ?, prompt_tokens = ?, duration_ms = ?, completed_at = ? WHERE invocation_id = ?",
    ).run(actual, tokens, duration, new Date().toISOString(), id);
  } finally {
    db.close();
  }
}

async function failInvocation(root: string, id: string, code: string, duration: number) {
  const db = await writableModelDatabase(root);
  try {
    db.prepare(
      "UPDATE model_invocations SET status = 'failed', error_code = ?, duration_ms = ?, completed_at = ? WHERE invocation_id = ?",
    ).run(code, duration, new Date().toISOString(), id);
  } finally {
    db.close();
  }
}
