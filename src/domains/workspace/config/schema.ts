import { z } from "zod";

const relativePath = z
  .string()
  .min(1)
  .refine((value) => {
    return !value.startsWith("/") && !value.includes("..") && !value.includes("\\");
  }, "must be a normalized Workspace-relative path");

export const selfConfigSchema = z
  .object({
    format_version: z.literal(1),
    workspace: z
      .object({
        id: z.string().startsWith("workspace:ws_"),
        name: z.string().min(1).max(120),
        created_at: z.string().datetime(),
      })
      .strict(),
    storage: z
      .object({
        database: relativePath,
        content_dir: relativePath,
        artifact_dir: relativePath,
        template_dir: relativePath,
        model_dir: relativePath,
        runtime_dir: relativePath,
        backup_dir: relativePath,
        extension_dir: relativePath,
      })
      .strict(),
    database: z
      .object({
        journal_mode: z.literal("wal"),
        synchronous: z.enum(["normal", "full"]),
        busy_timeout_ms: z.number().int().min(100).max(60_000),
      })
      .strict(),
    connections: z.object({ enabled: z.boolean(), reconcile_interval: z.string().min(1) }).strict(),
    ingestion: z
      .object({
        chunker: z.string().min(1),
        default_language: z.string().min(1),
        max_chunk_tokens: z.number().int().positive(),
        chunk_overlap_tokens: z.number().int().nonnegative(),
      })
      .strict(),
    models: z
      .object({
        offline: z.boolean(),
        providers: z
          .record(
            z.string().min(1),
            z
              .object({
                protocol: z.literal("openai-compatible"),
                base_url: z.url(),
                api_key_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
              })
              .strict(),
          )
          .default({}),
        embedding_defaults: z
          .object({
            dimensions: z.number().int().positive(),
            distance: z.literal("cosine"),
            normalize: z.literal("l2"),
            query_instruction: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
    retrieval: z
      .object({
        mode: z.enum(["text", "vector", "hybrid"]),
        result_limit: z.number().int().positive(),
      })
      .strict(),
    artifacts: z.object({ keep_builds: z.literal("all") }).strict(),
    jobs: z
      .object({ max_concurrency: z.number().int().positive(), single_db_writer: z.literal(true) })
      .strict(),
    logging: z.object({ level: z.enum(["debug", "info", "warn", "error"]) }).strict(),
    security: z
      .object({ telemetry: z.literal(false), allow_root_external_writes: z.literal(false) })
      .strict(),
  })
  .strict();

export type SelfConfig = z.infer<typeof selfConfigSchema>;
