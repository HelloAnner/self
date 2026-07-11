import { rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { canonicalizePotentialPath } from "../../domains/workspace/root/discovery.ts";
import { openSqlite } from "../../infrastructure/db/connection.ts";
import { migrateDatabase, readSchemaVersion } from "../../infrastructure/db/migrations/runner.ts";
import { atomicWrite } from "../../infrastructure/filesystem/atomic-write.ts";
import { locateWorkspaceAssets } from "../../infrastructure/runtime/assets.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import { VERSION } from "../../shared/version.ts";
import { initPlanPath } from "../workspace/init-plan.ts";

const migrationPlanSchema = z.object({
  plan_id: z.string().startsWith("plan:plan_"),
  kind: z.literal("operations.database.migrate"),
  operation_id: z.string().startsWith("operation:op_"),
  request_id: z.string().startsWith("req_"),
  root: z.string(),
  from_version: z.number().int().nonnegative(),
  to_version: z.number().int().positive(),
  database_sha256: z.string().length(64),
  backup_relative_path: z.string(),
  created_at: z.string().datetime(),
  expires_at: z.string().datetime(),
});

type MigrationPlan = z.infer<typeof migrationPlanSchema>;

export async function createDatabaseMigrationPlan(rootInput: string, requestId: string) {
  const root = await canonicalizePotentialPath(rootInput);
  const snapshot = await serializeDatabase(root);
  if (snapshot.schemaVersion === VERSION.databaseSchema) {
    throw failure("migration_not_required", "Database schema is already current", "state");
  }
  if (snapshot.schemaVersion > VERSION.databaseSchema) {
    throw failure("workspace_format_too_new", "Database schema is newer than this CLI", "state");
  }
  const now = new Date();
  const planId = createResourceId("plan");
  const plan = migrationPlanSchema.parse({
    plan_id: planId,
    kind: "operations.database.migrate",
    operation_id: createResourceId("operation"),
    request_id: requestId,
    root,
    from_version: snapshot.schemaVersion,
    to_version: VERSION.databaseSchema,
    database_sha256: sha256(snapshot.bytes),
    backup_relative_path: `runtime/migrations/backups/schema-${snapshot.schemaVersion}-${planId.replace(":", "_")}.sqlite3`,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 15 * 60_000).toISOString(),
  });
  await atomicWrite(initPlanPath(root, planId), `${JSON.stringify(plan, null, 2)}\n`);
  return plan;
}

export async function applyDatabaseMigrationPlan(rootInput: string, planId: string) {
  const root = await canonicalizePotentialPath(rootInput);
  const plan = await loadPlan(root, planId);
  const snapshot = await serializeDatabase(root);
  assertApplicable(plan, root, snapshot.schemaVersion, sha256(snapshot.bytes));
  const backupPath = join(root, plan.backup_relative_path);
  const temporary = join(root, "runtime/tmp", `${plan.plan_id.replace(":", "_")}.sqlite3`);
  await atomicWrite(backupPath, snapshot.bytes);
  await atomicWrite(temporary, snapshot.bytes);

  const assets = await locateWorkspaceAssets(root);
  const database = openSqlite(temporary, assets);
  try {
    const result = await migrateDatabase(database);
    if (result.schemaVersion !== plan.to_version) throw new Error("Migration target mismatch");
    const integrity = database
      .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
      .get();
    if (integrity?.integrity_check !== "ok")
      throw new Error("Migrated database failed integrity check");
    database
      .prepare(
        `INSERT INTO operations(operation_id, request_id, kind, status, target_id, input_hash, result_json, created_at, completed_at)
         VALUES (?, ?, 'database.migrate', 'succeeded', ?, ?, ?, ?, ?)`,
      )
      .run(
        plan.operation_id,
        plan.request_id,
        plan.root,
        plan.database_sha256,
        JSON.stringify({ from_version: plan.from_version, to_version: plan.to_version }),
        new Date().toISOString(),
        new Date().toISOString(),
      );
    database.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;");
  } finally {
    database.close();
  }

  const migrated = new Uint8Array(await Bun.file(temporary).arrayBuffer());
  const databasePath = join(root, "data/self.sqlite3");
  await rm(`${databasePath}-wal`, { force: true });
  await rm(`${databasePath}-shm`, { force: true });
  await atomicWrite(databasePath, migrated);
  await rm(temporary, { force: true });
  return {
    operation_id: plan.operation_id,
    from_version: plan.from_version,
    to_version: plan.to_version,
    backup_relative_path: plan.backup_relative_path,
    status: "succeeded" as const,
  };
}

async function serializeDatabase(root: string) {
  const assets = await locateWorkspaceAssets(root);
  const database = openSqlite(join(root, "data/self.sqlite3"), assets, { readonly: true });
  try {
    return { schemaVersion: readSchemaVersion(database), bytes: database.serialize() };
  } finally {
    database.close();
  }
}

async function loadPlan(root: string, planId: string): Promise<MigrationPlan> {
  const file = Bun.file(initPlanPath(root, planId));
  if (!(await file.exists()))
    throw failure("plan_not_found", "Migration Plan does not exist", "not_found");
  const parsed = migrationPlanSchema.safeParse(JSON.parse(await file.text()));
  if (!parsed.success) throw failure("plan_not_found", "Migration Plan is invalid", "not_found");
  return parsed.data;
}

function assertApplicable(plan: MigrationPlan, root: string, schemaVersion: number, hash: string) {
  if (plan.root !== root || Date.parse(plan.expires_at) < Date.now()) {
    throw failure("plan_expired", "Migration Plan is stale or belongs to another Root", "conflict");
  }
  if (schemaVersion !== plan.from_version || hash !== plan.database_sha256) {
    throw failure("plan_conflict", "Database changed after Migration Plan creation", "conflict");
  }
}

function sha256(content: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}
