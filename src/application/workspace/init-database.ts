import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { stringifySelfConfig } from "../../domains/workspace/config/codec.ts";
import { createDefaultConfig } from "../../domains/workspace/config/defaults.ts";
import type { InitJournal } from "../../domains/workspace/init/types.ts";
import { openSqlite } from "../../infrastructure/db/connection.ts";
import { migrateDatabase } from "../../infrastructure/db/migrations/runner.ts";
import { atomicWrite } from "../../infrastructure/filesystem/atomic-write.ts";
import { sha256Text } from "../../infrastructure/filesystem/hash.ts";
import { installRuntimeAssets } from "../../infrastructure/runtime/assets.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { VERSION } from "../../shared/version.ts";
import { recordCreatedFile } from "./init-files.ts";

export async function createWorkspaceDatabase(journal: InitJournal): Promise<void> {
  const root = journal.target_root;
  const finalPath = join(root, "data/self.sqlite3");
  if (await Bun.file(finalPath).exists()) return verifyWorkspaceRow(finalPath, journal);

  const temporary = join(
    root,
    "runtime/tmp",
    `self-${journal.operation_id.replace(":", "_")}.sqlite3`,
  );
  await rm(temporary, { force: true });
  const assets = await installRuntimeAssets(root);
  const database = openSqlite(temporary, assets, { create: true });
  try {
    const migration = await migrateDatabase(database);
    const config = createDefaultConfig(
      root,
      journal.workspace_id,
      journal.created_at,
      journal.offline,
    );
    const configContent = stringifySelfConfig(config);
    const configSnapshot = `runtime/config-history/0001-${sha256Text(configContent).slice(0, 12)}.toml`;
    const configSnapshotPath = join(root, configSnapshot);
    await atomicWrite(configSnapshotPath, configContent);
    await recordCreatedFile(journal, configSnapshotPath);
    const versions = database
      .query<{ sqlite: string; vec: string }, []>(
        "SELECT sqlite_version() sqlite, vec_version() vec",
      )
      .get();
    insertWorkspace(
      database,
      journal,
      configContent,
      configSnapshot,
      migration.schemaVersion,
      versions,
    );
    const integrity = database
      .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
      .get();
    if (integrity?.integrity_check !== "ok") throw new Error("SQLite integrity check failed");
    database.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;");
  } finally {
    database.close();
  }
  await rename(temporary, finalPath);
  await recordCreatedFile(journal, finalPath);
}

export async function verifyWorkspaceRow(
  databasePath: string,
  journal: InitJournal,
): Promise<void> {
  const assets = await installRuntimeAssets(journal.target_root);
  const database = openSqlite(databasePath, assets, { readonly: true });
  try {
    const row = database
      .query<{ workspace_id: string; state: string }, []>(
        "SELECT workspace_id, state FROM workspace",
      )
      .get();
    if (row?.workspace_id !== journal.workspace_id || row.state !== "active") {
      throw failure("init_path_conflict", "Database belongs to another Workspace", "conflict");
    }
  } finally {
    database.close();
  }
}

function insertWorkspace(
  database: ReturnType<typeof openSqlite>,
  journal: InitJournal,
  configContent: string,
  configSnapshot: string,
  schemaVersion: number,
  versions: { sqlite: string; vec: string } | null,
): void {
  database.transaction(() => {
    database
      .prepare(
        `INSERT INTO workspace(workspace_id, state, format_version, database_schema_version, created_at, updated_at)
         VALUES (?, 'active', ?, ?, ?, ?)`,
      )
      .run(
        journal.workspace_id,
        VERSION.configFormat,
        schemaVersion,
        journal.created_at,
        journal.created_at,
      );
    database
      .prepare(
        `INSERT INTO operations(operation_id, request_id, kind, status, target_id, input_hash, result_json, created_at, completed_at)
         VALUES (?, ?, 'workspace.init', 'succeeded', ?, ?, '{}', ?, ?)`,
      )
      .run(
        journal.operation_id,
        journal.request_id,
        journal.workspace_id,
        sha256Text(configContent),
        journal.created_at,
        journal.created_at,
      );
    database
      .prepare(
        `INSERT INTO workspace_config_versions(workspace_id, version, content_hash, relative_path, created_at, operation_id)
         VALUES (?, 1, ?, ?, ?, ?)`,
      )
      .run(
        journal.workspace_id,
        sha256Text(configContent),
        configSnapshot,
        journal.created_at,
        journal.operation_id,
      );
    insertCapabilities(database, journal, versions);
  })();
}

function insertCapabilities(
  database: ReturnType<typeof openSqlite>,
  journal: InitJournal,
  versions: { sqlite: string; vec: string } | null,
): void {
  const statement = database.prepare(
    `INSERT INTO workspace_capabilities(workspace_id, capability, status, version, checked_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  statement.run(
    journal.workspace_id,
    "sqlite",
    "available",
    versions?.sqlite ?? null,
    journal.created_at,
  );
  statement.run(journal.workspace_id, "fts", "available", "fts5", journal.created_at);
  statement.run(
    journal.workspace_id,
    "vector-search",
    "available",
    versions?.vec ?? null,
    journal.created_at,
  );
  statement.run(journal.workspace_id, "models", "unconfigured", null, journal.created_at);
}
