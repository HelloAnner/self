import { resolve } from "node:path";
import { failure } from "../../shared/errors/self-error.ts";
import { VERSION } from "../../shared/version.ts";
import { openSqlite } from "../db/connection.ts";
import { readSchemaVersion } from "../db/migrations/runner.ts";
import { locateWorkspaceAssets } from "../runtime/assets.ts";

export async function writableModelDatabase(root: string) {
  const assets = await locateWorkspaceAssets(root);
  const database = openSqlite(resolve(root, "data/self.sqlite3"), assets);
  if (readSchemaVersion(database) !== VERSION.databaseSchema) {
    database.close();
    throw failure("workspace_migration_required", "Database migration is required", "state");
  }
  return database;
}

export async function readonlyModelDatabase(root: string) {
  const assets = await locateWorkspaceAssets(root);
  const database = openSqlite(resolve(root, "data/self.sqlite3"), assets, { readonly: true });
  if (readSchemaVersion(database) !== VERSION.databaseSchema) {
    database.close();
    throw failure("workspace_migration_required", "Database migration is required", "state");
  }
  return database;
}
