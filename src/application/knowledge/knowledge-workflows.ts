import {
  findSnapshotOwner,
  knowledgeStatus,
  listBuildCandidates,
  listCurrentSnapshots,
  listIngestionFailures,
  showIngestionRun,
} from "../../infrastructure/ingestion/ingestion-query-repository.ts";
import { getIngestionRun } from "../../infrastructure/ingestion/ingestion-repository.ts";
import {
  listKnowledgeChunks,
  listKnowledgeDocuments,
  showKnowledgeChunk,
  showKnowledgeDocument,
  verifyKnowledge,
} from "../../infrastructure/knowledge/knowledge-reader.ts";
import { getSource } from "../../infrastructure/source/source-reader.ts";
import { failure, SelfFailure } from "../../shared/errors/self-error.ts";
import { ingestSnapshot } from "../ingestion/ingest-snapshot.ts";

export async function buildKnowledge(
  root: string,
  input: { sourceId?: string; snapshotId?: string; all?: boolean; rebuild?: boolean },
  requestId: string,
) {
  const targets = await selectTargets(root, input);
  const results = [];
  const failures = [];
  for (const target of targets) {
    try {
      results.push(
        await ingestSnapshot(
          root,
          {
            sourceId: target.source_id,
            snapshotId: target.current_snapshot_id,
            trigger: input.rebuild ? "rebuild" : "manual",
          },
          requestId,
        ),
      );
    } catch (cause) {
      failures.push({
        source_id: target.source_id,
        snapshot_id: target.current_snapshot_id,
        code: cause instanceof SelfFailure ? cause.selfError.code : "ingestion_failed",
      });
    }
  }
  if (failures.length > 0) {
    throw failure("knowledge_build_partial", "Some Snapshots could not be ingested", "state", {
      exitCode: 7,
      details: { results, failures },
    });
  }
  return results;
}

export async function retryIngestion(root: string, runId: string, requestId: string) {
  const run = await getIngestionRun(root, runId);
  if (run.state !== "failed" && run.state !== "publishing") {
    throw failure(
      "ingestion_retry_invalid",
      "Only failed or interrupted IngestionRuns can retry",
      "state",
    );
  }
  return ingestSnapshot(
    root,
    { sourceId: run.source_id, snapshotId: run.snapshot_id, trigger: "recovery" },
    requestId,
  );
}

export const knowledgeQueries = {
  status: knowledgeStatus,
  failures: listIngestionFailures,
  run: showIngestionRun,
  documents: listKnowledgeDocuments,
  document: showKnowledgeDocument,
  chunks: listKnowledgeChunks,
  chunk: showKnowledgeChunk,
  verify: verifyKnowledge,
};

async function selectTargets(
  root: string,
  input: { sourceId?: string; snapshotId?: string; all?: boolean },
) {
  if (input.snapshotId) {
    return [
      {
        source_id: await findSnapshotOwner(root, input.snapshotId),
        current_snapshot_id: input.snapshotId,
      },
    ];
  }
  if (input.sourceId) {
    const source = await getSource(root, input.sourceId);
    if (!source.current_snapshot_id) {
      throw failure("snapshot_not_found", "Source has no archived Snapshot", "state");
    }
    return [{ source_id: source.source_id, current_snapshot_id: source.current_snapshot_id }];
  }
  return input.all ? listCurrentSnapshots(root) : listBuildCandidates(root);
}
