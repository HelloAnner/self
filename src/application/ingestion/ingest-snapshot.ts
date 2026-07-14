import {
  ingestionConfigFingerprint,
  type ParsedSnapshotEntry,
} from "../../domains/ingestion/index.ts";
import { chunkDocument, type KnowledgeDocumentDraft } from "../../domains/knowledge/index.ts";
import { loadSelfConfig } from "../../domains/workspace/config/codec.ts";
import { getSnapshotRenames } from "../../infrastructure/connection/connection-query-repository.ts";
import {
  beginIngestionRun,
  completeIngestionRun,
  failIngestionRun,
  markIngestionStage,
  recordFailedEntry,
  recordIngestionOperation,
  replaceEntryResults,
} from "../../infrastructure/ingestion/ingestion-repository.ts";
import { syncFtsForSource } from "../../infrastructure/knowledge/fts-index.ts";
import { publishKnowledgeSnapshot } from "../../infrastructure/knowledge/knowledge-publisher.ts";
import { publicationForRun } from "../../infrastructure/knowledge/knowledge-reader.ts";
import { parseSnapshotEntry } from "../../infrastructure/parsers/parser-router.ts";
import { invalidateActiveAnswers } from "../../infrastructure/retrieval/evidence-repository.ts";
import { getSnapshotEntries, getSource } from "../../infrastructure/source/source-reader.ts";
import { invalidateActiveTopics } from "../../infrastructure/topic/topic-invalidation.ts";
import { failure, SelfFailure } from "../../shared/errors/self-error.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import { refreshActiveGraphAfterKnowledgeChange } from "../graph/graph-build.ts";
import { refreshActiveVectorSpace } from "../knowledge/vector-space-workflows.ts";

export async function ingestSnapshot(
  root: string,
  input: {
    sourceId: string;
    snapshotId: string;
    trigger: "source_add" | "source_sync" | "connection" | "manual" | "rebuild" | "recovery";
    afterCheckpoint?: (checkpoint: "after_knowledge_publish") => void | Promise<void>;
  },
  requestId: string,
) {
  const source = await getSource(root, input.sourceId);
  if (source.state === "deleted")
    throw failure("source_deleted", "Deleted Source cannot be ingested", "state");
  const config = await loadSelfConfig(root);
  const chunker = {
    max_tokens: config.ingestion.max_chunk_tokens,
    overlap_tokens: config.ingestion.chunk_overlap_tokens,
  };
  if (chunker.overlap_tokens >= chunker.max_tokens) {
    throw failure(
      "ingestion_config_invalid",
      "Chunk overlap must be smaller than the maximum Chunk size",
      "state",
    );
  }
  const fingerprint = ingestionConfigFingerprint(chunker);
  const started = await beginIngestionRun(root, {
    sourceId: input.sourceId,
    snapshotId: input.snapshotId,
    trigger: input.trigger,
    configFingerprint: fingerprint,
  });
  const runId = started.run.ingestion_run_id;
  if (started.reused && started.run.state === "ready") {
    return readyResult(root, runId, input.sourceId, input.snapshotId, requestId, true);
  }
  try {
    await markIngestionStage(root, runId, "parsing", { snapshot_id: input.snapshotId });
    const entries = await getSnapshotEntries(root, input.sourceId, input.snapshotId);
    const parsed: ParsedSnapshotEntry[] = [];
    for (const entry of entries) {
      try {
        parsed.push(
          await parseSnapshotEntry({
            root,
            logicalPath: entry.logical_path,
            blobSha256: entry.blob_sha256,
            blobRelativePath: entry.blob_relative_path,
            mimeType: entry.mime_type,
            sizeBytes: entry.size_bytes,
          }),
        );
      } catch (cause) {
        await recordFailedEntry(root, runId, {
          logicalPath: entry.logical_path,
          blobSha256: entry.blob_sha256,
          code: "ingestion_parse_failed",
        });
        throw failure("ingestion_parse_failed", `Could not parse ${entry.logical_path}`, "state", {
          retryable: true,
          details: { reason: cause instanceof Error ? cause.message : String(cause) },
        });
      }
    }
    await markIngestionStage(root, runId, "normalized", { parsed: parsed.length });
    const drafts = knowledgeDrafts(parsed, chunker);
    await replaceEntryResults(
      root,
      runId,
      parsed,
      new Map(drafts.map((draft) => [draft.document.logical_path, draft.chunks.length])),
    );
    await markIngestionStage(root, runId, "chunked", {
      chunks: drafts.reduce((total, draft) => total + draft.chunks.length, 0),
    });
    await markIngestionStage(root, runId, "publishing");
    const publication = await publishKnowledgeSnapshot(root, {
      ingestionRunId: runId,
      sourceId: input.sourceId,
      snapshotId: input.snapshotId,
      algorithmFingerprint: fingerprint,
      drafts,
      presentPaths: entries.map((entry) => entry.logical_path),
      renames: await getSnapshotRenames(root, input.snapshotId),
    });
    await input.afterCheckpoint?.("after_knowledge_publish");
    await syncFtsForSource(root, input.sourceId);
    await invalidateActiveAnswers(root, `knowledge_changed:${input.sourceId}`);
    await invalidateActiveTopics(root, `knowledge_changed:${input.sourceId}`);
    const vectorProjection = await refreshActiveVectorSpace(root, {
      sourceId: input.sourceId,
      allowDegraded: true,
    });
    await completeIngestionRun(root, runId, {
      documents: publication.documents_published,
      chunksPublished: publication.chunks_published,
      chunksReused: publication.chunks_reused,
      chunksTombstoned: publication.chunks_tombstoned,
    });
    const graphProjection = await refreshGraphSafely(root);
    const operationId = await operation(root, requestId, runId, "knowledge.build", publication);
    return {
      operation_id: operationId,
      ingestion_run_id: runId,
      source_id: input.sourceId,
      snapshot_id: input.snapshotId,
      ingestion_status: "ready" as const,
      reused_run: false,
      vector_projection: vectorProjection,
      graph_projection: graphProjection,
      ...publication,
    };
  } catch (cause) {
    const error = asIngestionFailure(cause);
    await failIngestionRun(root, runId, error.selfError.code, error.selfError.message);
    throw error;
  }
}

