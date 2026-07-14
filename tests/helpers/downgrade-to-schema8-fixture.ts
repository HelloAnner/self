import { resolve } from "node:path";
import { openSqlite } from "../../src/infrastructure/db/connection.ts";
import { locateWorkspaceAssets } from "../../src/infrastructure/runtime/assets.ts";
import { DROP_SCHEMA10_SQL } from "./drop-schema10.ts";

const root = resolve(process.argv[2] ?? "");
if (!root) throw new Error("Usage: downgrade-to-schema8-fixture.ts <root>");
const assets = await locateWorkspaceAssets(root);
const database = openSqlite(resolve(root, "data/self.sqlite3"), assets);
try {
  database.exec(`
    ${DROP_SCHEMA10_SQL}
    DROP TABLE artifact_exports;
    DROP TABLE artifact_build_files;
    DROP TABLE artifact_build_components;
    DROP TABLE artifact_build_dependencies;
    DROP TABLE artifact_builds;
    DROP TABLE artifacts;
    DROP TABLE artifact_themes;
    DROP TABLE artifact_templates;
    DELETE FROM schema_migrations WHERE version >= 9;
    UPDATE workspace SET database_schema_version = 8, version = version + 1;
    PRAGMA user_version = 8;
    PRAGMA wal_checkpoint(TRUNCATE);
  `);
} finally {
  database.close();
}
