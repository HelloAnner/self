import type { Database } from "bun:sqlite";
import { automationInputHash } from "../../domains/automation/index.ts";
import { failure } from "../../shared/errors/self-error.ts";
import type { MutationDescription } from "./mutation-types.ts";

type Row = Record<string, unknown>;

export function describeSourcePurge(database: Database, sourceId: string): MutationDescription {
  const source = database
    .query<Row, [string]>(
      `SELECT source_id, identity_key, state, version, current_snapshot_id
       FROM sources WHERE source_id = ?`,
    )
    .get(sourceId);
  if (!source) throw failure("source_not_found", "Source does not exist", "not_found");
  if (source.state !== "deleted")
    throw failure(
      "source_purge_requires_delete",
      "Source must be soft-deleted before purge",
      "state",
    );
  const blockers = {
    connections: count(
      database,
      "SELECT COUNT(*) count FROM data_connections WHERE source_id = ?",
      sourceId,
    ),
    notes: count(
      database,
      "SELECT COUNT(*) count FROM knowledge_notes WHERE source_id = ?",
      sourceId,
    ),
    ingestion_runs: count(
      database,
      "SELECT COUNT(*) count FROM ingestion_runs WHERE source_id = ?",
      sourceId,
    ),
    documents: count(
      database,
      "SELECT COUNT(*) count FROM knowledge_documents WHERE source_id = ?",
      sourceId,
    ),
    evidence_contexts: count(
      database,
      "SELECT COUNT(DISTINCT context_id) count FROM evidence_context_items WHERE source_id = ?",
      sourceId,
    ),
    topic_citations: count(
      database,
      "SELECT COUNT(*) count FROM topic_report_citations WHERE source_id = ?",
      sourceId,
    ),
    graph_nodes: count(
      database,
      "SELECT COUNT(*) count FROM graph_nodes WHERE source_id = ?",
      sourceId,
    ),
  };
  const blockerCount = Object.values(blockers).reduce((total, value) => total + value, 0);
  const manifests = database
    .query<{ manifest_relative_path: string }, [string]>(
      "SELECT manifest_relative_path FROM source_snapshots WHERE source_id = ? ORDER BY sequence",
    )
    .all(sourceId)
    .map((row) => row.manifest_relative_path);
  const blobs = database
    .query<{ sha256: string; relative_path: string }, [string, string]>(
      `SELECT DISTINCT b.sha256, b.relative_path FROM source_snapshot_entries e
       JOIN source_snapshots s ON s.snapshot_id = e.snapshot_id
       JOIN source_blobs b ON b.sha256 = e.blob_sha256
       WHERE s.source_id = ? AND NOT EXISTS (
         SELECT 1 FROM source_snapshot_entries other_e
         JOIN source_snapshots other_s ON other_s.snapshot_id = other_e.snapshot_id
         WHERE other_e.blob_sha256 = b.sha256 AND other_s.source_id <> ?
       ) ORDER BY b.sha256`,
    )
    .all(sourceId, sourceId);
  const impact = {
    can_apply: blockerCount === 0,
    blockers,
    snapshots: count(
      database,
      "SELECT COUNT(*) count FROM source_snapshots WHERE source_id = ?",
      sourceId,
    ),
    manifests,
    blobs: blobs.map((row) => ({ sha256: row.sha256, relative_path: row.relative_path })),
    files: [...manifests, ...blobs.map((row) => row.relative_path)],
    reversible: false,
  };
  const digest = automationInputHash({
    source_id: sourceId,
    source_version: source.version,
    current_snapshot_id: source.current_snapshot_id,
    impact,
  });
  return {
    preconditions: {
      source_version: source.version,
      source_state: source.state,
      current_snapshot_id: source.current_snapshot_id,
      impact_hash: digest,
    },
    impact: { ...impact, impact_hash: digest },
    changes: [],
    inverse: null,
    reversible: false,
    targets: [
      {
        resourceId: sourceId,
        resourceKind: "source",
        role: "primary",
        expectedVersion: Number(source.version),
        expectedState: "deleted",
      },
    ],
  };
}

function count(database: Database, sql: string, id: string): number {
  return database.query<{ count: number }, [string]>(sql).get(id)?.count ?? 0;
}
