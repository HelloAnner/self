import { resolve } from "node:path";
import { openSqlite } from "../../src/infrastructure/db/connection.ts";
import { locateWorkspaceAssets } from "../../src/infrastructure/runtime/assets.ts";
import { DROP_SCHEMA6_SQL } from "./drop-schema6.ts";

const root = resolve(process.argv[2] ?? "");
if (!root) throw new Error("Usage: downgrade-to-schema5-fixture.ts <root>");
const assets = await locateWorkspaceAssets(root);
const database = openSqlite(resolve(root, "data/self.sqlite3"), assets);
try {
  database.exec(`
    ${DROP_SCHEMA6_SQL}
    DELETE FROM schema_migrations WHERE version >= 6;
    UPDATE workspace SET database_schema_version = 5, version = version + 1;
    PRAGMA user_version = 5;
    PRAGMA wal_checkpoint(TRUNCATE);
  `);
} finally {
  database.close();
}
