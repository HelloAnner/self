import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { runSqliteCapabilitiesSpike } from "../../src/infrastructure/db/spikes/sqlite-capabilities.ts";

const runRoot = resolve("data/test-runs/integration-sqlite");
const databasePath = resolve(runRoot, "self.sqlite3");

describe("real SQLite capabilities", () => {
  afterAll(async () => rm(runRoot, { recursive: true, force: true }));

  test("runs FTS5 and sqlite-vec in one file database", async () => {
    await mkdir(runRoot, { recursive: true });
    const result = await runSqliteCapabilitiesSpike(databasePath);

    expect(result.fts5.map((row) => row.result)).toEqual(["doc-a"]);
    expect(result.nearest.map((row) => row.id)).toEqual(["chunk-a", "chunk-c"]);
    expect(result.sqliteVecVersion).toBe("v0.1.9");
    expect(result.journalMode).toBe("wal");
    expect(result.drizzleRows).toBe(1);
  });
});
