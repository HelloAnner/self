import type { SourceKind, SourceMode, SourceRow, SourceSpec } from "../../domains/source/index.ts";

export type RawSourceRow = Omit<SourceRow, "kind" | "mode" | "spec"> & {
  kind: string;
  mode: string;
  spec_json: string;
};

export function mapSourceRow(row: RawSourceRow): SourceRow {
  return {
    source_id: row.source_id,
    identity_key: row.identity_key,
    kind: row.kind as SourceKind,
    mode: row.mode as SourceMode,
    name: row.name,
    state: row.state,
    archive_status: row.archive_status,
    spec: JSON.parse(row.spec_json) as SourceSpec,
    current_snapshot_id: row.current_snapshot_id,
    ingestion_status: row.ingestion_status,
    current_ingestion_run_id: row.current_ingestion_run_id,
    last_error_code: row.last_error_code,
    last_error_message: row.last_error_message,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
  };
}
