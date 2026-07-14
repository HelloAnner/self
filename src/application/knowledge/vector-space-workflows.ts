import { sha256Text } from "../../infrastructure/filesystem/hash.ts";
import { vectorTableName } from "../../infrastructure/knowledge/vector-index.ts";
import {
  activeChunks,
  activeVectorSpace,
  documentEmbeddingInput,
  embeddingInputHash,
  getSpace,
  listVectorSpaces,
  saveEmbedding,
  showVectorSpace,
  type VectorSpaceRow,
  vectorCoverage,
} from "../../infrastructure/knowledge/vector-space-repository.ts";
import { embedModelTexts, vectorHash } from "../../infrastructure/model/embedding-provider.ts";
import { writableModelDatabase } from "../../infrastructure/model/model-db.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import { checkVectorSpaceSentinel } from "./model-sentinel-workflows.ts";

export const vectorSpaceQueries = {
  list: listVectorSpaces,
  show: showVectorSpace,
  active: activeVectorSpace,
};

export async function buildVectorSpace(
  root: string,
  vectorSpaceId: string,
  options: { batchSize?: number } = {},
) {
  const batchSize = options.batchSize ?? 10;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100)
    throw failure("vector_space_input_invalid", "Batch size must be between 1 and 100", "usage");
  let database = await writableModelDatabase(root);
  let space: VectorSpaceRow;
  let chunks: ReturnType<typeof activeChunks>;
  let runId: string;
  try {
    space = getSpace(database, vectorSpaceId);
    if (!["building", "failed", "verifying"].includes(space.state))
      throw failure(
        "vector_space_build_invalid",
        "Only an unactivated VectorSpace can build",
        "state",
      );
    chunks = activeChunks(database);
    const watermark = `${chunks.length}:${chunks.at(-1)?.chunk_id ?? "empty"}:${chunks.at(-1)?.content_hash ?? "empty"}`;
    const idempotencyKey = sha256Text(`${space.space_fingerprint}\n${watermark}`);
    const existing = database
      .query<{ vector_build_run_id: string; state: string }, [string]>(
        "SELECT vector_build_run_id, state FROM vector_build_runs WHERE idempotency_key = ?",
      )
      .get(idempotencyKey);
    if (existing?.state === "ready")
      return { vector_build_run_id: existing.vector_build_run_id, state: "ready", reused: true };
    runId = existing?.vector_build_run_id ?? createResourceId("vector-build");
    const now = new Date().toISOString();
    if (existing)
      database
        .prepare(
          `UPDATE vector_build_runs SET state = 'building', attempt = attempt + 1,
           error_code = NULL, updated_at = ? WHERE vector_build_run_id = ?`,
        )
        .run(now, runId);
    else
      database
        .prepare(
          `INSERT INTO vector_build_runs(vector_build_run_id, vector_space_id, state,
           idempotency_key, input_watermark, chunks_total, batch_size, created_at, updated_at)
           VALUES (?, ?, 'building', ?, ?, ?, ?, ?, ?)`,
        )
        .run(runId, vectorSpaceId, idempotencyKey, watermark, chunks.length, batchSize, now, now);
    database
      .prepare(
        `UPDATE vector_spaces SET state = 'building', expected_chunk_count = ?,
         last_error_code = NULL, updated_at = ?, version = version + 1 WHERE vector_space_id = ?`,
      )
      .run(chunks.length, now, vectorSpaceId);
  } finally {
    database.close();
  }
  try {
    await checkVectorSpaceSentinel(root, space);
    let processedBatch = false;
    for (let offset = 0; offset < chunks.length; offset += batchSize) {
      const batch = chunks.slice(offset, offset + batchSize);
      database = await writableModelDatabase(root);
      const missing = [] as typeof batch;
      try {
        for (const chunk of batch) {
          const exists = database
            .query<{ embedding_id: string }, [string, string, string]>(
              `SELECT embedding_id FROM knowledge_embeddings WHERE vector_space_id = ?
               AND chunk_id = ? AND chunk_content_hash = ? AND state = 'active'`,
            )
            .get(vectorSpaceId, chunk.chunk_id, chunk.content_hash);
          if (!exists) missing.push(chunk);
        }
      } finally {
        database.close();
      }
      if (missing.length > 0) {
        const texts = missing.map(documentEmbeddingInput);
        const call = await embedModelTexts(root, {
          modelId: space.model_id,
          vectorSpaceId,
          dimensions: space.dimensions,
          texts,
          operationKind: "vector-space.build",
        });
        database = await writableModelDatabase(root);
        try {
          for (let index = 0; index < missing.length; index += 1) {
            const chunk = missing[index];
            const vector = call.vectors[index];
            if (!chunk || !vector) throw new Error("Embedding batch result mismatch");
            saveEmbedding(database, {
              space,
              chunkId: chunk.chunk_id,
              contentHash: chunk.content_hash,
              inputHash: embeddingInputHash(texts[index] ?? ""),
              vectorHash: vectorHash(vector),
              vector,
              invocationId: call.invocation_id,
              actualModel: call.provider_actual_model_id,
            });
          }
        } finally {
          database.close();
        }
      }
      database = await writableModelDatabase(root);
      try {
        const coverage = vectorCoverage(database, space);
        database
          .prepare(
            `UPDATE vector_build_runs SET cursor_chunk_id = ?, chunks_embedded = ?,
             chunks_reused = ?, updated_at = ? WHERE vector_build_run_id = ?`,
          )
          .run(
            batch.at(-1)?.chunk_id ?? null,
            coverage.covered,
            Math.max(0, offset + batch.length - missing.length),
            new Date().toISOString(),
            runId,
          );
      } finally {
        database.close();
      }
      if (!processedBatch && process.env.SELF_TEST_CRASH_VECTOR_AFTER_BATCH === "1")
        process.exit(99);
      processedBatch = true;
    }
    database = await writableModelDatabase(root);
    try {
      const coverage = vectorCoverage(database, space);
      const now = new Date().toISOString();
      database.transaction(() => {
        database
          .prepare(
            `UPDATE vector_build_runs SET state = 'verifying', chunks_embedded = ?,
             updated_at = ? WHERE vector_build_run_id = ?`,
          )
          .run(coverage.covered, now, runId);
        database
          .prepare(
            `UPDATE vector_spaces SET state = 'verifying', coverage_count = ?,
             expected_chunk_count = ?, updated_at = ?, version = version + 1 WHERE vector_space_id = ?`,
          )
          .run(coverage.covered, coverage.expected, now, vectorSpaceId);
      })();
      return {
        vector_build_run_id: runId,
        vector_space_id: vectorSpaceId,
        state: "verifying",
        ...coverage,
      };
    } finally {
      database.close();
    }
  } catch (cause) {
    database = await writableModelDatabase(root);
    try {
      const code =
        cause instanceof Error && "selfError" in cause
          ? String((cause as { selfError: { code: string } }).selfError.code)
          : "vector_build_failed";
      const now = new Date().toISOString();
      database
        .prepare(
          `UPDATE vector_build_runs SET state = 'failed', error_code = ?, updated_at = ?,
           finished_at = ? WHERE vector_build_run_id = ?`,
        )
        .run(code, now, now, runId);
      database
        .prepare(
          `UPDATE vector_spaces SET state = 'failed', last_error_code = ?, updated_at = ?,
           version = version + 1 WHERE vector_space_id = ?`,
        )
        .run(code, now, vectorSpaceId);
    } finally {
      database.close();
    }
    throw cause;
  }
}

