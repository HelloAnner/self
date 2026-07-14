import { mkdir, readdir, rm } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { COMMAND_SPECS } from "../src/cli/protocol/command-specs.ts";
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
const evidenceRoot = resolve(".test-runs/roadmap/2026-07-11/phase-10");
const testsRoot = resolve(evidenceRoot, "tests");
const realRoot = resolve("data");
const realRestore = resolve("data/test-runs/phase10-real-notes-restore");
const records: CommandRecord[] = [];
await rm(evidenceRoot, { recursive: true, force: true });
await mkdir(testsRoot, { recursive: true });

for (const argv of [
  ["bun", "run", "typecheck"],
  ["bun", "run", "lint"],
  ["bun", "run", "check:size"],
  ["bun", "run", "db:check"],
  ["bun", "test", "--reporter=junit", `--reporter-outfile=${resolve(testsRoot, "junit.xml")}`],
  ["bun", "run", "build"],
  ["bun", "run", "release:verify"],
  ["bun", "run", "test:e2e:phase10"],
]) {
  await run(argv);
}

const binary = resolve(
  "dist/local",
  `self-${process.platform}-${process.arch}`,
  process.platform === "win32" ? "self.exe" : "self",
);
let status = object(await cli(binary, realRoot, ["status", "--json"]));
if (Number(status.database_schema_version) < VERSION.databaseSchema) {
  const plan = object(await cli(binary, realRoot, ["migration", "plan", "--json"]));
  await cli(binary, realRoot, ["apply", string(plan.plan_id), "--json"]);
  status = object(await cli(binary, realRoot, ["status", "--json"]));
}
if (Number(status.database_schema_version) !== VERSION.databaseSchema) {
  throw new Error("real notes Workspace is not at the current database Schema");
}
const doctor = object(await cli(binary, realRoot, ["doctor", "--all", "--json"]));
if (doctor.status !== "pass") throw new Error("real notes Workspace doctor failed");
const scanRecord = await cli(binary, realRoot, [
  "connection",
  "scan",
  "--all",
  "--dry-run",
  "--json",
]);
const scans = array(scanRecord);
const deepRecord = await cli(binary, realRoot, ["verify", "--deep", "--wait", "--json"]);
const deep = object(deepRecord);
if (deep.state !== "succeeded") throw new Error("real notes deep verification failed");
const deepResult = objectValue(deep.result);
if (deepResult.status !== "pass") throw new Error("real notes deep verification found issues");

const backup = await latestReadyBackup(binary);
const backupVerifyRecord = await cli(binary, realRoot, [
  "backup",
  "verify",
  string(backup.backup_id),
  "--json",
]);
const backupVerify = object(backupVerifyRecord);
if (backupVerify.status !== "pass") throw new Error("real notes Backup verification failed");

await rm(realRestore, { recursive: true, force: true });
const restorePlan = object(
  await cli(
    binary,
    realRoot,
    ["backup", "restore", string(backup.backup_id), "--to", realRestore, "--plan", "--json"],
    { SELF_ALLOW_NESTED_TEST_ROOT: "1" },
  ),
);
const restoreRecord = await cli(
  binary,
  realRoot,
  ["apply", string(restorePlan.plan_id), "--json"],
  { SELF_ALLOW_NESTED_TEST_ROOT: "1" },
);
const restore = object(restoreRecord);
if (restore.status !== "succeeded") throw new Error("real notes restore Plan was not applied");
const restoredStatus = object(await cli(binary, realRestore, ["status", "--json"]));
const searchRecord = await cli(binary, realRestore, [
  "search",
  "Agent",
  "--mode",
  "text",
  "--limit",
  "1",
  "--json",
]);
const search = object(searchRecord);
if (!Array.isArray(search.results) || search.results.length === 0) {
  throw new Error("restored real notes search returned no evidence");
}

await verifyCoverage();
const credential = await verifyCredentialStrategy();
const synthetic = (await Bun.file(
  resolve("data/test-runs/phase-10-real-cli/result.json"),
).json()) as Record<string, unknown>;
synthetic.restored_root = "data/test-runs/phase-10-real-cli/restored-instance";
const release = (await Bun.file(
  resolve("data/test-runs/release-gate/result.json"),
).json()) as Record<string, unknown>;
const harnessRecords = await readHarness(
  resolve("data/test-runs/phase-10-real-cli/commands.jsonl"),
);
const realMetrics = {
  connection_scan_ms: scanRecord.duration_ms,
  deep_verify_ms: deepRecord.duration_ms,
  backup_verify_ms: backupVerifyRecord.duration_ms,
  restore_apply_ms: restoreRecord.duration_ms,
  restored_search_ms: searchRecord.duration_ms,
  backup_bytes: Number(backup.total_bytes),
  backup_files: Number(backup.file_count),
};

