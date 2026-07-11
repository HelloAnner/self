import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { VERSION } from "../../shared/version.ts";
import { locateWorkspaceAssets } from "../runtime/assets.ts";
import { openSqlite } from "./connection.ts";
import { readSchemaVersion } from "./migrations/runner.ts";

export type DatabaseCompatibility = {
  database: Database;
  schemaVersion: number;
  mode: "read_only" | "read_write";
  compatible: boolean;
};

export async function openWorkspaceDatabase(
  root: string,
  requested: "read_only" | "read_write",
): Promise<DatabaseCompatibility> {
  const assets = await locateWorkspaceAssets(root);
  const path = join(root, "data/self.sqlite3");
  const probe = openSqlite(path, assets, { readonly: true });
  const schemaVersion = readSchemaVersion(probe);
  if (requested === "read_only" || schemaVersion !== VERSION.databaseSchema) {
    return {
      database: probe,
      schemaVersion,
      mode: "read_only",
      compatible: schemaVersion === VERSION.databaseSchema,
    };
  }
  probe.close();
  return {
    database: openSqlite(path, assets),
    schemaVersion,
    mode: "read_write",
    compatible: true,
  };
}
