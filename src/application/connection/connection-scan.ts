import { classifyChanges } from "../../domains/connection/index.ts";
import {
  completeScan,
  failScan,
  finishDryRun,
  getConnection,
  getConnectionTarget,
  listObservations,
  persistDetectedBatch,
  startScan,
} from "../../infrastructure/connection/connection-repository.ts";
import { buildInventory } from "../../infrastructure/connection/inventory.ts";
import { consumeManagedWriteReceipts } from "../../infrastructure/connection/managed-write-repository.ts";
import { verifyConnectionTarget } from "../../infrastructure/connection/target.ts";
import { recordSourceBatchReceipt } from "../../infrastructure/source/source-store.ts";
import { failure, SelfFailure } from "../../shared/errors/self-error.ts";
import { acceptSourceChangeBatch } from "../source/source-archive.ts";

export async function scanConnection(
  root: string,
  connectionId: string,
  options: {
    trigger: "initial" | "schedule" | "native_event" | "manual" | "recovery";
    fullHash?: boolean;
    dryRun?: boolean;
    afterCheckpoint?: (checkpoint: "after_batch_persist") => void | Promise<void>;
  },
  requestId: string,
) {
  const connection = await getConnection(root, connectionId);
  if (["deleted", "detached"].includes(connection.state)) {
    throw failure(
      "connection_state_invalid",
      "Connection cannot be scanned in its current state",
      "state",
    );
  }
  if (connection.state === "paused" && options.trigger !== "manual") {
    throw failure("connection_state_invalid", "Paused Connection is not scheduled", "state");
  }
  const target = await getConnectionTarget(root, connectionId);
  const scanId = await startScan(root, connectionId, options.trigger);
  try {
    await verifyConnectionTarget(target);
    const previous = await listObservations(root, connectionId);
    const inventory = await buildInventory({
      target,
      connectionKind: connection.kind,
      filters: connection.filter_policy,
      scanPolicy: connection.scan_policy,
      previous,
      fullHash: options.fullHash ?? false,
    });
    const initialClassification = classifyChanges(
      previous,
      inventory.entries,
      new Date().toISOString(),
      connection.scan_policy.delete_grace_period_ms,
    );
    const classification = {
      ...initialClassification,
      changes: await consumeManagedWriteReceipts(
        root,
        target.target_id,
        initialClassification.changes,
      ),
    };
    if (options.dryRun) {
      await finishDryRun(
        root,
        scanId,
        inventory.entries.length,
        inventory.files_hashed,
        inventory.ignored.length,
        classification.changes,
      );
      return scanResult(scanId, [], null, inventory, classification.changes, true);
    }
    const batches = [] as Array<{ batchId: string; reused: boolean }>;
    for (
      let offset = 0;
      offset < classification.changes.length;
      offset += connection.resource_policy.max_batch_size
    ) {
      const batch = await persistDetectedBatch(
        root,
        connectionId,
        scanId,
        classification.changes.slice(offset, offset + connection.resource_policy.max_batch_size),
      );
      if (batch) batches.push(batch);
    }
    if (batches.length > 0) await options.afterCheckpoint?.("after_batch_persist");
    const firstBatch = batches[0];
    const archived = firstBatch
      ? await acceptSourceChangeBatch(root, connection.source_id, firstBatch.batchId, requestId)
      : null;
    if (archived)
      for (const batch of batches.slice(1))
        await recordSourceBatchReceipt(
          root,
          batch.batchId,
          connection.source_id,
          archived.snapshot_id,
        );
    await completeScan(root, {
      connection,
      target,
      scanId,
      inventory: inventory.entries,
      previous,
      missingPending: classification.missing_pending,
      changes: classification.changes,
      batchIds: batches.map((batch) => batch.batchId),
      snapshotId: archived?.snapshot_id ?? null,
      filesHashed: inventory.files_hashed,
      filesIgnored: inventory.ignored.length,
      ingestionRunId: archived?.ingestion_run_id ?? null,
      publishedDocuments: archived?.documents ?? [],
    });
    return scanResult(
      scanId,
      batches.map((batch) => batch.batchId),
      archived?.snapshot_id ?? null,
      inventory,
      classification.changes,
      false,
    );
  } catch (cause) {
    const error = asConnectionFailure(cause);
    await failScan(root, connectionId, scanId, error.selfError.code, error.selfError.message);
    throw error;
  }
}

function scanResult(
  scanId: string,
  batchIds: string[],
  snapshotId: string | null,
  inventory: Awaited<ReturnType<typeof buildInventory>>,
  changes: ReturnType<typeof classifyChanges>["changes"],
  dryRun: boolean,
) {
  return {
    scan_run_id: scanId,
    change_batch_id: batchIds[0] ?? null,
    change_batch_ids: batchIds,
    snapshot_id: snapshotId,
    state: "succeeded" as const,
    dry_run: dryRun,
    files_seen: inventory.entries.length,
    files_hashed: inventory.files_hashed,
    hashes_reused: inventory.hashes_reused,
    files_ignored: inventory.ignored.length,
    created: changes.filter((item) => item.kind === "created").length,
    modified: changes.filter((item) => item.kind === "modified").length,
    deleted: changes.filter((item) => item.kind === "deleted").length,
    renamed: changes.filter((item) => item.kind === "renamed").length,
    restored: changes.filter((item) => item.kind === "restored").length,
    changes_total: changes.length,
    changes_truncated: changes.length > 100,
    changes: changes.slice(0, 100),
  };
}

function asConnectionFailure(cause: unknown): SelfFailure {
  if (cause instanceof SelfFailure) return cause;
  return failure("connection_scan_failed", "Connection Scan failed", "external", {
    retryable: true,
    details: { reason: cause instanceof Error ? cause.message : String(cause) },
  });
}