export async function verifyVectorSpace(root: string, vectorSpaceId: string) {
  let database = await writableModelDatabase(root);
  let space: VectorSpaceRow;
  try {
    space = getSpace(database, vectorSpaceId);
    if (!["verifying", "ready"].includes(space.state))
      throw failure(
        "vector_space_verify_invalid",
        "VectorSpace must finish build before verify",
        "state",
      );
  } finally {
    database.close();
  }
  await checkVectorSpaceSentinel(root, space);
  database = await writableModelDatabase(root);
  try {
    space = getSpace(database, vectorSpaceId);
    const coverage = vectorCoverage(database, space);
    const passed =
      coverage.expected > 0 &&
      coverage.covered === coverage.expected &&
      coverage.stored >= coverage.covered;
    const evaluationId = createResourceId("evaluation");
    const now = new Date().toISOString();
    database.transaction(() => {
      database
        .prepare(
          `INSERT INTO vector_space_evaluations(evaluation_id, left_vector_space_id, kind,
           status, fixture_id, metrics_json, created_at) VALUES (?, ?, 'verify', ?,
           'coverage-and-integrity-v1', ?, ?)`,
        )
        .run(
          evaluationId,
          vectorSpaceId,
          passed ? "passed" : "failed",
          JSON.stringify(coverage),
          now,
        );
      database
        .prepare(
          `UPDATE vector_spaces SET state = ?, coverage_count = ?, expected_chunk_count = ?,
           verified_at = ?, last_error_code = ?, updated_at = ?, version = version + 1
           WHERE vector_space_id = ?`,
        )
        .run(
          passed ? "ready" : "failed",
          coverage.covered,
          coverage.expected,
          passed ? now : null,
          passed ? null : "vector_coverage_incomplete",
          now,
          vectorSpaceId,
        );
      database
        .prepare(
          `UPDATE vector_build_runs SET state = ?, chunks_embedded = ?, chunks_failed = ?,
           updated_at = ?, finished_at = ? WHERE vector_build_run_id = (
             SELECT vector_build_run_id FROM vector_build_runs WHERE vector_space_id = ?
             ORDER BY created_at DESC LIMIT 1)`,
        )
        .run(
          passed ? "ready" : "failed",
          coverage.covered,
          coverage.expected - coverage.covered,
          now,
          now,
          vectorSpaceId,
        );
    })();
    if (!passed)
      throw failure(
        "vector_space_verify_failed",
        "VectorSpace coverage verification failed",
        "state",
        {
          details: coverage,
        },
      );
    return {
      evaluation_id: evaluationId,
      vector_space_id: vectorSpaceId,
      status: "passed" as const,
      ...coverage,
    };
  } finally {
    database.close();
  }
}

