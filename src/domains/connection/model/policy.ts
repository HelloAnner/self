import { z } from "zod";
import type { FilterPolicy, ResourcePolicy, ScanPolicy } from "./types.ts";

export const scanPolicySchema = z.object({
  reconcile_interval_ms: z.number().int().min(0).max(86_400_000),
  full_hash_interval_ms: z.number().int().positive().max(604_800_000),
  event_debounce_ms: z.number().int().min(0).max(60_000),
  write_settle_window_ms: z.number().int().min(0).max(60_000),
  delete_grace_period_ms: z.number().int().min(0).max(86_400_000),
  max_settle_retries: z.number().int().min(1).max(10),
});

export const filterPolicySchema = z.object({
  include_globs: z.array(z.string().min(1)),
  exclude_globs: z.array(z.string().min(1)),
  include_hidden: z.boolean(),
  sensitive_file_mode: z.enum(["deny", "confirm", "allow"]),
  max_file_bytes: z.number().int().positive(),
});

export const resourcePolicySchema = z.object({
  max_batch_size: z.number().int().min(1).max(10_000),
  max_hash_concurrency: z.number().int().min(1).max(32),
});

export function defaultScanPolicy(overrides: Partial<ScanPolicy> = {}): ScanPolicy {
  return scanPolicySchema.parse({
    reconcile_interval_ms: 300_000,
    full_hash_interval_ms: 86_400_000,
    event_debounce_ms: 750,
    write_settle_window_ms: 1_500,
    delete_grace_period_ms: 30_000,
    max_settle_retries: 3,
    ...overrides,
  });
}

export function defaultFilterPolicy(
  preset: "docs" | "obsidian" | "project" | "custom",
  overrides: Partial<FilterPolicy> = {},
): FilterPolicy {
  const include =
    preset === "obsidian" || preset === "custom"
      ? ["**/*", "*"]
      : ["**/*.md", "*.md", "**/*.mdx", "*.mdx", "**/*.txt", "*.txt", "**/README*", "README*"];
  return filterPolicySchema.parse({
    include_globs: include,
    exclude_globs: [
      ".git",
      ".git/**",
      "node_modules",
      "node_modules/**",
      "dist",
      "dist/**",
      "build",
      "build/**",
      ".test-runs",
      ".test-runs/**",
      "*.tmp",
      "*.swp",
      ".DS_Store",
    ],
    include_hidden: false,
    sensitive_file_mode: "deny",
    max_file_bytes: 100 * 1024 * 1024,
    ...overrides,
  });
}

export function defaultResourcePolicy(): ResourcePolicy {
  return resourcePolicySchema.parse({ max_batch_size: 500, max_hash_concurrency: 4 });
}

export function parseDuration(value: string): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(value.trim());
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2];
  return amount * (unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000);
}