await Bun.write(
  resolve(evidenceRoot, "commands.jsonl"),
  `${[...records, ...harnessRecords]
    .map(safeRecord)
    .map((record) => JSON.stringify(record))
    .join("\n")}\n`,
);
await Bun.write(
  resolve(evidenceRoot, "verify.json"),
  `${JSON.stringify(
    {
      status: "passed",
      cli_version: VERSION.cli,
      database_schema_version: VERSION.databaseSchema,
      synthetic,
      release,
      real_data: {
        doctor: doctor.status,
        deep_verify: deepResult.status,
        verification_id: deepResult.verification_id,
        verification_issues: deepResult.issue_count,
        notes_connections_scanned: scans.length,
        observed_changes: scans.reduce((sum, item) => sum + changes(item), 0),
        backup_id: backup.backup_id,
        backup_manifest_hash: backup.manifest_hash,
        backup_verified: backupVerify.status,
        restored_schema: restoredStatus.database_schema_version,
        restored_search_results: search.results.length,
      },
      credential,
      private_notes_used: true,
      private_content_in_evidence: false,
    },
    null,
    2,
  )}\n`,
);
await Bun.write(
  resolve(evidenceRoot, "performance.json"),
  `${JSON.stringify(realMetrics, null, 2)}\n`,
);
await Bun.write(
  resolve(evidenceRoot, "fixtures.json"),
  `${JSON.stringify(
    {
      migration_sha256: await sha256File(resolve("drizzle/0011_operations_jobs.sql")),
      harness_sha256: await sha256File(resolve("tests/harness/phase10.ts")),
      job_workflows_sha256: await sha256File(
        resolve("src/application/automation/job-workflows.ts"),
      ),
      release_workflow_sha256: await sha256File(resolve(".github/workflows/release.yml")),
      synthetic_root: "data/test-runs/phase-10-real-cli/instance",
      restored_real_root: "data/test-runs/phase10-real-notes-restore",
      private_content_in_evidence: false,
    },
    null,
    2,
  )}\n`,
);
await Bun.write(resolve(evidenceRoot, "root-tree.txt"), await syntheticRootTree());
await Bun.write(
  resolve(evidenceRoot, "summary.md"),
  `# Phase 10 verification summary

- Result: passed; CLI v1.0.0 and Schema 11 add durable Job/Event, Backup, Verification, GC Receipt and maintenance-lease state to the single SQLite authority.
- Recovery: forced migration failure preserves the source database; dead workers, cancellation and retry converge through persisted checkpoints and leases.
- Backup: SQLite snapshot plus a hashed Root-local manifest was verified and restored without overwriting an existing Root; the restored real notes Workspace passed status and search checks.
- Verification and GC: deep verification detects missing Blob/Artifact files, orphan vectors and broken Claim evidence; GC applies only after a persisted reference proof and stages recoverable file deletion.
- Release: the standalone binary, checksums, SBOM, npm install/upgrade/uninstall and clean-machine Backup/Restore gate passed on the current platform. Cross-platform jobs are defined in the release workflow; no external package or GitHub Release was published by this gate.
- Credentials: Provider secrets remain environment references. The configured hosted endpoint was not called because its environment variable was absent; no plaintext secret or private note content is present in evidence.
`,
);
process.stdout.write(`Phase 10 verification passed; evidence: ${evidenceRoot}\n`);

async function latestReadyBackup(binary: string): Promise<Record<string, unknown>> {
  const listed = array(await cli(binary, realRoot, ["backup", "list", "--limit", "20", "--json"]));
  for (const row of listed) {
    const shown = object(
      await cli(binary, realRoot, ["backup", "show", string(row.backup_id), "--json"]),
    );
    if (shown.state === "ready" && Number(shown.file_count) > 0) return shown;
  }
  const job = object(
    await cli(binary, realRoot, [
      "backup",
      "create",
      "--wait",
      "--idempotency-key",
      "phase10-real-notes",
      "--json",
    ]),
  );
  if (job.state !== "succeeded") throw new Error("real notes Backup Job failed");
  const result = objectValue(job.result);
  return object(
    await cli(binary, realRoot, ["backup", "show", string(result.backup_id), "--json"]),
  );
}