function knowledgeDrafts(
  entries: ParsedSnapshotEntry[],
  config: { max_tokens: number; overlap_tokens: number },
): KnowledgeDocumentDraft[] {
  return entries.flatMap((entry) =>
    entry.document
      ? [
          {
            document: entry.document,
            blob_sha256: entry.blob_sha256,
            chunks: chunkDocument(entry.document, config),
          },
        ]
      : [],
  );
}

async function readyResult(
  root: string,
  runId: string,
  sourceId: string,
  snapshotId: string,
  requestId: string,
  reused: boolean,
) {
  await syncFtsForSource(root, sourceId);
  const vectorProjection = await refreshActiveVectorSpace(root, {
    sourceId,
    allowDegraded: true,
  });
  const graphProjection = await refreshGraphSafely(root);
  const publication = await publicationForRun(root, runId);
  const result = {
    ingestion_run_id: runId,
    source_id: sourceId,
    snapshot_id: snapshotId,
    ingestion_status: "ready" as const,
    reused_run: reused,
    vector_projection: vectorProjection,
    graph_projection: graphProjection,
    documents: publication.documents,
  };
  const operationId = await operation(root, requestId, runId, "knowledge.build.reused", result);
  return { operation_id: operationId, ...result };
}

async function refreshGraphSafely(root: string) {
  try {
    return await refreshActiveGraphAfterKnowledgeChange(root);
  } catch (cause) {
    return {
      graph_status: "degraded",
      error_code:
        cause instanceof SelfFailure ? cause.selfError.code : "graph_incremental_refresh_failed",
    };
  }
}

async function operation(
  root: string,
  requestId: string,
  runId: string,
  kind: string,
  result: Record<string, unknown>,
): Promise<string> {
  const operationId = createResourceId("operation");
  await recordIngestionOperation(root, { operationId, requestId, runId, kind, result });
  return operationId;
}

function asIngestionFailure(cause: unknown): SelfFailure {
  return cause instanceof SelfFailure
    ? cause
    : failure("ingestion_failed", "Snapshot ingestion failed", "state", {
        retryable: true,
        details: { reason: cause instanceof Error ? cause.message : String(cause) },
      });
}
