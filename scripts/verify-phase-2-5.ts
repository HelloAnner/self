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
const evidenceRoot = resolve(".test-runs/roadmap/2026-07-11/phase-2-5");
const testsRoot = resolve(evidenceRoot, "tests");
const failuresRoot = resolve(evidenceRoot, "failures");
const realRun = resolve("data/test-runs/phase-2-5-real-cli");
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
  ["bun", "run", "test:e2e:phase2.5"],
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
if (
  dataStatus.data?.database_schema_version !== VERSION.databaseSchema ||
  dataDoctor.data?.status !== "pass"
) {
  throw new Error("Development data Workspace did not pass Schema 3 verification");
}

const verified = await verifyConnectionEvidence(instance);
const connectionId = verified.performance_connection_id;
const before = await immutableCounts(instance);
const statusPerformance = measure(
  [binary, "--root", instance, "connection", "status", connectionId, "--json"],
  30,
  80,
);
const scanPerformance = measure(
  [binary, "--root", instance, "connection", "scan", connectionId, "--dry-run", "--json"],
  10,
  5_000,
);
const after = await immutableCounts(instance);
if (JSON.stringify(before) !== JSON.stringify(after)) {
  throw new Error("Unchanged Connection dry scans created evidence or ChangeItems");
}

const harnessRecords = await readHarnessRecords(resolve(realRun, "commands.jsonl"));
await Bun.write(
  resolve(evidenceRoot, "commands.jsonl"),
  `${[...records, ...harnessRecords].map((record) => JSON.stringify(record)).join("\n")}\n`,
);
await Bun.write(
  resolve(evidenceRoot, "verify.json"),
  `${JSON.stringify(
    {
      status: "passed",
      platform: process.platform,
      arch: process.arch,
      bun: Bun.version,
      database_schema_version: VERSION.databaseSchema,
      data_workspace: {
        state: dataStatus.data.state,
        doctor: dataDoctor.data.status,
      },
      evidence: verified,
      unchanged_dry_scan_reused_evidence: true,
      private_notes_used: false,
      hosted_model_called: false,
    },
    null,
    2,
  )}\n`,
);
await Bun.write(
  resolve(evidenceRoot, "fixtures.json"),
  `${JSON.stringify(
    {
      migration_sha256: await sha256File(resolve("drizzle/0003_connection.sql")),
      harness_sha256: await sha256File(resolve("tests/harness/phase2_5.ts")),
      classifier_sha256: await sha256File(
        resolve("src/domains/connection/services/change-classifier.ts"),
      ),
      real_cli_result: "data/test-runs/phase-2-5-real-cli/result.json",
      fixture_kind: "synthetic",
      private_notes_used: false,
    },
    null,
    2,
  )}\n`,
);
await Bun.write(
  resolve(evidenceRoot, "performance.json"),
  `${JSON.stringify({ connection_status: statusPerformance, unchanged_dry_scan: scanPerformance }, null, 2)}\n`,
);
await Bun.write(
  resolve(failuresRoot, "recovery-scenarios.json"),
  `${JSON.stringify(
    {
      status: "passed",
      evidence_source: "data/test-runs/phase-2-5-real-cli/commands.jsonl",
      scenarios: [
        "Self Root and overlapping Targets are rejected",
        "delete grace prevents immediate deletion and later converges",
        "unavailable Target degrades without false deletion or evidence replacement",
        "persisted ChangeBatch survives process exit and is accepted exactly once",
        "native watcher loss is repaired by scheduled reconciliation",
        "one file lock and SQLite Lease permit one Daemon leader",
        "SIGKILL leader is replaced after Lease expiry",
        "Schema 2 migration uses explicit Plan/Apply with a Root-local backup",
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
  `# Phase 2.5 verification summary

- Result: passed
- Scope: Schema 3 Connection/Target/Observation/Scan/ChangeBatch, authoritative reconciliation, Source archival, native watcher hints, Root-local Daemon lock/Lease, crash recovery, lifecycle and Rebind Plan/Apply.
- Real CLI: compiled binary with synthetic file systems under \`data/test-runs/phase-2-5-real-cli\`.
- Safety: Target disappearance does not emit deletion; deletion requires grace; sensitive files and symlinks remain excluded; all state, evidence, logs and locks stay in the Self Root.
- Recovery: Batch checkpoint process exit, lost watcher event, duplicate leader, SIGKILL and Lease takeover passed.
- Migration: explicit Schema 2 → 3 Plan/Apply with Root-local backup passed.
- Dependency boundary: Source Snapshot archival is complete; Ingestion Run, Revision and Chunk remain Phase 3 and are reported as \`not_started\`.
- Private data/model use: \`~/notes\` not read; hosted model not called.
`,
);
process.stdout.write(`Phase 2.5 verification passed; evidence: ${evidenceRoot}\n`);

