import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { canonicalAutomationJson } from "../../domains/automation/index.ts";
import { writableAutomationDatabase } from "../../infrastructure/automation/automation-db.ts";
import { completeAutomationOperation } from "../../infrastructure/automation/automation-repository.ts";
import { openWorkspaceDatabase } from "../../infrastructure/db/workspace-database.ts";
import { atomicWrite } from "../../infrastructure/filesystem/atomic-write.ts";
import { sha256File, sha256Text } from "../../infrastructure/filesystem/hash.ts";
import { acquireMaintenanceLock } from "../../infrastructure/operations/maintenance-lock.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import { VERSION } from "../../shared/version.ts";

export type BackupFile = {
  relative_path: string;
  kind: "database" | "config" | "content" | "artifact" | "template" | "runtime" | "model";
  sha256: string;
  size_bytes: number;
  mode: number;
};

export type BackupManifest = {
  format: "self-backup-v1";
  backup_id: string;
  workspace_id: string;
  created_at: string;
  database_schema_version: number;
  config_format_version: number;
  page_ir_version: number;
  cli_version: string;
  includes_models: boolean;
  file_count: number;
  total_bytes: number;
  files: BackupFile[];
};

export type BackupView = Record<string, unknown> & {
  backup_id: string;
  state: string;
  manifest_relative_path: string;
  manifest_hash: string | null;
  database_schema_version: number;
  file_count: number;
  total_bytes: number;
  includes_models: boolean;
  files: Record<string, unknown>[];
};

