import { mkdir, readdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { openSqlite } from "../src/infrastructure/db/connection.ts";
import { sha256File } from "../src/infrastructure/filesystem/hash.ts";
import { locateWorkspaceAssets } from "../src/infrastructure/runtime/assets.ts";
import { VERSION } from "../src/shared/version.ts";

type CommandRecord = {
  argv: string[];
  exit_code: number;
  duration_ms: number;
  stdout: string;
  stderr: string;
};

const repository = resolve(".");
const evidenceRoot = resolve(".test-runs/roadmap/2026-07-11/phase-2");
const testsRoot = resolve(evidenceRoot, "tests");
const failuresRoot = resolve(evidenceRoot, "failures");
const commandsPath = resolve(evidenceRoot, "commands.jsonl");
const realRun = resolve("data/test-runs/phase-2-real-cli");
const instance = resolve(realRun, "instance");
const records: CommandRecord[] = [];

await rm(evidenceRoot, { recursive: true, force: true });
await mkdir(testsRoot, { recursive: true });
await mkdir(failuresRoot, { recursive: true });

const gates = [
  ["bun", "--version"],
  ["bun", "install", "--frozen-lockfile", "--registry", "https://registry.npmjs.org"],
  ["bun", "run", "typecheck"],
  ["bun", "run", "lint"],
  ["bun", "run", "check:size"],
  ["bun", "test", "--reporter=junit", `--reporter-outfile=${resolve(testsRoot, "junit.xml")}`],
  ["bun", "run", "build"],
  ["bun", "run", "test:e2e:phase1"],
  ["bun", "run", "test:e2e:phase2"],
] as const;
for (const command of gates) await run([...command]);

const binary = resolve(
  "dist/local",
  `self-${process.platform}-${process.arch}`,
  process.platform === "win32" ? "self.exe" : "self",
);
const dataStatus = JSON.parse((await run([binary, "--root", "data", "status", "--json"])).stdout);
const dataDoctor = JSON.parse(
  (await run([binary, "--root", "data", "doctor", "--all", "--json"])).stdout,
);
await run([binary, "--root", "data", "source", "list", "--json"]);
if (
  dataStatus.data?.database_schema_version !== VERSION.databaseSchema ||
  dataDoctor.data?.status !== "pass"
) {
  throw new Error("Development data Workspace did not pass current-schema verification");
}

const verified = await verifyEvidence(instance);
const sourceId = verified.performanceSourceId;
const beforePerformance = await sourceCounts(instance);
const show = measure([binary, "--root", instance, "source", "show", sourceId, "--json"], 30, 80);
const sync = measure([binary, "--root", instance, "source", "sync", sourceId, "--json"], 10, 5_000);
const afterPerformance = await sourceCounts(instance);
if (
  beforePerformance.blobs !== afterPerformance.blobs ||
  beforePerformance.snapshots !== afterPerformance.snapshots
) {
  throw new Error("Unchanged Source performance run created evidence objects");
}

await Bun.write(commandsPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
await Bun.write(
  resolve(evidenceRoot, "verify.json"),
  `${JSON.stringify(
    {
      status: "passed",
      platform: process.platform,
      arch: process.arch,
      bun: Bun.version,
      data_workspace: {
        state: dataStatus.data.state,
        mode: dataStatus.data.mode,
        database_schema_version: dataStatus.data.database_schema_version,
        doctor: dataDoctor.data.status,
      },
      evidence: verified,
      unchanged_performance_reused_evidence: true,
      private_notes_used: false,
      hosted_model_called: false,
      gates: records.map(({ argv, exit_code, duration_ms }) => ({ argv, exit_code, duration_ms })),
    },
    null,
    2,
  )}\n`,
);
await Bun.write(
  resolve(evidenceRoot, "fixtures.json"),
  `${JSON.stringify(
    {
      migration_sha256: await hashFile("drizzle/0002_source.sql"),
      source_harness_sha256: await hashFile("tests/harness/phase2.ts"),
      source_diff_sha256: await hashFile("src/domains/source/services/snapshot-diff.ts"),
      real_cli_result: "data/test-runs/phase-2-real-cli/result.json",
      real_cli_commands: "data/test-runs/phase-2-real-cli/commands.jsonl",
      fixture_kind: "synthetic",
      private_notes_used: false,
    },
    null,
    2,
  )}\n`,
);
await Bun.write(
  resolve(evidenceRoot, "performance.json"),
  `${JSON.stringify({ source_show: show, unchanged_sync: sync }, null, 2)}\n`,
);
await Bun.write(
  resolve(failuresRoot, "recovery-scenarios.json"),
  `${JSON.stringify(
    {
      status: "passed",
      evidence_source: "data/test-runs/phase-2-real-cli/commands.jsonl",
      scenarios: [
        "Root-internal database path rejected as a Source",
        "complete ingestion request rejected until Phase 3 unless --no-build is explicit",
        "unavailable external Target preserves current Snapshot and supports Retry",
        "batch Sync reports stable partial failure with exit 7",
        "stale Source Delete Plan conflicts after Source version changes",
        "Schema 1 migration uses explicit Plan/Apply and retains a Root-local backup",
      ],
    },
    null,
    2,
  )}\n`,
);
await Bun.write(
  resolve(evidenceRoot, "root-tree.txt"),
  `${(await listTree(instance)).join("\n")}\n`,
);
await Bun.write(
  resolve(evidenceRoot, "summary.md"),
  `# Phase 2 verification summary

- Result: passed
- Scope: file/directory/Obsidian/stdin/single-page web Sources, import/snapshot/mirror archive semantics, SHA-256 Blob deduplication, immutable Snapshot manifests, incremental Diff, Retry, ChangeBatch receipt, soft Delete Plan and Restore.
- Migration: explicit schema 1 → 2 Plan/Apply with a Root-local consistent backup.
- Real CLI: synthetic fixtures and local HTTP only under \`data/test-runs/phase-2-real-cli\`.
- Safety: old evidence survives source-file deletion, unavailable Targets, soft deletion, and offline web access.
- Deferred by design: user \`~/notes\`, watcher/Daemon, parsing, Chunk/Revision, model calls, vectors, and graph enrichment.
`,
);
process.stdout.write(`Phase 2 verification passed; evidence: ${evidenceRoot}\n`);

async function verifyEvidence(root: string) {
  const assets = await locateWorkspaceAssets(root);
  const database = openSqlite(resolve(root, "data/self.sqlite3"), assets, { readonly: true });
  try {
    const integrity = database
      .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
      .get();
    if (integrity?.integrity_check !== "ok") throw new Error("Phase 2 database integrity failed");
    const blobs = database
      .query<{ sha256: string; relative_path: string }, []>(
        "SELECT sha256, relative_path FROM source_blobs",
      )
      .all();
    for (const blob of blobs) {
      if ((await sha256File(resolve(root, blob.relative_path))) !== blob.sha256) {
        throw new Error(`Blob hash mismatch: ${blob.sha256}`);
      }
    }
    const counts = {
      sources: count(database, "sources"),
      snapshots: count(database, "source_snapshots"),
      entries: count(database, "source_snapshot_entries"),
      blobs: blobs.length,
      changes: count(database, "source_snapshot_changes"),
    };
    if (counts.sources < 4 || counts.snapshots < 6 || counts.blobs < 5) {
      throw new Error("Phase 2 evidence set is unexpectedly incomplete");
    }
    const source = database
      .query<{ source_id: string }, []>(
        "SELECT source_id FROM sources WHERE kind = 'obsidian' AND state = 'active' LIMIT 1",
      )
      .get();
    if (!source) throw new Error("No active Obsidian Source is available for verification");
    return { ...counts, blob_hashes_verified: blobs.length, performanceSourceId: source.source_id };
  } finally {
    database.close();
  }
}

async function sourceCounts(root: string) {
  const assets = await locateWorkspaceAssets(root);
  const database = openSqlite(resolve(root, "data/self.sqlite3"), assets, { readonly: true });
  try {
    return {
      blobs: count(database, "source_blobs"),
      snapshots: count(database, "source_snapshots"),
    };
  } finally {
    database.close();
  }
}

function count(database: ReturnType<typeof openSqlite>, table: string): number {
  const allowed = new Set([
    "sources",
    "source_snapshots",
    "source_snapshot_entries",
    "source_snapshot_changes",
    "source_blobs",
  ]);
  if (!allowed.has(table)) throw new Error(`Unsupported evidence table: ${table}`);
  return (
    database.query<{ count: number }, []>(`SELECT COUNT(*) count FROM ${table}`).get()?.count ?? 0
  );
}

async function run(argv: string[]): Promise<CommandRecord> {
  const started = performance.now();
  const child = Bun.spawn(argv, { cwd: repository, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const record = {
    argv,
    exit_code: exitCode,
    duration_ms: round(performance.now() - started),
    stdout,
    stderr,
  };
  records.push(record);
  if (exitCode !== 0) {
    await Bun.write(commandsPath, `${records.map((item) => JSON.stringify(item)).join("\n")}\n`);
    throw new Error(`${argv.join(" ")} failed (${exitCode}): ${stdout}${stderr}`);
  }
  return record;
}

function measure(argv: string[], samples: number, targetP95: number) {
  const durations: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    const result = Bun.spawnSync(argv, { cwd: repository, stdout: "ignore", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    durations.push(performance.now() - started);
  }
  durations.sort((left, right) => left - right);
  const p95 = percentile(durations, 0.95);
  if (p95 > targetP95)
    throw new Error(`${argv.slice(1).join(" ")} p95 ${p95}ms exceeds ${targetP95}ms`);
  return {
    command: argv.slice(1).join(" "),
    samples,
    unit: "ms",
    p50: percentile(durations, 0.5),
    p95,
    min: round(durations[0] ?? 0),
    max: round(durations.at(-1) ?? 0),
    target_p95: targetP95,
  };
}

function percentile(values: number[], ratio: number): number {
  return round(values[Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1)] ?? 0);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

async function hashFile(path: string): Promise<string> {
  return sha256File(resolve(path));
}

async function listTree(root: string): Promise<string[]> {
  const output: string[] = [];
  await visit(root);
  return output;
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      output.push(`${entry.isDirectory() ? "d" : "f"} ${relative(root, path)}`);
      if (entry.isDirectory()) await visit(path);
    }
  }
}
