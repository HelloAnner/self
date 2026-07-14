import { resolve } from "node:path";
import { openSqlite } from "../../src/infrastructure/db/connection.ts";
import { locateWorkspaceAssets } from "../../src/infrastructure/runtime/assets.ts";
import { DROP_SCHEMA8_SQL } from "./drop-schema8.ts";

const root = resolve(process.argv[2] ?? "");
if (!root) throw new Error("Usage: downgrade-to-schema6-fixture.ts <root>");
const assets = await locateWorkspaceAssets(root);
const database = openSqlite(resolve(root, "data/self.sqlite3"), assets);
try {
  database.exec(`
    ${DROP_SCHEMA8_SQL}
    DROP TABLE answer_citations;
    DROP TABLE answer_statements;
    DROP TABLE answer_runs;
    DROP TABLE evidence_context_items;
    DROP TABLE evidence_contexts;
    DROP TABLE retrieval_candidates;
    DROP TABLE retrieval_runs;
    DELETE FROM schema_migrations WHERE version >= 7;
    UPDATE workspace SET database_schema_version = 6, version = version + 1;
    PRAGMA user_version = 6;
    PRAGMA wal_checkpoint(TRUNCATE);
  `);
} finally {
  database.close();
}
