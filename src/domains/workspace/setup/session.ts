import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { openWorkspaceDatabase } from "../../../infrastructure/db/workspace-database.ts";
import { atomicWrite } from "../../../infrastructure/filesystem/atomic-write.ts";
import { failure } from "../../../shared/errors/self-error.ts";

export const setupSessionSchema = z.object({
  session_id: z.string().startsWith("setup:stp_"),
  workspace_id: z.string().startsWith("workspace:ws_"),
  state: z.enum([
    "workspace_ready",
    "models_configured",
    "verifying",
    "completed",
    "cancelled",
    "failed",
    "waiting_for_user",
  ]),
  current_step: z.string(),
  profile: z.enum(["offline", "hosted"]),
  answers: z.record(z.string(), z.unknown()),
  created_resource_ids: z.array(z.string()),
  warnings: z.array(z.string()),
  started_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  completed_at: z.string().datetime().optional(),
});

export type SetupSession = z.infer<typeof setupSessionSchema>;

export async function saveSetupSession(root: string, session: SetupSession): Promise<void> {
  session.updated_at = new Date().toISOString();
  const path = sessionPath(root, session.session_id);
  await atomicWrite(path, `${JSON.stringify(session, null, 2)}\n`);
  const opened = await openWorkspaceDatabase(root, "read_write");
  if (opened.mode !== "read_write") {
    opened.database.close();
    throw failure("workspace_format_too_new", "Setup state cannot write to this database", "state");
  }
  try {
    opened.database
      .prepare(
        `INSERT INTO setup_sessions(
           setup_session_id, workspace_id, state, current_step, profile, answers_json,
           created_resource_ids_json, warnings_json, started_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(setup_session_id) DO UPDATE SET
           state=excluded.state, current_step=excluded.current_step, profile=excluded.profile,
           answers_json=excluded.answers_json, created_resource_ids_json=excluded.created_resource_ids_json,
           warnings_json=excluded.warnings_json, updated_at=excluded.updated_at,
           completed_at=excluded.completed_at`,
      )
      .run(
        session.session_id,
        session.workspace_id,
        session.state,
        session.current_step,
        session.profile,
        JSON.stringify(session.answers),
        JSON.stringify(session.created_resource_ids),
        JSON.stringify(session.warnings),
        session.started_at,
        session.updated_at,
        session.completed_at ?? null,
      );
  } finally {
    opened.database.close();
  }
}

export async function loadLatestSetupSession(root: string): Promise<SetupSession> {
  const directory = join(root, "runtime/setup");
  let names: string[];
  try {
    names = (await readdir(directory))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .reverse();
  } catch {
    throw sessionNotFound();
  }
  const name = names[0];
  if (!name) throw sessionNotFound();
  const parsed = setupSessionSchema.safeParse(
    JSON.parse(await Bun.file(join(directory, name)).text()),
  );
  if (!parsed.success)
    throw failure("setup_step_failed", "Latest Setup Session is invalid", "state");
  return parsed.data;
}

function sessionPath(root: string, id: string): string {
  return join(root, "runtime/setup", `${id.replace(":", "_")}.json`);
}

function sessionNotFound() {
  return failure(
    "setup_session_not_found",
    "No Setup Session exists in this Workspace",
    "not_found",
  );
}
