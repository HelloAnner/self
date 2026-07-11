import { resolve } from "node:path";
import { openSqlite } from "../../src/infrastructure/db/connection.ts";
import { locateWorkspaceAssets } from "../../src/infrastructure/runtime/assets.ts";

const root = resolve(process.argv[2] ?? "");
if (!root) throw new Error("Usage: downgrade-to-schema2-fixture.ts <root>");
const assets = await locateWorkspaceAssets(root);
const database = openSqlite(resolve(root, "data/self.sqlite3"), assets);
try {
  database.exec(`
    ALTER TABLE sources DROP COLUMN current_ingestion_run_id;
    ALTER TABLE sources DROP COLUMN ingestion_status;
    DROP TABLE knowledge_notes;
    DROP TABLE knowledge_chunk_lineage;
    DROP TABLE knowledge_run_documents;
    DROP TABLE knowledge_revision_chunks;
    DROP TABLE knowledge_chunks;
    DROP TABLE knowledge_revisions;
    DROP TABLE knowledge_documents;
    DROP TABLE ingestion_entry_results;
    DROP TABLE ingestion_runs;
    DROP TABLE connection_daemon_leases;
    DROP TABLE connection_failures;
    DROP TABLE connection_write_receipts;
    DROP TABLE connection_event_hints;
    DROP TABLE connection_change_items;
    DROP TABLE connection_change_batches;
    DROP TABLE connection_observations;
    DROP TABLE connection_scan_runs;
    DROP TABLE connection_targets;
    DROP TABLE data_connections;
    DELETE FROM schema_migrations WHERE version >= 3;
    UPDATE workspace SET database_schema_version = 2, version = version + 1;
    PRAGMA user_version = 2;
    PRAGMA wal_checkpoint(TRUNCATE);
  `);
} finally {
  database.close();
}
