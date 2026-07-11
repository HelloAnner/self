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
      return scanResult(scanId, null, null, inventory, classification.changes, true);
    }
    if (classification.changes.length > connection.resource_policy.max_batch_size) {
      throw failure(
        "connection_batch_too_large",
        "Scan changes exceed the configured batch limit",
        "state",
        {
          details: {
            changes: classification.changes.length,
            limit: connection.resource_policy.max_batch_size,
          },
        },
      );
    }
    const batch = await persistDetectedBatch(root, connectionId, scanId, classification.changes);
    if (batch) await options.afterCheckpoint?.("after_batch_persist");
    const archived = batch
      ? await acceptSourceChangeBatch(root, connection.source_id, batch.batchId, requestId)
      : null;
    await completeScan(root, {
      connection,
      target,
      scanId,
      inventory: inventory.entries,
      previous,
      missingPending: classification.missing_pending,
      changes: classification.changes,
      batchId: batch?.batchId ?? null,
      snapshotId: archived?.snapshot_id ?? null,
      filesHashed: inventory.files_hashed,
      filesIgnored: inventory.ignored.length,
      ingestionRunId: archived?.ingestion_run_id ?? null,
      publishedDocuments: archived?.documents ?? [],
    });
    return scanResult(
      scanId,
      batch?.batchId ?? null,
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
  batchId: string | null,
  snapshotId: string | null,
  inventory: Awaited<ReturnType<typeof buildInventory>>,
  changes: ReturnType<typeof classifyChanges>["changes"],
  dryRun: boolean,
) {
  return {
    scan_run_id: scanId,
    change_batch_id: batchId,
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
    changes,
  };
}

function asConnectionFailure(cause: unknown): SelfFailure {
  if (cause instanceof SelfFailure) return cause;
  return failure("connection_scan_failed", "Connection Scan failed", "external", {
    retryable: true,
    details: { reason: cause instanceof Error ? cause.message : String(cause) },
  });
}
