import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWrite } from "../../../infrastructure/filesystem/atomic-write.ts";
import { failure } from "../../../shared/errors/self-error.ts";
import type { InitJournal } from "./types.ts";

const journalSchema = z.object({
  operation_id: z.string().startsWith("operation:op_"),
  request_id: z.string().startsWith("req_"),
  workspace_id: z.string().startsWith("workspace:ws_"),
  target_root: z.string(),
  root_identity: z.object({ device: z.number(), inode: z.number() }),
  created_root: z.boolean(),
  state: z.enum(["running", "failed", "completed", "rolled_back"]),
  current_step: z.enum([
    "prepared",
    "directories",
    "runtime_assets",
    "database",
    "verification",
    "config_publish",
  ]),
  completed_steps: z.array(
    z.enum(["directories", "runtime_assets", "database", "verification", "config_publish"]),
  ),
  created_paths: z.array(
    z.object({
      path: z.string(),
      kind: z.enum(["file", "directory"]),
      sha256: z.string().optional(),
    }),
  ),
  offline: z.boolean(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  error_code: z.string().optional(),
});

export function journalPath(root: string, operationId: string): string {
  return join(root, "runtime/init", `${operationId.replace(":", "_")}.json`);
}

export async function saveInitJournal(journal: InitJournal): Promise<void> {
  journal.updated_at = new Date().toISOString();
  await atomicWrite(
    journalPath(journal.target_root, journal.operation_id),
    `${JSON.stringify(journal, null, 2)}\n`,
  );
}

export async function loadLatestInitJournal(root: string): Promise<InitJournal> {
  const directory = join(root, "runtime/init");
  let names: string[];
  try {
    names = (await readdir(directory))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .reverse();
  } catch {
    throw missingJournal();
  }
  for (const name of names) {
    const parsed = journalSchema.safeParse(
      JSON.parse(await Bun.file(join(directory, name)).text()),
    );
    if (parsed.success && parsed.data.state !== "rolled_back") return parsed.data as InitJournal;
  }
  throw missingJournal();
}

function missingJournal() {
  return failure("init_incomplete", "No resumable Init Journal was found", "not_found", {
    suggestedActions: ["Run `self init <DIR>` to start initialization."],
  });
}
