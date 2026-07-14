import { copyFile, lstat, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { AutomationPlanManifest } from "../../domains/automation/index.ts";
import { automationInputHash } from "../../domains/automation/index.ts";
import { writableAutomationDatabase } from "../../infrastructure/automation/automation-db.ts";
import {
  automationPlan,
  completeAutomationOperation,
  insertAutomationPlan,
} from "../../infrastructure/automation/automation-repository.ts";
import { openSqlite } from "../../infrastructure/db/connection.ts";
import { atomicWrite } from "../../infrastructure/filesystem/atomic-write.ts";
import { sha256File } from "../../infrastructure/filesystem/hash.ts";
import { acquireMaintenanceLock } from "../../infrastructure/operations/maintenance-lock.ts";
import { locateWorkspaceAssets } from "../../infrastructure/runtime/assets.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import { planRelativePath } from "../automation/plan-workflows.ts";
import { type BackupManifest, loadBackupManifest, showWorkspaceBackup } from "./backup.ts";
import { verifyWorkspaceDeep } from "./verify.ts";

export async function verifyWorkspaceBackup(root: string, backupId: string) {
  const view = await showWorkspaceBackup(root, backupId);
  if (view.state !== "ready")
    throw failure("backup_state_invalid", "Only ready Backups can be verified", "state");
  const manifest = await loadBackupManifest(root, backupId);
  const base = join(root, "backups", backupId.replace(":", "_"));
  const manifestHash = await sha256File(join(base, "manifest.json"));
  const issues: Array<Record<string, unknown>> = [];
  if (manifestHash !== view.manifest_hash) issues.push({ code: "backup_manifest_hash_mismatch" });
  if (manifest.file_count !== manifest.files.length)
    issues.push({ code: "backup_file_count_mismatch" });
  for (const file of manifest.files) {
    try {
      const hash = await sha256File(safeChild(base, file.relative_path));
      if (hash !== file.sha256)
        issues.push({ code: "backup_file_hash_mismatch", relative_path: file.relative_path });
    } catch {
      issues.push({ code: "backup_file_missing", relative_path: file.relative_path });
    }
  }
  const databasePath = join(base, "data/self.sqlite3");
  try {
    const assets = await locateWorkspaceAssets(root);
    const database = openSqlite(databasePath, assets, { readonly: true });
    try {
      const integrity = database
        .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
        .get();
      if (integrity?.integrity_check !== "ok")
        issues.push({ code: "backup_database_integrity_failed" });
      const schema = database
        .query<{ user_version: number }, []>("PRAGMA user_version")
        .get()?.user_version;
      if (schema !== manifest.database_schema_version)
        issues.push({
          code: "backup_database_schema_mismatch",
          expected: manifest.database_schema_version,
          actual: schema,
        });
    } finally {
      database.close();
    }
  } catch {
    issues.push({ code: "backup_database_unreadable" });
  }
  const database = await writableAutomationDatabase(root);
  try {
    if (issues.length === 0)
      database
        .prepare("UPDATE operation_backups SET verified_at = ? WHERE backup_id = ?")
        .run(new Date().toISOString(), backupId);
  } finally {
    database.close();
  }
  return {
    backup_id: backupId,
    status: issues.length === 0 ? "pass" : "fail",
    manifest_hash: manifestHash,
    files_checked: manifest.files.length,
    issue_count: issues.length,
    issues,
  };
}

export async function createBackupRestorePlan(
  root: string,
  backupId: string,
  targetInput: string,
  requestId: string,
) {
  const target = resolve(targetInput);
  assertSeparateRoots(root, target);
  if (await exists(target))
    throw failure("restore_target_exists", "Restore target must not exist", "conflict");
  const verified = await verifyWorkspaceBackup(root, backupId);
  if (verified.status !== "pass")
    throw failure(
      "backup_verification_failed",
      "Backup must pass verification before restore",
      "state",
      {
        details: { issue_count: verified.issue_count },
      },
    );
  const backup = await showWorkspaceBackup(root, backupId);
  const now = new Date();
  const input = {
    backup_id: backupId,
    target_root: target,
    manifest_hash: String(backup.manifest_hash),
  };
  const plan: AutomationPlanManifest = {
    plan_id: createResourceId("plan"),
    kind: "operations.backup.restore",
    action: "restore",
    state: "ready",
    request_id: requestId,
    operation_id: createResourceId("operation"),
    resource_id: backupId,
    idempotency_key: null,
    input_hash: automationInputHash(input),
    input,
    preconditions: {
      source_root: resolve(root),
      target_absent: true,
      manifest_hash: backup.manifest_hash,
      database_schema_version: backup.database_schema_version,
    },
    impact: {
      creates_root: target,
      overwrites_existing_files: false,
      file_count: backup.file_count,
      total_bytes: backup.total_bytes,
    },
    changes: [{ kind: "workspace_restore", target_root: target, backup_id: backupId }],
    inverse: null,
    reversible: false,
    atomicity: "atomic",
    targets: [
      { resourceId: backupId, resourceKind: "backup", role: "primary", expectedState: "ready" },
    ],
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 15 * 60_000).toISOString(),
  };
  const relativePath = planRelativePath(plan.plan_id);
  await atomicWrite(join(root, relativePath), `${JSON.stringify(plan, null, 2)}\n`);
  const database = await writableAutomationDatabase(root);
  try {
    insertAutomationPlan(database, plan, relativePath);
  } finally {
    database.close();
  }
  return plan;
}

