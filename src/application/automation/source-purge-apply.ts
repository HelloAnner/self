import type { Database } from "bun:sqlite";
import { lstat, mkdir, rename, unlink } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { AutomationPlanManifest, OperationChange } from "../../domains/automation/index.ts";
import { automationInputHash } from "../../domains/automation/index.ts";
import { completeAutomationOperation } from "../../infrastructure/automation/automation-repository.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { describeSourcePurge } from "./source-purge-plan.ts";

type StagedFile = { source: string; staged: string };

export async function applySourcePurge(
  root: string,
  database: Database,
  plan: AutomationPlanManifest,
) {
  const sourceId = String(plan.resource_id);
  const current = describeSourcePurge(database, sourceId);
  if (current.preconditions.impact_hash !== plan.preconditions.impact_hash) {
    throw failure(
      "source_purge_conflict",
      "Source references changed after Plan creation",
      "conflict",
    );
  }
  if (current.impact.can_apply !== true) {
    throw failure("source_purge_blocked", "Source still has retained references", "conflict", {
      details: { blockers: current.impact.blockers },
    });
  }
  const files = asStringArray(current.impact.files);
  const staged = await stageFiles(root, plan.operation_id, files);
  const now = new Date().toISOString();
  try {
    const result = database.transaction(() => {
      const source = database
        .query<{ identity_key: string; version: number }, [string]>(
          "SELECT identity_key, version FROM sources WHERE source_id = ?",
        )
        .get(sourceId);
      if (!source) throw failure("source_not_found", "Source does not exist", "not_found");
      const blobs = database
        .query<{ sha256: string }, [string, string]>(
          `SELECT DISTINCT e.blob_sha256 AS sha256 FROM source_snapshot_entries e
           JOIN source_snapshots s ON s.snapshot_id = e.snapshot_id
           WHERE s.source_id = ? AND NOT EXISTS (
             SELECT 1 FROM source_snapshot_entries oe JOIN source_snapshots os
             ON os.snapshot_id = oe.snapshot_id
             WHERE oe.blob_sha256 = e.blob_sha256 AND os.source_id <> ?
           )`,
        )
        .all(sourceId, sourceId)
        .map((row) => row.sha256);
      database
        .prepare(
          `DELETE FROM source_snapshot_changes WHERE snapshot_id IN
           (SELECT snapshot_id FROM source_snapshots WHERE source_id = ?)`,
        )
        .run(sourceId);
      database
        .prepare(
          `DELETE FROM source_snapshot_entries WHERE snapshot_id IN
           (SELECT snapshot_id FROM source_snapshots WHERE source_id = ?)`,
        )
        .run(sourceId);
      database.prepare("DELETE FROM source_batch_receipts WHERE source_id = ?").run(sourceId);
      database.prepare("DELETE FROM source_snapshots WHERE source_id = ?").run(sourceId);
      const deleteBlob = database.prepare("DELETE FROM source_blobs WHERE sha256 = ?");
      for (const sha256 of blobs) deleteBlob.run(sha256);
      const deleted = database.prepare("DELETE FROM sources WHERE source_id = ?").run(sourceId);
      if (deleted.changes !== 1) {
        throw failure("source_purge_conflict", "Source disappeared during purge", "conflict");
      }
      const change: OperationChange = {
        resourceId: sourceId,
        resourceKind: "source",
        changeKind: "purged",
        versionBefore: source.version,
        versionAfter: null,
        before: { state: "deleted", version: source.version },
        after: { state: "purged" },
        inverse: null,
      };
      const output = {
        operation_id: plan.operation_id,
        plan_id: plan.plan_id,
        action: plan.action,
        source_id: sourceId,
        state: "purged",
        reversible: false,
        atomicity: "atomic" as const,
        removed_files: files.length,
        removed_blobs: blobs.length,
      };
      completeAutomationOperation(database, {
        plan,
        operationId: plan.operation_id,
        requestId: plan.request_id,
        kind: "source.purge",
        targetId: sourceId,
        inputHash: plan.input_hash,
        idempotencyKey: plan.idempotency_key,
        result: output,
        changes: [change],
        reversible: false,
        atomicity: "atomic",
        createdAt: plan.created_at,
        completedAt: now,
      });
      database
        .prepare(
          `INSERT INTO source_purge_receipts(source_id, operation_id, source_identity_hash,
           impact_json, purged_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          sourceId,
          plan.operation_id,
          automationInputHash(source.identity_key),
          JSON.stringify(current.impact),
          now,
        );
      return output;
    })();
    for (const file of staged) await unlink(file.staged);
    return result;
  } catch (cause) {
    await restoreFiles(staged);
    throw cause;
  }
}

async function stageFiles(
  root: string,
  operationId: string,
  files: string[],
): Promise<StagedFile[]> {
  const stageRoot = resolve(root, "runtime/tmp", operationId.replaceAll(":", "_"));
  const staged: StagedFile[] = [];
  try {
    for (const path of files) {
      const source = safeRootPath(root, path);
      const info = await lstat(source).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink()) {
        throw failure(
          "source_purge_conflict",
          "Archived file changed after Plan creation",
          "conflict",
          {
            details: { path },
          },
        );
      }
      const destination = resolve(stageRoot, path);
      if (!isInside(stageRoot, destination)) {
        throw failure(
          "source_purge_path_invalid",
          "Purge path escapes its staging directory",
          "state",
        );
      }
      await mkdir(dirname(destination), { recursive: true });
      await rename(source, destination);
      staged.push({ source, staged: destination });
    }
    return staged;
  } catch (cause) {
    await restoreFiles(staged);
    throw cause;
  }
}

async function restoreFiles(files: StagedFile[]) {
  for (const file of [...files].reverse()) {
    await mkdir(dirname(file.source), { recursive: true });
    await rename(file.staged, file.source).catch(() => undefined);
  }
}

function safeRootPath(root: string, path: string): string {
  const absolute = resolve(root, path);
  if (!isInside(root, absolute)) {
    throw failure("source_purge_path_invalid", "Purge path escapes Self Root", "state", {
      details: { path },
    });
  }
  return absolute;
}

function isInside(parent: string, child: string): boolean {
  const value = relative(resolve(parent), resolve(child));
  return value !== "" && !value.startsWith("..") && !value.startsWith("/");
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
