import type { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { failure } from "../../../shared/errors/self-error.ts";
import { sha256Text } from "../../filesystem/hash.ts";

export type MigrationResult = { applied: number[]; schemaVersion: number };

export type MigrationVerificationIssue = {
  code: "migration_missing" | "migration_checksum_mismatch";
  version: number;
  name?: string;
};

export async function migrateDatabase(database: Database): Promise<MigrationResult> {
  const directory = await locateMigrationDirectory();
  const names = (await readdir(directory)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  const applied = readAppliedMigrations(database);
  const newlyApplied: number[] = [];

  for (const name of names) {
    const version = Number.parseInt(name.split("_")[0] ?? "", 10);
    const sql = await Bun.file(join(directory, name)).text();
    const checksum = sha256Text(sql);
    const previousChecksum = applied.get(version);
    if (previousChecksum) {
      if (previousChecksum !== checksum) {
        throw failure(
          "migration_checksum_mismatch",
          `Applied migration ${version} no longer matches ${name}`,
          "state",
        );
      }
      continue;
    }
    database.transaction(() => {
      database.exec(sql);
      database
        .prepare(
          "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        )
        .run(version, name, checksum, new Date().toISOString());
    })();
    newlyApplied.push(version);
  }

  const schemaVersion = readSchemaVersion(database);
  return { applied: newlyApplied, schemaVersion };
}

export function readSchemaVersion(database: Database): number {
  const row = database.query<{ user_version: number }, []>("PRAGMA user_version").get();
  return row?.user_version ?? 0;
}

export async function verifyMigrationHistory(
  database: Database,
): Promise<MigrationVerificationIssue[]> {
  const directory = await locateMigrationDirectory();
  const files = (await readdir(directory)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  const reviewed = new Map<number, { name: string; checksum: string }>();
  for (const name of files) {
    const version = Number.parseInt(name.split("_")[0] ?? "", 10);
    reviewed.set(version, {
      name,
      checksum: sha256Text(await Bun.file(join(directory, name)).text()),
    });
  }
  const applied = database
    .query<{ version: number; name: string; checksum: string }, []>(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
    )
    .all();
  const issues: MigrationVerificationIssue[] = [];
  for (const row of applied) {
    const expected = reviewed.get(row.version);
    if (!expected) issues.push({ code: "migration_missing", version: row.version, name: row.name });
    else if (expected.checksum !== row.checksum)
      issues.push({ code: "migration_checksum_mismatch", version: row.version, name: row.name });
  }
  return issues;
}

async function locateMigrationDirectory(): Promise<string> {
  const packaged = join(dirname(process.execPath), "migrations");
  try {
    if ((await readdir(packaged)).length > 0) return packaged;
  } catch {
    // Development uses the reviewed repository migrations.
  }
  const development = resolve("drizzle");
  try {
    if ((await readdir(development)).length > 0) return development;
  } catch {
    throw failure("migration_missing", "No reviewed migrations are available", "internal");
  }
  return development;
}

function readAppliedMigrations(database: Database): Map<number, string> {
  const table = database
    .query<{ count: number }, []>(
      "SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
    )
    .get();
  if (!table?.count) return new Map();
  const rows = database
    .query<{ version: number; checksum: string }, []>(
      "SELECT version, checksum FROM schema_migrations",
    )
    .all();
  return new Map(rows.map((row) => [row.version, row.checksum]));
}
