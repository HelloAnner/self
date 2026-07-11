import type { ParsedSnapshotEntry } from "../../domains/ingestion/index.ts";
import { INGESTION_VERSIONS } from "../../domains/ingestion/index.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { sha256Text } from "../../shared/hash/sha256.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import { readableIngestionDatabase, writableIngestionDatabase } from "./ingestion-db.ts";

export type IngestionRunRow = {
  ingestion_run_id: string;
  source_id: string;
  snapshot_id: string;
  trigger_kind: string;
  state: string;
  config_fingerprint: string;
  attempt: number;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

export async function beginIngestionRun(
  root: string,
  input: { sourceId: string; snapshotId: string; trigger: string; configFingerprint: string },
) {
  const database = await writableIngestionDatabase(root);
  const now = new Date().toISOString();
  const key = sha256Text(`${input.snapshotId}\n${input.configFingerprint}`);
  try {
    return database.transaction(() => {
      const existing = database
        .query<IngestionRunRow, [string]>("SELECT * FROM ingestion_runs WHERE idempotency_key = ?")
        .get(key);
      if (existing) {
        if (existing.state === "ready") return { run: existing, reused: true };
        database
          .prepare(
            `UPDATE ingestion_runs SET state = 'retrying', trigger_kind = 'recovery', attempt = attempt + 1,
             error_code = NULL, error_message = NULL, finished_at = NULL, updated_at = ? WHERE ingestion_run_id = ?`,
          )
          .run(now, existing.ingestion_run_id);
        database
          .prepare(
            "UPDATE sources SET ingestion_status = 'queued', current_ingestion_run_id = ? WHERE source_id = ?",
          )
          .run(existing.ingestion_run_id, input.sourceId);
        return {
          run: { ...existing, state: "retrying", attempt: existing.attempt + 1, updated_at: now },
          reused: false,
        };
      }
      const runId = createResourceId("ingestion");
      database
        .prepare(
          `INSERT INTO ingestion_runs(ingestion_run_id, source_id, snapshot_id, trigger_kind, state,
           parser_version, normalizer_version, chunker_version, config_fingerprint, idempotency_key,
           created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          input.sourceId,
          input.snapshotId,
          input.trigger,
          INGESTION_VERSIONS.parser,
          INGESTION_VERSIONS.normalizer,
          INGESTION_VERSIONS.chunker,
          input.configFingerprint,
          key,
          now,
          now,
        );
      database
        .prepare(
          "UPDATE sources SET ingestion_status = 'queued', current_ingestion_run_id = ? WHERE source_id = ?",
        )
        .run(runId, input.sourceId);
      const run = database
        .query<IngestionRunRow, [string]>("SELECT * FROM ingestion_runs WHERE ingestion_run_id = ?")
        .get(runId);
      if (!run) throw new Error("IngestionRun was not persisted");
      return { run, reused: false };
    })();
  } finally {
    database.close();
  }
}

export async function markIngestionStage(
  root: string,
  runId: string,
  state: "parsing" | "normalized" | "chunked" | "publishing",
  checkpoint: Record<string, unknown> = {},
): Promise<void> {
  const database = await writableIngestionDatabase(root);
  const now = new Date().toISOString();
  try {
    database.transaction(() => {
      const result = database
        .prepare(
          `UPDATE ingestion_runs SET state = ?, checkpoint_json = ?, started_at = COALESCE(started_at, ?),
           updated_at = ? WHERE ingestion_run_id = ? AND state NOT IN ('ready', 'cancelled')`,
        )
        .run(state, JSON.stringify(checkpoint), now, now, runId);
      if (result.changes !== 1)
        throw failure(
          "ingestion_state_invalid",
          "IngestionRun cannot enter the requested stage",
          "state",
        );
      database
        .prepare(
          "UPDATE sources SET ingestion_status = 'running' WHERE current_ingestion_run_id = ?",
        )
        .run(runId);
    })();
  } finally {
    database.close();
  }
}

export async function replaceEntryResults(
  root: string,
  runId: string,
  entries: ParsedSnapshotEntry[],
  chunkCounts: Map<string, number>,
): Promise<void> {
  const database = await writableIngestionDatabase(root);
  const now = new Date().toISOString();
  try {
    database.transaction(() => {
      database.prepare("DELETE FROM ingestion_entry_results WHERE ingestion_run_id = ?").run(runId);
      const statement = database.prepare(
        `INSERT INTO ingestion_entry_results(ingestion_run_id, logical_path, blob_sha256, parser_id,
         parser_version, state, normalized_content_hash, block_count, chunk_count, error_code,
         detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      );
      for (const entry of entries) {
        statement.run(
          runId,
          entry.logical_path,
          entry.blob_sha256,
          entry.parser_id,
          entry.document?.parser_version ?? null,
          entry.state,
          entry.document?.normalized_content_hash ?? null,
          entry.document?.blocks.length ?? 0,
          chunkCounts.get(entry.logical_path) ?? 0,
          JSON.stringify(entry.skip_reason ? { skip_reason: entry.skip_reason } : {}),
          now,
        );
      }
      database
        .prepare(
          `UPDATE ingestion_runs SET files_total = ?, files_parsed = ?, files_skipped = ?,
           checkpoint_json = ?, updated_at = ? WHERE ingestion_run_id = ?`,
        )
        .run(
          entries.length,
          entries.filter((entry) => entry.state === "parsed").length,
          entries.filter((entry) => entry.state === "skipped").length,
          JSON.stringify({ entries_recorded: entries.length }),
          now,
          runId,
        );
    })();
  } finally {
    database.close();
  }
}

export async function completeIngestionRun(
  root: string,
  runId: string,
  metrics: {
    documents: number;
    chunksPublished: number;
    chunksReused: number;
    chunksTombstoned: number;
  },
): Promise<void> {
  const database = await writableIngestionDatabase(root);
  const now = new Date().toISOString();
  try {
    database.transaction(() => {
      const result = database
        .prepare(
          `UPDATE ingestion_runs SET state = 'ready', documents_published = ?, chunks_published = ?,
           chunks_reused = ?, chunks_tombstoned = ?, checkpoint_json = '{"published":true}',
           finished_at = ?, updated_at = ? WHERE ingestion_run_id = ? AND state = 'publishing'`,
        )
        .run(
          metrics.documents,
          metrics.chunksPublished,
          metrics.chunksReused,
          metrics.chunksTombstoned,
          now,
          now,
          runId,
        );
      if (result.changes !== 1)
        throw failure("ingestion_state_invalid", "IngestionRun was not publishing", "state");
      database
        .prepare(
          `UPDATE sources SET ingestion_status = 'ready', current_ingestion_run_id = ?
           WHERE source_id = (SELECT source_id FROM ingestion_runs WHERE ingestion_run_id = ?)`,
        )
        .run(runId, runId);
    })();
  } finally {
    database.close();
  }
}

export async function failIngestionRun(
  root: string,
  runId: string,
  code: string,
  message: string,
): Promise<void> {
  const database = await writableIngestionDatabase(root);
  const now = new Date().toISOString();
  try {
    database.transaction(() => {
      const changed = database
        .prepare(
          `UPDATE ingestion_runs SET state = 'failed', error_code = ?, error_message = ?,
           finished_at = ?, updated_at = ? WHERE ingestion_run_id = ? AND state != 'ready'`,
        )
        .run(code, message, now, now, runId).changes;
      if (changed === 1) {
        database
          .prepare(
            `UPDATE sources SET ingestion_status = 'failed', current_ingestion_run_id = ?
             WHERE source_id = (SELECT source_id FROM ingestion_runs WHERE ingestion_run_id = ?)`,
          )
          .run(runId, runId);
      }
    })();
  } finally {
    database.close();
  }
}

export async function recordFailedEntry(
  root: string,
  runId: string,
  input: { logicalPath: string; blobSha256: string; code: string },
): Promise<void> {
  const database = await writableIngestionDatabase(root);
  try {
    database
      .prepare(
        `INSERT INTO ingestion_entry_results(ingestion_run_id, logical_path, blob_sha256, state,
         error_code, detail_json, created_at) VALUES (?, ?, ?, 'failed', ?, '{}', ?)
         ON CONFLICT(ingestion_run_id, logical_path) DO UPDATE SET state = 'failed', error_code = excluded.error_code`,
      )
      .run(runId, input.logicalPath, input.blobSha256, input.code, new Date().toISOString());
  } finally {
    database.close();
  }
}

export async function getIngestionRun(root: string, runId: string): Promise<IngestionRunRow> {
  const database = await readableIngestionDatabase(root);
  try {
    const run = database
      .query<IngestionRunRow, [string]>("SELECT * FROM ingestion_runs WHERE ingestion_run_id = ?")
      .get(runId);
    if (!run) throw failure("ingestion_not_found", `Unknown IngestionRun: ${runId}`, "not_found");
    return run;
  } finally {
    database.close();
  }
}

export async function recordIngestionOperation(
  root: string,
  input: {
    operationId: string;
    requestId: string;
    runId: string;
    kind: string;
    result: Record<string, unknown>;
  },
): Promise<void> {
  const database = await writableIngestionDatabase(root);
  const now = new Date().toISOString();
  try {
    database
      .prepare(
        `INSERT INTO operations(operation_id, request_id, kind, status, target_id, input_hash,
         result_json, created_at, completed_at) VALUES (?, ?, ?, 'succeeded', ?, ?, ?, ?, ?)`,
      )
      .run(
        input.operationId,
        input.requestId,
        input.kind,
        input.runId,
        sha256Text(input.runId),
        JSON.stringify(input.result),
        now,
        now,
      );
  } finally {
    database.close();
  }
}
