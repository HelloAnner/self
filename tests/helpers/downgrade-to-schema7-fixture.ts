import { resolve } from "node:path";
import { openSqlite } from "../../src/infrastructure/db/connection.ts";
import { locateWorkspaceAssets } from "../../src/infrastructure/runtime/assets.ts";
import { DROP_SCHEMA8_SQL } from "./drop-schema8.ts";

const root = resolve(process.argv[2] ?? "");
if (!root) throw new Error("Usage: downgrade-to-schema7-fixture.ts <root>");
const assets = await locateWorkspaceAssets(root);
const database = openSqlite(resolve(root, "data/self.sqlite3"), assets);
try {
  database.exec(`
    ${DROP_SCHEMA8_SQL}
    DELETE FROM schema_migrations WHERE version >= 8;
    UPDATE workspace SET database_schema_version = 7, version = version + 1;
    PRAGMA user_version = 7;
    PRAGMA wal_checkpoint(TRUNCATE);
  `);
} finally {
  database.close();
}