async function verifyConnectionEvidence(root: string) {
  const assets = await locateWorkspaceAssets(root);
  const database = openSqlite(resolve(root, "data/self.sqlite3"), assets, { readonly: true });
  try {
    if (
      database.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()
        ?.integrity_check !== "ok"
    ) {
      throw new Error("Phase 2.5 database integrity failed");
    }
    const counts = {
      connections: count(database, "data_connections"),
      targets: count(database, "connection_targets"),
      scans: count(database, "connection_scan_runs"),
      observations: count(database, "connection_observations"),
      batches: count(database, "connection_change_batches"),
      items: count(database, "connection_change_items"),
      event_hints: count(database, "connection_event_hints"),
      snapshots: count(database, "source_snapshots"),
    };
    if (counts.connections < 3 || counts.scans < 10 || counts.items < 8) {
      throw new Error("Phase 2.5 evidence is unexpectedly incomplete");
    }
    const unresolved = database
      .query<{ count: number }, []>(
        "SELECT COUNT(*) count FROM connection_scan_runs WHERE state IN ('queued','enumerating','comparing','hashing','batching')",
      )
      .get()?.count;
    if (unresolved !== 0) throw new Error("Interrupted Scan remained after recovery");
    const connection = database
      .query<{ connection_id: string }, []>(
        "SELECT connection_id FROM data_connections WHERE kind = 'project' AND state = 'active' LIMIT 1",
      )
      .get();
    if (!connection) throw new Error("No active project Connection exists");
    return {
      ...counts,
      unresolved_scans: unresolved,
      performance_connection_id: connection.connection_id,
    };
  } finally {
    database.close();
  }
}

async function immutableCounts(root: string) {
  const assets = await locateWorkspaceAssets(root);
  const database = openSqlite(resolve(root, "data/self.sqlite3"), assets, { readonly: true });
  try {
    return {
      blobs: count(database, "source_blobs"),
      snapshots: count(database, "source_snapshots"),
      change_items: count(database, "connection_change_items"),
    };
  } finally {
    database.close();
  }
}

function count(database: ReturnType<typeof openSqlite>, table: string): number {
  const allowed = new Set([
    "data_connections",
    "connection_targets",
    "connection_scan_runs",
    "connection_observations",
    "connection_change_batches",
    "connection_change_items",
    "connection_event_hints",
    "source_blobs",
    "source_snapshots",
  ]);
  if (!allowed.has(table)) throw new Error(`Unsupported evidence table: ${table}`);
  return (
    database.query<{ count: number }, []>(`SELECT COUNT(*) count FROM ${table}`).get()?.count ?? 0
  );
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
  const percentile = (ratio: number) =>
    round(durations[Math.min(durations.length - 1, Math.ceil(durations.length * ratio) - 1)] ?? 0);
  const p95 = percentile(0.95);
  if (p95 > targetP95) throw new Error(`p95 ${p95}ms exceeds ${targetP95}ms`);
  return {
    samples,
    unit: "ms",
    p50: percentile(0.5),
    p95,
    min: round(durations[0] ?? 0),
    max: round(durations.at(-1) ?? 0),
    target_p95: targetP95,
  };
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
  if (exitCode !== 0) throw new Error(`${argv.join(" ")} failed (${exitCode}): ${stdout}${stderr}`);
  return record;
}

async function readHarnessRecords(path: string): Promise<CommandRecord[]> {
  return (await Bun.file(path).text())
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
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

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
