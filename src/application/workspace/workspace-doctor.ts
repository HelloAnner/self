import { loadSelfConfig } from "../../domains/workspace/config/codec.ts";
import { openSqlite } from "../../infrastructure/db/connection.ts";
import { verifyMigrationHistory } from "../../infrastructure/db/migrations/runner.ts";
import { openWorkspaceDatabase } from "../../infrastructure/db/workspace-database.ts";
import { maintenanceLockStatus } from "../../infrastructure/operations/maintenance-lock.ts";
import { locateReleaseAssets, locateWorkspaceAssets } from "../../infrastructure/runtime/assets.ts";
import { VERSION } from "../../shared/version.ts";

export type DoctorCheck = {
  name: string;
  status: "pass" | "warning" | "blocking";
  version?: string;
  message: string;
};

export type DoctorResult = {
  scope: "system" | "workspace";
  status: "pass" | "warning" | "blocking";
  checks: DoctorCheck[];
};

export async function doctorSystem(): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [
    { name: "cli", status: "pass", version: VERSION.cli, message: "CLI build is available." },
    {
      name: "platform",
      status: "pass",
      version: `${process.platform}-${process.arch}`,
      message: "Platform is supported by this build.",
    },
  ];
  try {
    const assets = await locateReleaseAssets();
    const database = openSqlite(":memory:", assets, { create: true });
    try {
      database.exec("CREATE VIRTUAL TABLE doctor_fts USING fts5(body)");
      const versions = database
        .query<{ sqlite: string; vec: string }, []>(
          "SELECT sqlite_version() sqlite, vec_version() vec",
        )
        .get();
      checks.push(
        {
          name: "sqlite",
          status: "pass",
          version: versions?.sqlite ?? "unknown",
          message: "SQLite opened.",
        },
        { name: "fts5", status: "pass", version: "fts5", message: "FTS5 virtual table created." },
        {
          name: "sqlite-vec",
          status: "pass",
          version: versions?.vec ?? "unknown",
          message: "sqlite-vec loaded.",
        },
      );
    } finally {
      database.close();
    }
  } catch (cause) {
    checks.push({
      name: "sqlite-runtime",
      status: "blocking",
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
  return summarize("system", checks);
}

export async function doctorWorkspace(root: string): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  try {
    const config = await loadSelfConfig(root);
    checks.push({
      name: "config",
      status: "pass",
      version: String(config.format_version),
      message: "self.toml is valid.",
    });
    await locateWorkspaceAssets(root);
    checks.push({
      name: "runtime-assets",
      status: "pass",
      message: "Platform assets are present.",
    });
    const opened = await openWorkspaceDatabase(root, "read_only");
    try {
      if (!opened.compatible) {
        checks.push({
          name: "database-schema",
          status: "warning",
          version: String(opened.schemaVersion),
          message: "Database is newer; write operations are disabled.",
        });
      } else {
        const integrity = opened.database
          .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
          .get();
        checks.push({
          name: "database-integrity",
          status: integrity?.integrity_check === "ok" ? "pass" : "blocking",
          version: String(opened.schemaVersion),
          message: integrity?.integrity_check ?? "No integrity result.",
        });
        const foreignKeys = opened.database
          .query<Record<string, unknown>, []>("PRAGMA foreign_key_check")
          .all();
        checks.push({
          name: "database-foreign-keys",
          status: foreignKeys.length === 0 ? "pass" : "blocking",
          message:
            foreignKeys.length === 0
              ? "Foreign-key evidence chains are valid."
              : `${foreignKeys.length} foreign-key violations detected.`,
        });
        const migrationIssues = await verifyMigrationHistory(opened.database);
        checks.push({
          name: "migration-history",
          status: migrationIssues.length === 0 ? "pass" : "blocking",
          message:
            migrationIssues.length === 0
              ? "Applied migration checksums match reviewed migrations."
              : `${migrationIssues.length} migration history issues detected.`,
        });
        const waitingJobs = opened.database
          .query<{ count: number }, []>(
            "SELECT COUNT(*) count FROM automation_jobs WHERE state = 'waiting'",
          )
          .get()?.count;
        checks.push({
          name: "durable-jobs",
          status: waitingJobs ? "warning" : "pass",
          message: waitingJobs
            ? `${waitingJobs} interrupted Jobs are waiting for retry.`
            : "No interrupted Jobs are waiting.",
        });
      }
    } finally {
      opened.database.close();
    }
    const lock = await maintenanceLockStatus(root);
    checks.push({
      name: "maintenance-lock",
      status: lock.exists && !lock.stale ? "warning" : "pass",
      message: lock.exists
        ? lock.stale
          ? "A stale maintenance lock can be recovered safely."
          : `Maintenance is active for ${lock.purpose ?? "an operation"}.`
        : "No maintenance lock is active.",
    });
  } catch (cause) {
    checks.push({
      name: "workspace",
      status: "blocking",
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
  return summarize("workspace", checks);
}

function summarize(scope: DoctorResult["scope"], checks: DoctorCheck[]): DoctorResult {
  const status = checks.some((check) => check.status === "blocking")
    ? "blocking"
    : checks.some((check) => check.status === "warning")
      ? "warning"
      : "pass";
  return { scope, status, checks };
}