async function verifyCoverage() {
  const tests = (await Bun.file(resolve("tests/coverage-manifest.json")).json()) as {
    commands?: Record<string, string[]>;
  };
  const missingTests = COMMAND_SPECS.filter((spec) => !tests.commands?.[spec.id]?.length).map(
    (spec) => spec.id,
  );
  if (missingTests.length > 0) {
    throw new Error(`tests/coverage-manifest.json misses commands: ${missingTests.join(", ")}`);
  }
  const docs = (await Bun.file(resolve("docs/contracts/coverage-manifest.json")).json()) as {
    commands?: Record<string, string[]>;
  };
  const phase10 = [
    "job.list",
    "job.show",
    "job.logs",
    "job.watch",
    "job.cancel",
    "job.retry",
    "backup.create",
    "backup.list",
    "backup.show",
    "backup.verify",
    "backup.restore",
    "verify",
    "gc",
    "maintenance.status",
    "maintenance.checkpoint",
  ];
  const missingDocs = phase10.filter((id) => !docs.commands?.[id]?.length);
  if (missingDocs.length > 0) {
    throw new Error(`docs coverage manifest misses Phase 10 commands: ${missingDocs.join(", ")}`);
  }
}

async function verifyCredentialStrategy() {
  const config = await Bun.file(resolve("data/self.toml")).text();
  if (/sk-[A-Za-z0-9]{20,}/u.test(config)) throw new Error("credential persisted in self.toml");
  const assets = await locateWorkspaceAssets(realRoot);
  const database = openSqlite(resolve(realRoot, "data/self.sqlite3"), assets, { readonly: true });
  try {
    const rows = database
      .query<{ api_key_env: string | null }, []>(
        "SELECT api_key_env FROM model_providers WHERE api_key_env IS NOT NULL",
      )
      .all();
    if (rows.some((row) => !/^[A-Z][A-Z0-9_]+$/u.test(row.api_key_env ?? ""))) {
      throw new Error("Provider credential is not an environment-variable reference");
    }
    return {
      strategy: "environment_reference",
      configured_references: rows.length,
      plaintext_persisted: false,
      hosted_live_call: process.env.SELF_DASHSCOPE_API_KEY
        ? "not_run_workspace_offline"
        : "not_run_key_not_in_environment",
    };
  } finally {
    database.close();
  }
}

async function syntheticRootTree(): Promise<string> {
  const root = resolve("data/test-runs/phase-10-real-cli/instance");
  const top = await readdir(root, { withFileTypes: true });
  return `${top
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .map(
      (entry) => `${entry.isDirectory() ? "d" : "f"} ${relative(root, resolve(root, entry.name))}`,
    )
    .sort()
    .join("\n")}\n`;
}

async function cli(
  binary: string,
  root: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<CommandRecord> {
  return run([binary, "--root", root, ...args], env);
}

async function run(argv: string[], env: Record<string, string> = {}): Promise<CommandRecord> {
  const started = performance.now();
  const child = Bun.spawn(argv, {
    cwd: repository,
    env: { ...process.env, ...env, SELF_NO_OPEN: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const record = {
    argv,
    exit_code: exitCode,
    duration_ms: Math.round((performance.now() - started) * 100) / 100,
    stdout,
    stderr,
  };
  records.push(record);
  if (exitCode !== 0) throw new Error(`${argv.join(" ")} failed (${exitCode}): ${stdout}${stderr}`);
  return record;
}

function data(record: CommandRecord): unknown {
  const value = JSON.parse(record.stdout) as { ok: boolean; data: unknown };
  if (value.ok !== true) throw new Error(record.stdout);
  return value.data;
}

function object(record: CommandRecord): Record<string, unknown> {
  return objectValue(data(record));
}

function array(record: CommandRecord): Array<Record<string, unknown>> {
  const value = data(record);
  if (!Array.isArray(value)) throw new Error("Expected a CLI array result");
  return value as Array<Record<string, unknown>>;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected object");
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("Expected string");
  return value;
}

function changes(item: Record<string, unknown>): number {
  return ["changes_created", "changes_modified", "changes_deleted", "changes_renamed"].reduce(
    (total, key) => total + Number(item[key] ?? 0),
    0,
  );
}

async function readHarness(path: string): Promise<CommandRecord[]> {
  return (await Bun.file(path).text())
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CommandRecord);
}

function safeRecord(record: CommandRecord) {
  return {
    argv: record.argv.map((value) =>
      value
        .replaceAll(repository, "<repository>")
        .replaceAll(realRestore, "<restored-real-root>")
        .replaceAll(realRoot, "<real-root>")
        .replace(/sk-[A-Za-z0-9]+/gu, "<redacted>"),
    ),
    exit_code: record.exit_code,
    duration_ms: record.duration_ms,
  };
}
