import type { Database } from "bun:sqlite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { locateReleaseAssets } from "../../runtime/assets.ts";
import { openSqlite } from "../connection.ts";

export type SqliteSpikeResult = {
  databasePath: string;
  sqliteVersion: string;
  journalMode: string;
  drizzleRows: number;
  fts5: { result: string; rank: number }[];
  sqliteVecVersion: string;
  nearest: { id: string; distance: number }[];
};

export async function runSqliteCapabilitiesSpike(
  databasePath: string,
  explicitSqliteLibrary?: string,
): Promise<SqliteSpikeResult> {
  const assets = await locateReleaseAssets();
  const database = openSqlite(
    databasePath,
    { ...assets, sqliteLibrary: explicitSqliteLibrary ?? assets.sqliteLibrary },
    { create: true },
  );
  try {
    createFixture(database);
    return readResult(database, databasePath);
  } finally {
    database.close();
  }
}

function createFixture(database: Database): void {
  const orm = drizzle(database);
  orm.run(sql`CREATE TABLE IF NOT EXISTS spike_regular (id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  orm.run(sql`DELETE FROM spike_regular`);
  orm.run(sql`INSERT INTO spike_regular(id, value) VALUES ('regular-a', 'drizzle')`);

  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS spike_fts USING fts5(id UNINDEXED, body);
    CREATE VIRTUAL TABLE IF NOT EXISTS spike_vec USING vec0(
      id TEXT PRIMARY KEY,
      embedding FLOAT[3]
    );
    DELETE FROM spike_fts;
    DELETE FROM spike_vec;
  `);
  database.prepare("INSERT INTO spike_fts(id, body) VALUES (?, ?)").run("doc-a", "local evidence");

  const insertVector = database.prepare("INSERT INTO spike_vec(id, embedding) VALUES (?, ?)");
  insertVector.run("chunk-a", new Float32Array([1, 0, 0]));
  insertVector.run("chunk-b", new Float32Array([0, 1, 0]));
  insertVector.run("chunk-c", new Float32Array([0.8, 0.2, 0]));
  database
    .prepare("UPDATE spike_vec SET embedding = ? WHERE id = ?")
    .run(new Float32Array([0.9, 0.1, 0]), "chunk-c");
  database.prepare("DELETE FROM spike_vec WHERE id = ?").run("chunk-b");
}

function readResult(database: Database, databasePath: string): SqliteSpikeResult {
  const versions = database
    .query<{ sqlite: string; vec: string }, []>("SELECT sqlite_version() sqlite, vec_version() vec")
    .get();
  if (!versions) throw new Error("SQLite version query returned no row");
  const journal = database.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
  const drizzleCount = database
    .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM spike_regular")
    .get();

  const fts5 = database
    .query<{ result: string; rank: number }, [string]>(
      "SELECT id result, rank FROM spike_fts WHERE spike_fts MATCH ? ORDER BY rank LIMIT 5",
    )
    .all("evidence");
  const nearest = database
    .query<{ id: string; distance: number }, [Float32Array]>(
      "SELECT id, distance FROM spike_vec WHERE embedding MATCH ? AND k = 2 ORDER BY distance",
    )
    .all(new Float32Array([1, 0, 0]));

  return {
    databasePath,
    sqliteVersion: versions.sqlite,
    journalMode: journal?.journal_mode ?? "unknown",
    drizzleRows: drizzleCount?.count ?? 0,
    fts5,
    sqliteVecVersion: versions.vec,
    nearest,
  };
}
