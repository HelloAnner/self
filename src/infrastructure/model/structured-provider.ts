import { z } from "zod";
import { ENTITY_TYPES, type GraphExtraction } from "../../domains/graph/index.ts";
import { loadSelfConfig } from "../../domains/workspace/config/codec.ts";
import { failure, SelfFailure } from "../../shared/errors/self-error.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import { sha256Text } from "../filesystem/hash.ts";
import { writableModelDatabase } from "./model-db.ts";
import { getModel } from "./model-repository.ts";

const entitySchema = z.object({
  local_id: z.string().min(1).max(80),
  name: z.string().min(1).max(300),
  type: z.enum(ENTITY_TYPES),
  aliases: z.array(z.string().min(1).max(300)).max(20),
  identity_key: z
    .string()
    .min(1)
    .max(500)
    .nullish()
    .transform((value) => value ?? undefined),
  evidence_excerpt: z.string().min(1).max(1_000),
});

const claimSchema = z
  .object({
    statement: z.string().min(1).max(2_000),
    subject_local_id: z.string().min(1).max(80),
    predicate: z.string().regex(/^[a-z][a-z0-9_]*$/),
    object_local_id: z
      .string()
      .min(1)
      .max(80)
      .nullish()
      .transform((value) => value ?? undefined),
    value: z
      .union([z.string(), z.number(), z.boolean()])
      .nullish()
      .transform((value) => value ?? undefined),
    qualifiers: z.record(z.string(), z.string()).default({}),
    valid_from: z
      .string()
      .nullish()
      .transform((value) => value ?? undefined),
    valid_to: z
      .string()
      .nullish()
      .transform((value) => value ?? undefined),
    epistemic_status: z.enum(["fact", "user_opinion", "inference", "unknown"]),
    evidence_role: z.enum(["support", "contradict", "context", "definition"]),
    directness: z.enum(["direct", "paraphrase", "inferred"]),
    evidence_excerpt: z.string().min(1).max(1_000),
  })
  .refine((value) => value.object_local_id !== undefined || value.value !== undefined, {
    message: "claim needs object_local_id or value",
  });

export const graphExtractionSchema = z.object({
  entities: z.array(entitySchema).max(100),
  claims: z.array(claimSchema).max(100),
});

export const GRAPH_PROMPT_SPEC_VERSION = "graph-extract-v3";

