import { resolve } from "node:path";
import { openSqlite } from "../../src/infrastructure/db/connection.ts";
import { locateWorkspaceAssets } from "../../src/infrastructure/runtime/assets.ts";
import { DROP_SCHEMA11_SQL } from "./drop-schema11.ts";

const root = resolve(process.argv[2] ?? "");
if (!root) throw new Error("Usage: downgrade-to-schema10-fixture.ts <root>");
const assets = await locateWorkspaceAssets(root);
const database = openSqlite(resolve(root, "data/self.sqlite3"), assets);
try {
  database.exec(`
    ${DROP_SCHEMA11_SQL}
    DELETE FROM schema_migrations WHERE version >= 11;
    UPDATE workspace SET database_schema_version = 10, version = version + 1;
    PRAGMA user_version = 10;
    PRAGMA wal_checkpoint(TRUNCATE);
  `);
} finally {
  database.close();
}