export async function compareVectorSpaces(
  root: string,
  leftId: string,
  rightId: string,
  fixtureId: string,
) {
  const database = await writableModelDatabase(root);
  try {
    const left = getSpace(database, leftId);
    const right = getSpace(database, rightId);
    if (
      !["ready", "deprecated"].includes(left.state) ||
      !["ready", "deprecated"].includes(right.state)
    )
      throw failure("vector_space_compare_invalid", "Both VectorSpaces must be verified", "state");
    const leftCoverage = vectorCoverage(database, left);
    const rightCoverage = vectorCoverage(database, right);
    const metrics = {
      fixture_id: fixtureId,
      left_coverage: leftCoverage,
      right_coverage: rightCoverage,
      same_fingerprint: left.space_fingerprint === right.space_fingerprint,
      comparable_scores: left.space_fingerprint === right.space_fingerprint,
    };
    const evaluationId = createResourceId("evaluation");
    database
      .prepare(
        `INSERT INTO vector_space_evaluations(evaluation_id, left_vector_space_id,
         right_vector_space_id, kind, status, fixture_id, fixture_hash, metrics_json, created_at)
         VALUES (?, ?, ?, 'compare', 'passed', ?, ?, ?, ?)`,
      )
      .run(
        evaluationId,
        leftId,
        rightId,
        fixtureId,
        sha256Text(fixtureId),
        JSON.stringify(metrics),
        new Date().toISOString(),
      );
    return { evaluation_id: evaluationId, status: "passed" as const, ...metrics };
  } finally {
    database.close();
  }
}