export async function extractGraphFromChunk(
  root: string,
  input: { modelId: string; content: string; allowedPredicates: string[] },
): Promise<{ extraction: GraphExtraction; invocation_id: string; actual_model_id: string }> {
  const model = await getModel(root, input.modelId);
  if (model.capability !== "chat" || model.state !== "active")
    throw failure("model_not_available", "Model is not an active structured Chat model", "state");
  if (model.provider_state !== "active" || model.circuit_state === "open")
    throw failure("model_provider_unavailable", "Model Provider circuit is open", "external");
  if (model.provider_type !== "test_deterministic" && (await loadSelfConfig(root)).models.offline)
    throw failure(
      "model_network_disabled",
      "Hosted model calls are disabled in offline mode",
      "state",
    );
  const invocationId = createResourceId("invocation");
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const database = await writableModelDatabase(root);
  try {
    database
      .prepare(
        `INSERT INTO model_invocations(invocation_id, provider_id, model_id, operation_kind,
       input_hash, input_count, status, created_at) VALUES (?, ?, ?, 'graph.extract', ?, 1, 'running', ?)`,
      )
      .run(invocationId, model.provider_id, model.model_id, sha256Text(input.content), startedAt);
  } finally {
    database.close();
  }
  try {
    const raw =
      model.provider_type === "test_deterministic"
        ? fixtureExtraction(input.content)
        : await hostedExtraction(model, input.content, input.allowedPredicates);
    const parsed = graphExtractionSchema.safeParse(raw.value);
    if (!parsed.success)
      throw failure(
        "model_response_invalid",
        "Structured Provider response does not match graph-extraction-v1",
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
    const extraction = parsed.data;
    validateGrounding(extraction, input.content, new Set(input.allowedPredicates));
    await finish(
      root,
      invocationId,
      raw.actualModel,
      raw.promptTokens,
      performance.now() - started,
    );
    return { extraction, invocation_id: invocationId, actual_model_id: raw.actualModel };
  } catch (cause) {
    const error =
      cause instanceof SelfFailure
        ? cause
        : failure(
            "model_response_invalid",
            "Structured graph response failed validation",
            "external",
          );
    await fail(root, invocationId, error.selfError.code, performance.now() - started);
    throw error;
  }
}

function validateGrounding(value: GraphExtraction, content: string, predicates: Set<string>): void {
  const localIds = new Set(value.entities.map((entity) => entity.local_id));
  if (localIds.size !== value.entities.length)
    throw failure("model_response_invalid", "Entity local IDs are not unique", "external");
  for (const entity of value.entities)
    if (!content.includes(entity.evidence_excerpt))
      throw failure(
        "model_response_invalid",
        "Entity evidence excerpt is not in the Chunk",
        "external",
      );
  for (const claim of value.claims) {
    if (
      !localIds.has(claim.subject_local_id) ||
      (claim.object_local_id && !localIds.has(claim.object_local_id))
    )
      throw failure(
        "model_response_invalid",
        "Claim references an unknown Entity candidate",
        "external",
      );
    if (!predicates.has(claim.predicate))
      throw failure(
        "unknown_predicate",
        `Unknown Predicate from model: ${claim.predicate}`,
        "state",
      );
    if (!content.includes(claim.evidence_excerpt))
      throw failure(
        "model_response_invalid",
        "Claim evidence excerpt is not in the Chunk",
        "external",
      );
  }
}

async function hostedExtraction(
  model: Record<string, unknown>,
  content: string,
  predicates: string[],
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
              "Return one JSON object containing only directly grounded entities and claims. Follow output_contract exactly. A claim predicate MUST exactly equal one string in allowed_predicates; if none fits, omit that claim. Copy every evidence_excerpt character-for-character from one evidence_candidate; never paraphrase or combine it. Use short local IDs such as e1. aliases is always an array. Never invent predicates or extra keys.",
          },
          {
            role: "user",
            content: JSON.stringify({
              schema_version: "graph-extraction-v1",
              output_contract: {
                entities: [
                  {
                    local_id: "string",
                    name: "string",
                    type: `one string from: ${ENTITY_TYPES.join(" | ")}`,
                    aliases: ["string"],
                    identity_key: "optional strong external identity string",
                    evidence_excerpt: "exact content substring",
                  },
                ],
                claims: [
                  {
                    statement: "string",
                    subject_local_id: "entity local_id",
                    predicate: "one allowed_predicate",
                    object_local_id: "optional entity local_id; otherwise use value",
                    value: "optional string, number, or boolean",
                    qualifiers: { key: "string value" },
                    valid_from: "optional ISO date",
                    valid_to: "optional ISO date",
                    epistemic_status: "one string from: fact | user_opinion | inference | unknown",
                    evidence_role: "one string from: support | contradict | context | definition",
                    directness: "one string from: direct | paraphrase | inferred",
                    evidence_excerpt: "exact content substring",
                  },
                ],
              },
              output_example: {
                entities: [
                  {
                    local_id: "e1",
                    name: "Example Project",
                    type: "project",
                    aliases: [],
                    evidence_excerpt: "Example Project",
                  },
                  {
                    local_id: "e2",
                    name: "Example Technology",
                    type: "technology",
                    aliases: [],
                    evidence_excerpt: "Example Technology",
                  },
                ],
                claims: [
                  {
                    statement: "Example Project uses Example Technology.",
                    subject_local_id: "e1",
                    predicate: "uses",
                    object_local_id: "e2",
                    qualifiers: {},
                    epistemic_status: "fact",
                    evidence_role: "support",
                    directness: "direct",
                    evidence_excerpt: "Example Project uses Example Technology.",
                  },
                ],
              },
              allowed_predicates: predicates,
              evidence_candidates: content
                .split(/\r?\n/u)
                .map((line) => line.trim())
                .filter(Boolean),
              content,
            }),
          },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    },
  );
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const providerError =
      body.error && typeof body.error === "object" ? (body.error as Record<string, unknown>) : body;
    throw failure(
      "model_call_failed",
      `Structured Provider returned HTTP ${response.status}`,
      "external",
      {
        retryable: response.status === 429 || response.status >= 500,
        details: {
          provider_code: String(providerError.code ?? providerError.type ?? "unknown").slice(
            0,
            100,
          ),
          provider_message: String(providerError.message ?? "request rejected").slice(0, 300),
        },
      },
    );
  }
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const message = (choices[0] as Record<string, unknown> | undefined)?.message as
    | Record<string, unknown>
    | undefined;
  const text = String(message?.content ?? "");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw failure("model_response_invalid", "Structured Provider did not return JSON", "external");
  }
  const usage = body.usage as Record<string, unknown> | undefined;
  return {
    value,
    actualModel: String(body.model ?? model.provider_model_id),
    promptTokens: usage ? Number(usage.prompt_tokens ?? 0) : null,
  };
}

function fixtureExtraction(content: string) {
  const entities: Array<Record<string, unknown>> = [];
  const claims: Array<Record<string, unknown>> = [];
  for (const line of content.split(/\r?\n/u)) {
    if (line.startsWith("@entity ")) {
      const [local_id, type, name, aliases = "", identity_key = ""] = line.slice(8).split("|");
      if (local_id && type && name)
        entities.push({
          local_id,
          type,
          name,
          aliases: aliases ? aliases.split(",") : [],
          ...(identity_key ? { identity_key } : {}),
          evidence_excerpt: line,
        });
    }
    if (line.startsWith("@claim ")) {
      const [
        subject_local_id,
        predicate,
        objectOrValue,
        statement,
        epistemic_status = "fact",
        directness = "direct",
        conflict_scope = "",
      ] = line.slice(7).split("|");
      if (subject_local_id && predicate && objectOrValue && statement)
        claims.push({
          subject_local_id,
          predicate,
          ...(objectOrValue.startsWith("$")
            ? { value: objectOrValue.slice(1) }
            : { object_local_id: objectOrValue }),
          statement,
          qualifiers: conflict_scope ? { conflict_scope } : {},
          epistemic_status,
          evidence_role: "support",
          directness,
          evidence_excerpt: line,
        });
    }
  }
  return {
    value: { entities, claims },
    actualModel: "fixture-graph-v1",
    promptTokens: Math.ceil(content.length / 4),
  };
}

async function finish(
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

async function fail(root: string, id: string, code: string, duration: number) {
  const db = await writableModelDatabase(root);
  try {
    db.prepare(
      "UPDATE model_invocations SET status = 'failed', error_code = ?, duration_ms = ?, completed_at = ? WHERE invocation_id = ?",
    ).run(code, duration, new Date().toISOString(), id);
  } finally {
    db.close();
  }
}
