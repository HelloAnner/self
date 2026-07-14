import type { ModelProvider, RegisteredModel } from "../../domains/model/index.ts";
import { loadSelfConfig } from "../../domains/workspace/config/codec.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import { sha256Text } from "../filesystem/hash.ts";
import { readonlyModelDatabase, writableModelDatabase } from "./model-db.ts";

export type ModelView = Record<string, unknown> & {
  model_id: string;
  provider_id: string;
  capability: string;
  provider_model_id: string;
  state: string;
  provider_type: string;
  provider_state: string;
  circuit_state: string;
  endpoint_identity: string;
  api_key_env: string | null;
  dimensions: number[];
};

export async function registerEmbeddingModel(
  root: string,
  input: {
    providerName: string;
    providerModelId: string;
    revision: string;
    dimensions: number[];
    requestId: string;
  },
) {
  const provider = await providerDefinition(root, input.providerName);
  const database = await writableModelDatabase(root);
  try {
    const now = new Date().toISOString();
    const existingProvider = database
      .query<ModelProvider, [string]>("SELECT * FROM model_providers WHERE name = ?")
      .get(input.providerName);
    const providerId = existingProvider?.provider_id ?? createResourceId("provider");
    if (existingProvider) syncProviderCredential(database, existingProvider, provider, now);
    if (!existingProvider)
      database
        .prepare(
          `INSERT INTO model_providers(provider_id, name, provider_type, protocol,
           endpoint_identity, api_key_env, state, circuit_state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', 'closed', ?, ?)`,
        )
        .run(
          providerId,
          input.providerName,
          provider.providerType,
          provider.protocol,
          provider.endpoint,
          provider.apiKeyEnv,
          now,
          now,
        );
    const existing = database
      .query<RegisteredModel, [string, string, string, string]>(
        `SELECT * FROM models WHERE provider_id = ? AND capability = 'embedding'
         AND provider_model_id = ? AND model_revision = ? AND dimensions_json = ?`,
      )
      .get(providerId, input.providerModelId, input.revision, JSON.stringify(input.dimensions));
    if (existing) return modelDto(existing, providerView(existingProvider, provider, providerId));
    const modelId = createResourceId("model");
    database.transaction(() => {
      database
        .prepare(
          `INSERT INTO models(model_id, provider_id, capability, provider_model_id,
           model_revision, revision_stability, dimensions_json, state, created_at, updated_at)
           VALUES (?, ?, 'embedding', ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          modelId,
          providerId,
          input.providerModelId,
          input.revision,
          input.revision === "floating" ? "floating" : "fixed",
          JSON.stringify(input.dimensions),
          now,
          now,
        );
      const operationId = createResourceId("operation");
      database
        .prepare(
          `INSERT INTO operations(operation_id, request_id, kind, status, target_id, input_hash,
           result_json, created_at, completed_at) VALUES (?, ?, 'model.add', 'succeeded', ?, ?, ?, ?, ?)`,
        )
        .run(
          operationId,
          input.requestId,
          modelId,
          sha256Text(`${providerId}\n${input.providerModelId}\n${input.revision}`),
          JSON.stringify({ model_id: modelId }),
          now,
          now,
        );
    })();
    return modelDto(
      {
        model_id: modelId,
        provider_id: providerId,
        capability: "embedding",
        provider_model_id: input.providerModelId,
        model_revision: input.revision,
        revision_stability: input.revision === "floating" ? "floating" : "fixed",
        dimensions_json: JSON.stringify(input.dimensions),
        state: "active",
      },
      providerView(existingProvider, provider, providerId),
    );
  } finally {
    database.close();
  }
}

export async function registerStructuredModel(
  root: string,
  input: {
    providerName: string;
    providerModelId: string;
    revision: string;
    capability: "chat";
    requestId: string;
  },
) {
  const provider = await providerDefinition(root, input.providerName);
  const database = await writableModelDatabase(root);
  try {
    const now = new Date().toISOString();
    const existingProvider = database
      .query<ModelProvider, [string]>("SELECT * FROM model_providers WHERE name = ?")
      .get(input.providerName);
    const providerId = existingProvider?.provider_id ?? createResourceId("provider");
    if (existingProvider) syncProviderCredential(database, existingProvider, provider, now);
    if (!existingProvider)
      database
        .prepare(
          `INSERT INTO model_providers(provider_id, name, provider_type, protocol,
           endpoint_identity, api_key_env, state, circuit_state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', 'closed', ?, ?)`,
        )
        .run(
          providerId,
          input.providerName,
          provider.providerType,
          provider.protocol,
          provider.endpoint,
          provider.apiKeyEnv,
          now,
          now,
        );
    const existing = database
      .query<RegisteredModel, [string, string, string, string]>(
        `SELECT * FROM models WHERE provider_id = ? AND capability = ?
         AND provider_model_id = ? AND model_revision = ?`,
      )
      .get(providerId, input.capability, input.providerModelId, input.revision);
    if (existing) return modelDto(existing, providerView(existingProvider, provider, providerId));
    const modelId = createResourceId("model");
    database.transaction(() => {
      database
        .prepare(
          `INSERT INTO models(model_id, provider_id, capability, provider_model_id,
           model_revision, revision_stability, dimensions_json, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, '[]', 'active', ?, ?)`,
        )
        .run(
          modelId,
          providerId,
          input.capability,
          input.providerModelId,
          input.revision,
          input.revision === "floating" ? "floating" : "fixed",
          now,
          now,
        );
      database
        .prepare(
          `INSERT INTO operations(operation_id, request_id, kind, status, target_id, input_hash,
           result_json, created_at, completed_at) VALUES (?, ?, 'model.add', 'succeeded', ?, ?, ?, ?, ?)`,
        )
        .run(
          createResourceId("operation"),
          input.requestId,
          modelId,
          sha256Text(
            `${providerId}\n${input.capability}\n${input.providerModelId}\n${input.revision}`,
          ),
          JSON.stringify({ model_id: modelId }),
          now,
          now,
        );
    })();
    return getModel(root, modelId);
  } finally {
    database.close();
  }
}

export async function listModels(root: string, capability?: string) {
  const database = await readonlyModelDatabase(root);
  try {
    return database
      .query<Record<string, unknown>, [string | null, string | null]>(
        `SELECT m.*, p.name provider_name, p.provider_type, p.endpoint_identity,
         p.api_key_env, p.circuit_state, p.state provider_state
         FROM models m JOIN model_providers p ON p.provider_id = m.provider_id
         WHERE (? IS NULL OR m.capability = ?) ORDER BY m.created_at, m.model_id`,
      )
      .all(capability ?? null, capability ?? null)
      .map(normalizeModelRow);
  } finally {
    database.close();
  }
}

export async function getModel(root: string, modelId: string) {
  const database = await readonlyModelDatabase(root);
  try {
    const row = database
      .query<Record<string, unknown>, [string]>(
        `SELECT m.*, p.name provider_name, p.provider_type, p.protocol,
         p.endpoint_identity, p.api_key_env, p.circuit_state, p.state provider_state
         FROM models m JOIN model_providers p ON p.provider_id = m.provider_id
         WHERE m.model_id = ?`,
      )
      .get(modelId);
    if (!row) throw failure("model_not_found", "Model does not exist", "not_found");
    return normalizeModelRow(row);
  } finally {
    database.close();
  }
}

export async function providerDefinition(root: string, name: string) {
  if (name === "fixture") {
    if (process.env.SELF_ENABLE_TEST_PROVIDERS !== "1")
      throw failure("model_provider_unconfigured", "Fixture Provider is test-only", "usage");
    return {
      name,
      providerType: "test_deterministic" as const,
      provider_type: "test_deterministic" as const,
      protocol: "fixture" as const,
      endpoint: "self://fixture/hash-ngram-v1",
      endpoint_identity: "self://fixture/hash-ngram-v1",
      apiKeyEnv: null,
      api_key_env: null,
      state: "active" as const,
      circuit_state: "closed" as const,
    };
  }
  const config = await loadSelfConfig(root);
  const configured = config.models.providers[name];
  if (configured)
    return {
      name,
      providerType: "openai_compatible" as const,
      provider_type: "openai_compatible" as const,
      protocol: configured.protocol,
      endpoint: configured.base_url.replace(/\/$/, ""),
      endpoint_identity: configured.base_url.replace(/\/$/, ""),
      apiKeyEnv: configured.api_key_env,
      api_key_env: configured.api_key_env,
      state: "active" as const,
      circuit_state: "closed" as const,
    };
  if (name === "dashscope")
    return {
      name,
      providerType: "openai_compatible" as const,
      provider_type: "openai_compatible" as const,
      protocol: "openai-compatible" as const,
      endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      endpoint_identity: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKeyEnv: "SELF_DASHSCOPE_API_KEY",
      api_key_env: "SELF_DASHSCOPE_API_KEY",
      state: "active" as const,
      circuit_state: "closed" as const,
    };
  throw failure("model_provider_unconfigured", "Provider is not configured", "usage");
}

function normalizeModelRow(row: Record<string, unknown>): ModelView {
  return {
    ...row,
    model_id: String(row.model_id),
    provider_id: String(row.provider_id),
    capability: String(row.capability),
    provider_model_id: String(row.provider_model_id),
    state: String(row.state),
    provider_type: String(row.provider_type),
    provider_state: String(row.provider_state ?? "active"),
    circuit_state: String(row.circuit_state),
    endpoint_identity: String(row.endpoint_identity),
    api_key_env:
      row.api_key_env === null || row.api_key_env === undefined ? null : String(row.api_key_env),
    dimensions: JSON.parse(String(row.dimensions_json ?? "[]")) as number[],
  };
}

function modelDto(model: RegisteredModel, provider: Record<string, unknown>) {
  return normalizeModelRow({
    ...model,
    provider_name: provider.name,
    provider_type: provider.provider_type,
    endpoint_identity: provider.endpoint_identity,
    circuit_state: provider.circuit_state,
  });
}

function syncProviderCredential(
  database: Awaited<ReturnType<typeof writableModelDatabase>>,
  existing: ModelProvider,
  configured: Awaited<ReturnType<typeof providerDefinition>>,
  now: string,
) {
  if (
    existing.provider_type !== configured.providerType ||
    existing.endpoint_identity !== configured.endpoint
  )
    throw failure(
      "model_provider_identity_conflict",
      "Configured Provider identity differs from the registered Provider",
      "conflict",
    );
  if (existing.api_key_env !== configured.apiKeyEnv)
    database
      .prepare(
        "UPDATE model_providers SET api_key_env = ?, state = 'active', updated_at = ? WHERE provider_id = ?",
      )
      .run(configured.apiKeyEnv, now, existing.provider_id);
}

function providerView(
  existing: ModelProvider | null,
  configured: Awaited<ReturnType<typeof providerDefinition>>,
  providerId: string,
) {
  return {
    ...(existing ?? {}),
    ...configured,
    provider_id: providerId,
    api_key_env: configured.apiKeyEnv,
  };
}