export async function refreshActiveVectorSpace(
  root: string,
  options: { sourceId?: string; allowDegraded?: boolean } = {},
) {
  let database = await writableModelDatabase(root);
  let space: VectorSpaceRow | null = null;
  let missing: ReturnType<typeof activeChunks> = [];
  try {
    const active = database
      .query<{ active_vector_space_id: string | null }, []>(
        "SELECT active_vector_space_id FROM knowledge_active_vector_space WHERE singleton_id = 1",
      )
      .get()?.active_vector_space_id;
    if (!active) return { state: "not_active" as const, embedded: 0 };
    space = getSpace(database, active);
    if (space.state !== "ready")
      throw failure("vector_space_not_active", "Active VectorSpace is not ready", "state");
    const stale = database
      .query<{ embedding_id: string }, [string]>(
        `SELECT e.embedding_id FROM knowledge_embeddings e
         LEFT JOIN knowledge_chunks c ON c.chunk_id = e.chunk_id
         WHERE e.vector_space_id = ? AND e.state = 'active'
         AND (c.chunk_id IS NULL OR c.state != 'active' OR c.content_hash != e.chunk_content_hash)`,
      )
      .all(space.vector_space_id);
    if (stale.length > 0) {
      const table = vectorTableName(space.dimensions);
      database.transaction(() => {
        const mark = database.prepare(
          "UPDATE knowledge_embeddings SET state = 'stale', updated_at = ? WHERE embedding_id = ?",
        );
        const remove = database.prepare(`DELETE FROM ${table} WHERE embedding_id = ?`);
        for (const item of stale) {
          mark.run(new Date().toISOString(), item.embedding_id);
          remove.run(item.embedding_id);
        }
      })();
    }
    missing = activeChunks(database, options.sourceId).filter(
      (chunk) =>
        !database
          .query<{ embedding_id: string }, [string, string, string]>(
            `SELECT embedding_id FROM knowledge_embeddings WHERE vector_space_id = ?
             AND chunk_id = ? AND chunk_content_hash = ? AND state = 'active'`,
          )
          .get(space?.vector_space_id ?? "", chunk.chunk_id, chunk.content_hash),
    );
  } finally {
    database.close();
  }
  try {
    for (let offset = 0; offset < missing.length; offset += 10) {
      const batch = missing.slice(offset, offset + 10);
      const texts = batch.map(documentEmbeddingInput);
      const call = await embedModelTexts(root, {
        modelId: space.model_id,
        vectorSpaceId: space.vector_space_id,
        dimensions: space.dimensions,
        texts,
        operationKind: "vector-space.incremental",
      });
      database = await writableModelDatabase(root);
      try {
        for (let index = 0; index < batch.length; index += 1) {
          const chunk = batch[index];
          const vector = call.vectors[index];
          if (!chunk || !vector) throw new Error("Incremental Embedding result mismatch");
          saveEmbedding(database, {
            space,
            chunkId: chunk.chunk_id,
            contentHash: chunk.content_hash,
            inputHash: embeddingInputHash(texts[index] ?? ""),
            vectorHash: vectorHash(vector),
            vector,
            invocationId: call.invocation_id,
            actualModel: call.provider_actual_model_id,
          });
        }
      } finally {
        database.close();
      }
    }
    database = await writableModelDatabase(root);
    try {
      const coverage = vectorCoverage(database, space);
      database
        .prepare(
          `UPDATE vector_spaces SET coverage_count = ?, expected_chunk_count = ?,
           updated_at = ?, version = version + 1 WHERE vector_space_id = ?`,
        )
        .run(coverage.covered, coverage.expected, new Date().toISOString(), space.vector_space_id);
      return { state: "ready" as const, embedded: missing.length, ...coverage };
    } finally {
      database.close();
    }
  } catch (cause) {
    database = await writableModelDatabase(root);
    try {
      const coverage = vectorCoverage(database, space);
      database
        .prepare(
          `UPDATE vector_spaces SET coverage_count = ?, expected_chunk_count = ?,
           last_error_code = 'vector_incremental_failed', updated_at = ?, version = version + 1
           WHERE vector_space_id = ?`,
        )
        .run(coverage.covered, coverage.expected, new Date().toISOString(), space.vector_space_id);
    } finally {
      database.close();
    }
    if (options.allowDegraded)
      return { state: "degraded" as const, embedded: 0, error_code: "vector_incremental_failed" };
    throw cause;
  }
}