export async function applyBackupRestorePlan(root: string, planId: string) {
  const lock = await acquireMaintenanceLock(root, "backup.restore");
  let database = await writableAutomationDatabase(root);
  let plan: AutomationPlanManifest;
  try {
    plan = automationPlan(database, planId);
  } finally {
    database.close();
  }
  if (plan.kind !== "operations.backup.restore" || plan.action !== "restore")
    throw failure("plan_kind_unsupported", "Plan is not a Backup restore", "state");
  if (plan.state !== "ready" || Date.parse(plan.expires_at) < Date.now())
    throw failure("plan_expired", "Backup restore Plan is no longer applicable", "conflict");
  const backupId = String(plan.input.backup_id);
  const target = String(plan.input.target_root);
  const staging = `${target}.self-restore-${planId.replace(/[^a-zA-Z0-9_-]/gu, "-")}`;
  try {
    assertSeparateRoots(root, target);
    if (await exists(target))
      throw failure(
        "restore_target_exists",
        "Restore never overwrites an existing path",
        "conflict",
      );
    if (await exists(staging))
      throw failure("restore_staging_exists", "Restore staging path already exists", "conflict");
    const verified = await verifyWorkspaceBackup(root, backupId);
    const backup = await showWorkspaceBackup(root, backupId);
    if (verified.status !== "pass" || backup.manifest_hash !== plan.input.manifest_hash)
      throw failure("plan_conflict", "Backup changed after restore Plan creation", "conflict");
    const manifest = await loadBackupManifest(root, backupId);
    const source = join(root, "backups", backupId.replace(":", "_"));
    await mkdir(dirname(staging), { recursive: true });
    await mkdir(staging, { recursive: false });
    await copyManifestFiles(source, staging, manifest);
    await validateCopiedFiles(staging, manifest);
    await normalizeRestoredRuntime(staging);
    const deep = await verifyWorkspaceDeep(staging, null);
    if (deep.status !== "pass")
      throw failure(
        "restore_verification_failed",
        "Restored Workspace failed deep verification",
        "state",
        {
          details: { verification_id: deep.verification_id, issue_count: deep.issue_count },
        },
      );
    await atomicWrite(
      join(staging, "runtime/restores", `${planId.replace(":", "_")}.json`),
      `${JSON.stringify({ format: "self-restore-receipt-v1", plan_id: planId, backup_id: backupId, source_workspace_id: manifest.workspace_id, restored_at: new Date().toISOString() }, null, 2)}\n`,
    );
    await rename(staging, target);
    const completedAt = new Date().toISOString();
    database = await writableAutomationDatabase(root);
    try {
      database.transaction(() =>
        completeAutomationOperation(database, {
          plan,
          operationId: plan.operation_id,
          requestId: plan.request_id,
          kind: "operations.backup.restore",
          targetId: backupId,
          inputHash: plan.input_hash,
          result: {
            backup_id: backupId,
            target_root: target,
            verification_id: deep.verification_id,
          },
          changes: [
            {
              resourceId: backupId,
              resourceKind: "backup",
              changeKind: "restored",
              before: { target_exists: false },
              after: { target_exists: true, target_root: target },
            },
          ],
          reversible: false,
          atomicity: "atomic",
          createdAt: plan.created_at,
          completedAt,
        }),
      )();
    } finally {
      database.close();
    }
    return {
      operation_id: plan.operation_id,
      backup_id: backupId,
      target_root: target,
      status: "succeeded",
      verification_id: deep.verification_id,
    };
  } catch (cause) {
    await rm(staging, { recursive: true, force: true });
    throw cause;
  } finally {
    await lock.release();
  }
}

async function copyManifestFiles(source: string, target: string, manifest: BackupManifest) {
  for (const file of manifest.files) {
    const from = safeChild(source, file.relative_path);
    const to = safeChild(target, file.relative_path);
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
  }
}

async function validateCopiedFiles(target: string, manifest: BackupManifest) {
  for (const file of manifest.files) {
    const hash = await sha256File(safeChild(target, file.relative_path));
    if (hash !== file.sha256)
      throw failure(
        "restore_copy_mismatch",
        "Restored file failed checksum verification",
        "state",
        {
          details: { relative_path: file.relative_path },
        },
      );
  }
}

async function normalizeRestoredRuntime(root: string) {
  await rm(join(root, "runtime/locks"), { recursive: true, force: true });
  await mkdir(join(root, "runtime/locks"), { recursive: true });
  const assets = await locateWorkspaceAssets(root);
  const database = openSqlite(join(root, "data/self.sqlite3"), assets);
  try {
    const now = new Date().toISOString();
    database.transaction(() => {
      database.exec("DELETE FROM operation_maintenance_lease");
      database
        .prepare(
          `UPDATE automation_jobs SET state = 'waiting', lease_owner = NULL,
           lease_expires_at = NULL, worker_pid = NULL, updated_at = ? WHERE state = 'running'`,
        )
        .run(now);
    })();
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    database.close();
  }
}

function assertSeparateRoots(sourceInput: string, targetInput: string) {
  const source = resolve(sourceInput);
  const target = resolve(targetInput);
  const allowedTestRoot =
    process.env.SELF_ALLOW_NESTED_TEST_ROOT === "1" &&
    target.startsWith(`${resolve(source, "test-runs")}${sep}`);
  if (
    source === target ||
    (target.startsWith(`${source}${sep}`) && !allowedTestRoot) ||
    source.startsWith(`${target}${sep}`)
  )
    throw failure(
      "restore_target_invalid",
      "Restore target must be separate from the source Root",
      "usage",
    );
}

function safeChild(baseInput: string, path: string): string {
  const base = resolve(baseInput);
  const absolute = resolve(base, path);
  if (absolute !== base && !absolute.startsWith(`${base}${sep}`))
    throw failure("backup_path_invalid", "Backup path escapes its directory", "state");
  return absolute;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
