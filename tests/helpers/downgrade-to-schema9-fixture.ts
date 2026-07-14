import { resolve } from "node:path";
import { openSqlite } from "../../src/infrastructure/db/connection.ts";
import { locateWorkspaceAssets } from "../../src/infrastructure/runtime/assets.ts";
import { DROP_SCHEMA10_SQL } from "./drop-schema10.ts";

const root = resolve(process.argv[2] ?? "");
if (!root) throw new Error("Usage: downgrade-to-schema9-fixture.ts <root>");
const assets = await locateWorkspaceAssets(root);
const database = openSqlite(resolve(root, "data/self.sqlite3"), assets);
try {
  database.exec(`
    ${DROP_SCHEMA10_SQL}
    DELETE FROM schema_migrations WHERE version >= 10;
    UPDATE workspace SET database_schema_version = 9, version = version + 1;
    PRAGMA user_version = 9;
    PRAGMA wal_checkpoint(TRUNCATE);
  `);
} finally {
  database.close();
}
