import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RuntimeAssets } from "../runtime/assets.ts";

let configuredLibrary: string | undefined;
let configuredFingerprint: string | undefined;

export function openSqlite(
  databasePath: string,
  assets: RuntimeAssets,
  options: { readonly?: boolean; create?: boolean } = {},
): Database {
  configureCustomSqlite(assets.sqliteLibrary);
  const database = new Database(databasePath, {
    readonly: options.readonly ?? false,
    create: options.create ?? false,
    strict: true,
  });
  database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  if (!options.readonly) {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;
      PRAGMA wal_autocheckpoint = 1000;
    `);
  }
  database.loadExtension(assets.sqliteVecExtension);
  database.exec("PRAGMA trusted_schema = OFF;");
  return database;
}

function configureCustomSqlite(path: string): void {
  if (configuredLibrary === path) return;
  const fingerprint = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (configuredLibrary) {
    if (configuredFingerprint === fingerprint) return;
    throw new Error(
      `SQLite was already configured from ${configuredLibrary}; cannot switch to ${path}`,
    );
  }
  Database.setCustomSQLite(path);
  configuredLibrary = path;
  configuredFingerprint = fingerprint;
}
