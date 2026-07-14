import { resolve } from "node:path";
import { openSqlite } from "../../src/infrastructure/db/connection.ts";
import { locateWorkspaceAssets } from "../../src/infrastructure/runtime/assets.ts";
import { DROP_SCHEMA6_SQL } from "./drop-schema6.ts";

const root = resolve(process.argv[2] ?? "");
if (!root) throw new Error("Usage: downgrade-to-schema4-fixture.ts <root>");
const assets = await locateWorkspaceAssets(root);
const database = openSqlite(resolve(root, "data/self.sqlite3"), assets);
try {
  database.exec(`
    ${DROP_SCHEMA6_SQL}
    DROP TABLE knowledge_fts;
    DROP TABLE knowledge_active_indexes;
    DROP TABLE knowledge_index_generations;
    DROP TABLE retrieval_query_cache;
    DROP TABLE vector_space_evaluations;
    DROP TABLE knowledge_active_vector_space;
    DROP TABLE knowledge_embeddings;
    DROP TABLE vector_build_runs;
    DROP TABLE model_sentinel_results;
    DROP TABLE model_invocations;
    DROP TABLE vector_spaces;
    DROP TABLE models;
    DROP TABLE model_providers;
    DELETE FROM schema_migrations WHERE version >= 5;
    UPDATE workspace SET database_schema_version = 4, version = version + 1;
    PRAGMA user_version = 4;
    PRAGMA wal_checkpoint(TRUNCATE);
  `);
} finally {
  database.close();
}
