import { stat } from "node:fs/promises";
import { join } from "node:path";
import { loadSelfConfig } from "../../domains/workspace/config/codec.ts";
import { openWorkspaceDatabase } from "../../infrastructure/db/workspace-database.ts";
import { VERSION } from "../../shared/version.ts";

export type WorkspaceStatus = {
  workspace_id: string;
  root: string;
  state: string;
  mode: "read_only" | "read_write";
  config_format_version: number;
  database_schema_version: number;
  database_size_bytes: number;
  capabilities: { name: string; status: string; version: string | null }[];
  warnings: string[];
};

export async function getWorkspaceStatus(root: string): Promise<WorkspaceStatus> {
  const config = await loadSelfConfig(root);
  const opened = await openWorkspaceDatabase(root, "read_only");
  try {
    const warnings = opened.compatible
      ? []
      : [
          opened.schemaVersion > VERSION.databaseSchema
            ? `Database schema ${opened.schemaVersion} is newer than supported ${VERSION.databaseSchema}.`
            : `Database schema ${opened.schemaVersion} requires migration to ${VERSION.databaseSchema}.`,
        ];
    const workspace = opened.compatible
      ? opened.database.query<{ state: string }, []>("SELECT state FROM workspace LIMIT 1").get()
      : undefined;
    const capabilities = opened.compatible
      ? opened.database
          .query<{ name: string; status: string; version: string | null }, []>(
            "SELECT capability name, status, version FROM workspace_capabilities ORDER BY capability",
          )
          .all()
      : [];
    const databaseStats = await stat(join(root, config.storage.database));
    const state = opened.compatible
      ? (workspace?.state ?? "damaged")
      : opened.schemaVersion > VERSION.databaseSchema
        ? "read_only"
        : "needs_migration";
    return {
      workspace_id: config.workspace.id,
      root,
      state,
      mode: state === "active" ? "read_write" : "read_only",
      config_format_version: config.format_version,
      database_schema_version: opened.schemaVersion,
      database_size_bytes: databaseStats.size,
      capabilities,
      warnings,
    };
  } finally {
    opened.database.close();
  }
}