export async function createWorkspaceBackup(
  root: string,
  jobId: string | null,
  options: { includeModels?: boolean } = {},
): Promise<Record<string, unknown>> {
  const lock = await acquireMaintenanceLock(root, "backup.create");
  const createdAt = new Date().toISOString();
  let database = await writableAutomationDatabase(root);
  let backupId: string;
  let requestId = `backup:${createdAt}`;
  try {
    const existing = jobId
      ? database
          .query<{ backup_id: string }, [string]>(
            "SELECT backup_id FROM operation_backups WHERE job_id = ?",
          )
          .get(jobId)
      : null;
    backupId = existing?.backup_id ?? createResourceId("backup");
    if (jobId) {
      const job = database
        .query<{ request_id: string }, [string]>(
          "SELECT request_id FROM automation_jobs WHERE job_id = ?",
        )
        .get(jobId);
      if (job) requestId = job.request_id;
    }
    if (!existing)
      database
        .prepare(
          `INSERT INTO operation_backups(backup_id, job_id, state, manifest_relative_path,
           database_schema_version, includes_models, created_at)
           VALUES (?, ?, 'creating', ?, ?, ?, ?)`,
        )
        .run(
          backupId,
          jobId,
          `backups/${backupId.replace(":", "_")}/manifest.json`,
          VERSION.databaseSchema,
          options.includeModels ? 1 : 0,
          createdAt,
        );
  } finally {
    database.close();
  }
  const finalDirectory = join(root, "backups", backupId.replace(":", "_"));
  const staging = join(root, "runtime/tmp", `backup_${backupId.replace(":", "_")}`);
  try {
    await rm(staging, { recursive: true, force: true });
    await mkdir(join(staging, "data"), { recursive: true });
    const compatibility = await openWorkspaceDatabase(root, "read_only");
    let workspaceId: string;
    try {
      if (!compatibility.compatible)
        throw failure(
          "workspace_migration_required",
          "Backup requires the current schema",
          "state",
        );
      workspaceId = String(
        compatibility.database
          .query<{ workspace_id: string }, []>("SELECT workspace_id FROM workspace")
          .get()?.workspace_id ?? "",
      );
      await Bun.write(join(staging, "data/self.sqlite3"), compatibility.database.serialize());
    } finally {
      compatibility.database.close();
    }
    const sourceFiles = await collectWorkspaceFiles(root, options.includeModels === true);
    for (const source of sourceFiles) {
      const target = join(staging, source.relativePath);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source.absolutePath, target);
    }
    const files = await describeBackupFiles(staging);
    const manifest: BackupManifest = {
      format: "self-backup-v1",
      backup_id: backupId,
      workspace_id: workspaceId,
      created_at: createdAt,
      database_schema_version: VERSION.databaseSchema,
      config_format_version: VERSION.configFormat,
      page_ir_version: VERSION.pageIr,
      cli_version: VERSION.cli,
      includes_models: options.includeModels === true,
      file_count: files.length,
      total_bytes: files.reduce((sum, file) => sum + file.size_bytes, 0),
      files,
    };
    await atomicWrite(join(staging, "manifest.json"), `${canonicalAutomationJson(manifest)}\n`);
    const manifestHash = await sha256File(join(staging, "manifest.json"));
    await mkdir(join(root, "backups"), { recursive: true });
    await rm(finalDirectory, { recursive: true, force: true });
    await rename(staging, finalDirectory);
    const databaseHash = files.find((file) => file.relative_path === "data/self.sqlite3")?.sha256;
    if (!databaseHash) throw new Error("Backup database descriptor missing");
    const operationId = createResourceId("operation");
    database = await writableAutomationDatabase(root);
    try {
      database.transaction(() => {
        database.prepare("DELETE FROM operation_backup_files WHERE backup_id = ?").run(backupId);
        const insert = database.prepare(
          `INSERT INTO operation_backup_files(backup_id, relative_path, file_kind, sha256,
           size_bytes, mode) VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const file of files)
          insert.run(
            backupId,
            file.relative_path,
            file.kind,
            file.sha256,
            file.size_bytes,
            file.mode,
          );
        database
          .prepare(
            `UPDATE operation_backups SET operation_id = ?, state = 'ready', manifest_hash = ?,
             database_hash = ?, file_count = ?, total_bytes = ?, completed_at = ? WHERE backup_id = ?`,
          )
          .run(
            operationId,
            manifestHash,
            databaseHash,
            manifest.file_count,
            manifest.total_bytes,
            new Date().toISOString(),
            backupId,
          );
        if (jobId)
          database
            .prepare("UPDATE automation_jobs SET operation_id = ? WHERE job_id = ?")
            .run(operationId, jobId);
        completeAutomationOperation(database, {
          plan: null,
          operationId,
          requestId,
          kind: "operations.backup.create",
          targetId: backupId,
          inputHash: sha256Text(JSON.stringify({ include_models: options.includeModels === true })),
          result: {
            backup_id: backupId,
            manifest_hash: manifestHash,
            file_count: manifest.file_count,
            total_bytes: manifest.total_bytes,
          },
          changes: [
            {
              resourceId: backupId,
              resourceKind: "backup",
              changeKind: "created",
              before: {},
              after: { state: "ready", manifest_hash: manifestHash },
            },
          ],
          reversible: false,
          atomicity: "atomic",
          createdAt,
          completedAt: new Date().toISOString(),
        });
      })();
    } finally {
      database.close();
    }
    return {
      backup_id: backupId,
      state: "ready",
      manifest_relative_path: relative(root, join(finalDirectory, "manifest.json")),
      manifest_hash: manifestHash,
      database_hash: databaseHash,
      file_count: manifest.file_count,
      total_bytes: manifest.total_bytes,
      includes_models: manifest.includes_models,
    };
  } catch (cause) {
    database = await writableAutomationDatabase(root);
    try {
      database
        .prepare(
          "UPDATE operation_backups SET state = 'failed', completed_at = ? WHERE backup_id = ?",
        )
        .run(new Date().toISOString(), backupId);
    } finally {
      database.close();
    }
    await rm(staging, { recursive: true, force: true });
    throw cause;
  } finally {
    await lock.release();
  }
}

export async function listWorkspaceBackups(root: string, limit = 100) {
  const database = await writableAutomationDatabase(root);
  try {
    return database
      .query<Record<string, unknown>, [number]>(
        `SELECT backup_id, state, manifest_relative_path, manifest_hash, database_hash,
         database_schema_version, includes_models, file_count, total_bytes, created_at,
         completed_at, verified_at FROM operation_backups ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit);
  } finally {
    database.close();
  }
}

export async function showWorkspaceBackup(root: string, backupId: string): Promise<BackupView> {
  const database = await writableAutomationDatabase(root);
  try {
    const backup = database
      .query<Record<string, unknown>, [string]>(
        "SELECT * FROM operation_backups WHERE backup_id = ?",
      )
      .get(backupId);
    if (!backup) throw failure("backup_not_found", "Backup does not exist", "not_found");
    const files = database
      .query<Record<string, unknown>, [string]>(
        "SELECT * FROM operation_backup_files WHERE backup_id = ? ORDER BY relative_path",
      )
      .all(backupId);
    return {
      ...backup,
      backup_id: String(backup.backup_id),
      state: String(backup.state),
      manifest_relative_path: String(backup.manifest_relative_path),
      manifest_hash: backup.manifest_hash === null ? null : String(backup.manifest_hash),
      database_schema_version: Number(backup.database_schema_version),
      file_count: Number(backup.file_count),
      total_bytes: Number(backup.total_bytes),
      includes_models: backup.includes_models === 1,
      files,
    };
  } finally {
    database.close();
  }
}

export async function loadBackupManifest(root: string, backupId: string): Promise<BackupManifest> {
  const view = await showWorkspaceBackup(root, backupId);
  const relativePath = String(view.manifest_relative_path);
  const absolute = safeRootPath(root, relativePath);
  const parsed: unknown = JSON.parse(await Bun.file(absolute).text());
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("format" in parsed) ||
    parsed.format !== "self-backup-v1"
  )
    throw failure("backup_manifest_invalid", "Backup manifest is invalid", "state");
  return parsed as BackupManifest;
}

async function collectWorkspaceFiles(root: string, includeModels: boolean) {
  const output: Array<{ absolutePath: string; relativePath: string }> = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      const relativePath = relative(root, absolutePath).split(sep).join("/");
      if (excluded(relativePath, includeModels)) continue;
      if (entry.isSymbolicLink())
        throw failure(
          "backup_symlink_unsupported",
          "Workspace backup refuses symbolic links",
          "state",
          {
            details: { relative_path: relativePath },
          },
        );
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile()) output.push({ absolutePath, relativePath });
    }
  }
  await visit(root);
  return output.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function excluded(path: string, includeModels: boolean): boolean {
  const top = path.split("/")[0] ?? path;
  if (
    !["self.toml", "content", "artifacts", "templates", "runtime", "models", "data"].includes(top)
  )
    return true;
  if (
    path === "data/self.sqlite3" ||
    path === "data/self.sqlite3-wal" ||
    path === "data/self.sqlite3-shm"
  )
    return true;
  if (path === "backups" || path.startsWith("backups/")) return true;
  if (path.startsWith("runtime/jobs/") || path.startsWith("runtime/locks/")) return true;
  if (path.startsWith("runtime/tmp/") || path.startsWith("runtime/logs/")) return true;
  if (path.startsWith("runtime/migrations/backups/")) return true;
  if (path.startsWith("runtime/diagnostics/")) return true;
  if (!includeModels && (path === "models" || path.startsWith("models/"))) return true;
  return false;
}

async function describeBackupFiles(staging: string): Promise<BackupFile[]> {
  const output: BackupFile[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const metadata = await stat(absolute);
        const relativePath = relative(staging, absolute).split(sep).join("/");
        output.push({
          relative_path: relativePath,
          kind: backupFileKind(relativePath),
          sha256: await sha256File(absolute),
          size_bytes: metadata.size,
          mode: metadata.mode & 0o777,
        });
      }
    }
  }
  await visit(staging);
  return output.sort((left, right) => left.relative_path.localeCompare(right.relative_path));
}

function backupFileKind(path: string): BackupFile["kind"] {
  if (path === "data/self.sqlite3") return "database";
  if (path === "self.toml" || path.startsWith("runtime/config-history/")) return "config";
  if (path.startsWith("content/")) return "content";
  if (path.startsWith("artifacts/")) return "artifact";
  if (path.startsWith("templates/")) return "template";
  if (path.startsWith("models/")) return "model";
  return "runtime";
}

function safeRootPath(root: string, path: string): string {
  const base = resolve(root);
  const absolute = resolve(base, path);
  if (absolute !== base && !absolute.startsWith(`${base}${sep}`))
    throw failure("backup_path_invalid", "Backup path escapes Workspace Root", "state");
  return absolute;
}
