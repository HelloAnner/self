import { loadSelfConfig } from "../../domains/workspace/config/codec.ts";
import { failure, SelfFailure } from "../../shared/errors/self-error.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import { sha256Text } from "../filesystem/hash.ts";
import { writableModelDatabase } from "./model-db.ts";
import type { ModelView } from "./model-repository.ts";
import { getModel } from "./model-repository.ts";

export const PUBLIC_SENTINELS = [
  "Self sentinel: local knowledge evidence and source traceability.",
  "Self sentinel: 中文个人知识检索与证据回溯。",
  "Self sentinel: const chunkId = stableEvidenceId;",
] as const;

export type EmbeddingCallResult = {
  invocation_id: string;
  vectors: Float32Array[];
  provider_actual_model_id: string;
  prompt_tokens: number | null;
};

export async function embedModelTexts(
  root: string,
  input: {
    modelId: string;
    vectorSpaceId?: string;
    dimensions: number;
    texts: string[];
    operationKind: string;
  },
): Promise<EmbeddingCallResult> {
  if (input.texts.length < 1 || input.texts.length > 100)
    throw failure("model_input_invalid", "Embedding batch size must be between 1 and 100", "usage");
  const model = await getModel(root, input.modelId);
  if (model.capability !== "embedding" || model.state !== "active")
    throw failure("model_not_available", "Model is not an active Embedding model", "state");
  const allowed = model.dimensions as number[];
  if (!allowed.includes(input.dimensions))
    throw failure("model_dimension_mismatch", "Requested dimensions are not registered", "state");
  if (model.provider_state !== "active" || model.circuit_state === "open")
    throw failure("model_provider_unavailable", "Model Provider circuit is open", "external", {
      retryable: true,
    });
  if (model.provider_type !== "test_deterministic" && (await loadSelfConfig(root)).models.offline)
    throw failure(
      "model_network_disabled",
      "Hosted model calls are disabled in offline mode",
      "state",
    );
  const invocationId = createResourceId("invocation");
  const started = performance.now();
  const createdAt = new Date().toISOString();
  await beginInvocation(root, {
    invocationId,
    model,
    ...(input.vectorSpaceId ? { vectorSpaceId: input.vectorSpaceId } : {}),
    operationKind: input.operationKind,
    inputHash: sha256Text(input.texts.map((text) => sha256Text(text)).join("\n")),
    inputCount: input.texts.length,
    createdAt,
  });
  try {
    const raw =
      model.provider_type === "test_deterministic"
        ? fixtureEmbeddings(
            input.texts,
            input.dimensions,
            String(model.provider_model_id),
            process.env.SELF_TEST_EMBEDDING_DRIFT === "1",
          )
        : await hostedEmbeddings(model, input.texts, input.dimensions);
    if (raw.vectors.length !== input.texts.length)
      throw failure(
        "model_response_invalid",
        "Embedding response count does not match input",
        "external",
      );
    const vectors = raw.vectors.map((vector) => validateAndNormalize(vector, input.dimensions));
    await finishInvocation(root, invocationId, {
      actualModel: raw.actualModel,
      promptTokens: raw.promptTokens,
      durationMs: performance.now() - started,
    });
    return {
      invocation_id: invocationId,
      vectors,
      provider_actual_model_id: raw.actualModel,
      prompt_tokens: raw.promptTokens,
    };
  } catch (cause) {
    const error = cause instanceof SelfFailure ? cause : modelFailure(cause);
    await failInvocation(root, invocationId, error.selfError.code, performance.now() - started);
    if (
      ["model_credentials_missing", "model_not_found", "model_drift_detected"].includes(
        error.selfError.code,
      )
    )
      await openProviderCircuit(root, String(model.provider_id), error.selfError.code);
    throw error;
  }
}

export function embeddingFingerprint(vectors: Float32Array[], precision = 5): string {
  return sha256Text(
    vectors
      .map((vector) => [...vector].map((value) => value.toFixed(precision)).join(","))
      .join("\n"),
  );
}

export function vectorHash(vector: Float32Array): string {
  return new Bun.CryptoHasher("sha256").update(vector).digest("hex");
}

async function hostedEmbeddings(
  model: Record<string, unknown>,
  texts: string[],
  dimensions: number,
) {
  const envName = String(model.api_key_env ?? "");
  const apiKey = process.env[envName];
  if (!apiKey)
    throw failure(
      "model_credentials_missing",
      `Provider credential environment ${envName} is missing`,
      "external",
    );
  const endpoint = `${String(model.endpoint_identity).replace(/\/$/, "")}/embeddings`;
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: model.provider_model_id,
          input: texts,
          dimensions,
          encoding_format: "float",
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 429) {
        last = failure(
          "model_rate_limited",
          "Embedding Provider rate limited the request",
          "external",
          {
            retryable: true,
          },
        );
        if (attempt < 2) continue;
        throw last;
      }
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        const message = JSON.stringify(body).toLowerCase();
        if (response.status === 404 || message.includes("model_not_found"))
          throw failure("model_not_found", "Embedding Provider Model was not found", "external");
        throw failure(
          "model_call_failed",
          `Embedding Provider returned HTTP ${response.status}`,
          "external",
          {
            retryable: response.status >= 500,
          },
        );
      }
      const data = Array.isArray(body.data) ? body.data : [];
      const ordered = [...data].sort(
        (left, right) =>
          Number((left as Record<string, unknown>).index) -
          Number((right as Record<string, unknown>).index),
      );
      return {
        vectors: ordered.map((item) =>
          Float32Array.from((item as Record<string, unknown>).embedding as number[]),
        ),
        actualModel: String(body.model ?? model.provider_model_id),
        promptTokens:
          body.usage && typeof body.usage === "object"
            ? Number((body.usage as Record<string, unknown>).prompt_tokens ?? 0)
            : null,
      };
    } catch (cause) {
      if (cause instanceof SelfFailure) throw cause;
      last = cause;
      if (attempt === 2) break;
    }
  }
  throw modelFailure(last);
}

