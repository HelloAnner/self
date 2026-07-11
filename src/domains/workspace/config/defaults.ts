import { basename } from "node:path";
import type { ResourceId } from "../../../shared/ids/registry.ts";
import type { SelfConfig } from "./schema.ts";

export function createDefaultConfig(
  root: string,
  workspaceId: ResourceId<"workspace">,
  createdAt: string,
  offline: boolean,
): SelfConfig {
  return {
    format_version: 1,
    workspace: { id: workspaceId, name: basename(root) || "Self", created_at: createdAt },
    storage: {
      database: "data/self.sqlite3",
      content_dir: "content",
      artifact_dir: "artifacts",
      template_dir: "templates",
      model_dir: "models",
      runtime_dir: "runtime",
      backup_dir: "backups",
      extension_dir: "runtime/extensions",
    },
    database: { journal_mode: "wal", synchronous: "normal", busy_timeout_ms: 5000 },
    connections: { enabled: true, reconcile_interval: "5m" },
    ingestion: {
      chunker: "semantic-v1",
      default_language: "auto",
      max_chunk_tokens: 800,
      chunk_overlap_tokens: 80,
    },
    models: {
      offline,
      providers: {},
      embedding_defaults: {
        dimensions: 1024,
        distance: "cosine",
        normalize: "l2",
        query_instruction: "personal-knowledge-retrieval-v1",
      },
    },
    retrieval: { mode: "hybrid", result_limit: 20 },
    artifacts: { keep_builds: "all" },
    jobs: { max_concurrency: 4, single_db_writer: true },
    logging: { level: "info" },
    security: { telemetry: false, allow_root_external_writes: false },
  };
}
