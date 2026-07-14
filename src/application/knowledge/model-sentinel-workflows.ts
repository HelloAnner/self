import type { VectorSpaceRow } from "../../infrastructure/knowledge/vector-space-repository.ts";
import { getSpace } from "../../infrastructure/knowledge/vector-space-repository.ts";
import {
  embeddingFingerprint,
  embedModelTexts,
  PUBLIC_SENTINELS,
} from "../../infrastructure/model/embedding-provider.ts";
import { writableModelDatabase } from "../../infrastructure/model/model-db.ts";
import { getModel } from "../../infrastructure/model/model-repository.ts";
import { failure } from "../../shared/errors/self-error.ts";

export async function testEmbeddingModel(root: string, modelId: string) {
  const model = await getModel(root, modelId);
  const dimensions = model.dimensions[0];
  if (!dimensions)
    throw failure("model_dimension_mismatch", "Model has no registered dimensions", "state");
  await setProviderCircuit(root, model.provider_id, "half_open");
  try {
    const result = await embedModelTexts(root, {
      modelId,
      dimensions,
      texts: [...PUBLIC_SENTINELS],
      operationKind: "model.test.embedding-compat",
    });
    await setProviderCircuit(root, model.provider_id, "closed");
    return {
      model_id: modelId,
      suite: "embedding-compat",
      status: "passed" as const,
      dimensions,
      vectors: result.vectors.length,
      provider_actual_model_id: result.provider_actual_model_id,
      sentinel_fingerprint: embeddingFingerprint(result.vectors),
      invocation_id: result.invocation_id,
    };
  } catch (cause) {
    await setProviderCircuit(root, model.provider_id, "open", "model_test_failed");
    throw cause;
  }
}

export async function checkVectorSpaceSentinel(root: string, space: VectorSpaceRow) {
  const call = await embedModelTexts(root, {
    modelId: space.model_id,
    vectorSpaceId: space.vector_space_id,
    dimensions: space.dimensions,
    texts: [...PUBLIC_SENTINELS],
    operationKind: "vector-space.sentinel",
  });
  const fingerprint = embeddingFingerprint(call.vectors);
  const database = await writableModelDatabase(root);
  let drifted = false;
  try {
    const current = getSpace(database, space.vector_space_id);
    const status = !current.sentinel_fingerprint
      ? "baseline"
      : current.sentinel_fingerprint === fingerprint
        ? "match"
        : "drift";
    database
      .prepare(
        `INSERT INTO model_sentinel_results(vector_space_id, invocation_id,
         sentinel_fingerprint, provider_actual_model_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        space.vector_space_id,
        call.invocation_id,
        fingerprint,
        call.provider_actual_model_id,
        status,
        new Date().toISOString(),
      );
    if (status === "baseline")
      database
        .prepare(
          "UPDATE vector_spaces SET sentinel_fingerprint = ?, updated_at = ? WHERE vector_space_id = ?",
        )
        .run(fingerprint, new Date().toISOString(), space.vector_space_id);
    drifted = status === "drift";
  } finally {
    database.close();
  }
  if (drifted) {
    const model = await getModel(root, space.model_id);
    await setProviderCircuit(root, model.provider_id, "open", "model_drift_detected");
    throw failure("model_drift_detected", "Embedding sentinel fingerprint drifted", "external");
  }
}

async function setProviderCircuit(
  root: string,
  providerId: string,
  state: "closed" | "open" | "half_open",
  errorCode?: string,
) {
  const database = await writableModelDatabase(root);
  try {
    database
      .prepare(
        `UPDATE model_providers SET circuit_state = ?, last_error_code = ?, last_error_at = ?,
         updated_at = ? WHERE provider_id = ?`,
      )
      .run(
        state,
        errorCode ?? null,
        errorCode ? new Date().toISOString() : null,
        new Date().toISOString(),
        providerId,
      );
  } finally {
    database.close();
  }
}