function fixtureEmbeddings(texts: string[], dimensions: number, model: string, drift: boolean) {
  const salt = `${model}:${drift ? "drift" : "stable"}`;
  return {
    vectors: texts.map((text) => hashedNgramVector(text, dimensions, salt)),
    actualModel: model,
    promptTokens: texts.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0),
  };
}

function hashedNgramVector(text: string, dimensions: number, salt: string): Float32Array {
  const normalized = text.normalize("NFKC").toLowerCase();
  const tokens = new Set(normalized.split(/\s+/u).filter(Boolean));
  for (let index = 0; index < normalized.length - 1; index += 1)
    tokens.add(normalized.slice(index, index + 2));
  for (let index = 0; index < normalized.length - 2; index += 1)
    tokens.add(normalized.slice(index, index + 3));
  const vector = new Float32Array(dimensions);
  for (const token of tokens) {
    const digest = new Bun.CryptoHasher("sha256")
      .update(`${salt}\n${token}`)
      .digest() as Uint8Array;
    const index = ((digest[0] ?? 0) * 256 + (digest[1] ?? 0)) % dimensions;
    vector[index] = (vector[index] ?? 0) + ((digest[2] ?? 0) % 2 === 0 ? 1 : -1);
  }
  return vector;
}

function validateAndNormalize(vector: Float32Array, dimensions: number): Float32Array {
  if (vector.length !== dimensions)
    throw failure(
      "model_dimension_mismatch",
      "Provider returned an incompatible vector dimension",
      "external",
    );
  let norm = 0;
  for (const value of vector) {
    if (!Number.isFinite(value))
      throw failure("model_response_invalid", "Provider returned a non-finite vector", "external");
    norm += value * value;
  }
  if (norm === 0)
    throw failure("model_response_invalid", "Provider returned a zero vector", "external");
  const output = new Float32Array(dimensions);
  const scale = 1 / Math.sqrt(norm);
  for (let index = 0; index < dimensions; index += 1) output[index] = (vector[index] ?? 0) * scale;
  return output;
}

async function beginInvocation(
  root: string,
  input: {
    invocationId: string;
    model: ModelView;
    vectorSpaceId?: string;
    operationKind: string;
    inputHash: string;
    inputCount: number;
    createdAt: string;
  },
) {
  const database = await writableModelDatabase(root);
  try {
    database
      .prepare(
        `INSERT INTO model_invocations(invocation_id, provider_id, model_id, vector_space_id,
         operation_kind, input_hash, input_count, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(
        input.invocationId,
        input.model.provider_id,
        input.model.model_id,
        input.vectorSpaceId ?? null,
        input.operationKind,
        input.inputHash,
        input.inputCount,
        input.createdAt,
      );
  } finally {
    database.close();
  }
}

async function finishInvocation(
  root: string,
  invocationId: string,
  value: { actualModel: string; promptTokens: number | null; durationMs: number },
) {
  const database = await writableModelDatabase(root);
  try {
    database
      .prepare(
        `UPDATE model_invocations SET status = 'succeeded', provider_actual_model_id = ?,
         prompt_tokens = ?, duration_ms = ?, completed_at = ? WHERE invocation_id = ?`,
      )
      .run(
        value.actualModel,
        value.promptTokens,
        value.durationMs,
        new Date().toISOString(),
        invocationId,
      );
  } finally {
    database.close();
  }
}

async function failInvocation(
  root: string,
  invocationId: string,
  code: string,
  durationMs: number,
) {
  const database = await writableModelDatabase(root);
  try {
    database
      .prepare(
        `UPDATE model_invocations SET status = 'failed', error_code = ?, duration_ms = ?,
         completed_at = ? WHERE invocation_id = ?`,
      )
      .run(code, durationMs, new Date().toISOString(), invocationId);
  } finally {
    database.close();
  }
}

async function openProviderCircuit(root: string, providerId: string, code: string) {
  const database = await writableModelDatabase(root);
  try {
    database
      .prepare(
        `UPDATE model_providers SET circuit_state = 'open', last_error_code = ?,
         last_error_at = ?, updated_at = ? WHERE provider_id = ?`,
      )
      .run(code, new Date().toISOString(), new Date().toISOString(), providerId);
  } finally {
    database.close();
  }
}

function modelFailure(cause: unknown): SelfFailure {
  return failure("model_call_failed", "Embedding Provider call failed", "external", {
    retryable: true,
    details: { reason: cause instanceof Error ? cause.message : String(cause) },
  });
}
