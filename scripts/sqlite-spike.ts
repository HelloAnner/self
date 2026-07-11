import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runSqliteCapabilitiesSpike } from "../src/infrastructure/db/spikes/sqlite-capabilities.ts";

const checkOnly = process.argv.includes("--check-only");
const pathArgument = process.argv.find((argument) => argument.startsWith("--database="));
const databasePath = resolve(
  pathArgument?.slice("--database=".length) ?? "data/test-runs/sqlite-spike.sqlite3",
);

await mkdir(dirname(databasePath), { recursive: true });
const result = await runSqliteCapabilitiesSpike(databasePath);

if (result.fts5.length !== 1 || result.nearest[0]?.id !== "chunk-a") {
  throw new Error("SQLite capability spike returned unexpected results");
}

if (!checkOnly) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
