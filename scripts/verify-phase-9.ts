import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
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
const evidenceRoot = resolve(".test-runs/roadmap/2026-07-11/phase-9");
const testsRoot = resolve(evidenceRoot, "tests");
const realRoot = resolve("data");
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
  ["bun", "run", "test:e2e:phase9"],
]) {
  await run(argv);
}

const binary = resolve(
  "dist/local",
  `self-${process.platform}-${process.arch}`,
  process.platform === "win32" ? "self.exe" : "self",
);
const status = envelope(await run([binary, "--root", realRoot, "status", "--json"]));
if (Number(status.database_schema_version) < VERSION.databaseSchema) {
  const plan = envelope(await run([binary, "--root", realRoot, "migration", "plan", "--json"]));
  await run([binary, "--root", realRoot, "apply", String(plan.plan_id), "--json"]);
}
const doctor = envelope(await run([binary, "--root", realRoot, "doctor", "--all", "--json"]));
if (doctor.status !== "pass") throw new Error("real data Workspace doctor failed");
const dryRun = envelope(
  await run([binary, "--root", realRoot, "connection", "scan", "--all", "--dry-run", "--json"]),
);
const artifact = await realArtifact(realRoot);
const beforeStatus = artifact.status;
const plan = envelope(
  await run([
    binary,
    "--root",
    realRoot,
    "artifact",
    "delete",
    artifact.artifact_id,
    "--plan",
    "--json",
  ]),
);
const shown = envelope(
  await run([binary, "--root", realRoot, "plan", "show", String(plan.plan_id), "--json"]),
);
const diff = envelope(
  await run([binary, "--root", realRoot, "plan", "diff", String(plan.plan_id), "--json"]),
);
await run([binary, "--root", realRoot, "plan", "cancel", String(plan.plan_id), "--json"]);
const after = await realArtifact(realRoot, artifact.artifact_id);
if (after.status !== beforeStatus)
  throw new Error("real data Plan changed an Artifact before Apply");
await verifyCoverage();
await verifyNoCredentialPersistence();

const syntheticResult = JSON.parse(
  await Bun.file(resolve("data/test-runs/phase-9-real-cli/result.json")).text(),
);
const harnessRecords = await readHarness(resolve("data/test-runs/phase-9-real-cli/commands.jsonl"));
await Bun.write(
  resolve(evidenceRoot, "commands.jsonl"),
  `${[...records, ...harnessRecords]
    .map(safeRecord)
    .map((row) => JSON.stringify(row))
    .join("\n")}\n`,
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
      synthetic: syntheticResult,
      real_data: {
        doctor: doctor.status,
        notes_connections_scanned: Array.isArray(dryRun) ? dryRun.length : 0,
        observed_changes: Array.isArray(dryRun)
          ? dryRun.reduce((total, item) => total + changes(item), 0)
          : 0,
        plan_id: shown.plan_id,
        plan_action: shown.action,
        planned_changes: Array.isArray(diff.changes) ? diff.changes.length : 0,
        applied: false,
        artifact_status_preserved: after.status,
      },
      private_notes_used: true,
      credential_persisted: false,
    },
    null,
    2,
  )}\n`,
);
await Bun.write(
  resolve(evidenceRoot, "fixtures.json"),
  `${JSON.stringify(
    {
      migration_sha256: await sha256File(resolve("drizzle/0010_safe_operations.sql")),
      harness_sha256: await sha256File(resolve("tests/harness/phase9.ts")),
      automation_repository_sha256: await sha256File(
        resolve("src/infrastructure/automation/automation-repository.ts"),
      ),
      synthetic_root: "data/test-runs/phase-8-real-cli/moved-instance",
      real_notes_root: "data",
      private_content_in_evidence: false,
    },
    null,
    2,
  )}\n`,
);
await Bun.write(
  resolve(evidenceRoot, "summary.md"),
  `# Phase 9 verification summary

- Result: passed; Schema 10 adds immutable Plan, OperationChange and AuditEvent records.
- Safety: destructive commands require Plan/Apply, re-check exact preconditions, expose atomic item results and reject stale Plans.
- Recovery: soft delete preserves evidence IDs and revisions; Source, Note, Graph, Topic and Artifact restore exact recorded states; Operation Undo also compensates managed Note file moves.
- Purge: physical Source purge is irreversible and only applies when retained references are zero; a hash-only receipt remains.
- Real notes: the ignored data/ Workspace passed Schema 10 integrity and a notes Connection dry-run; an Artifact delete Plan was inspected and cancelled without Apply.
- Credentials: no plaintext Provider credential was persisted or copied into verification evidence.
`,
);
process.stdout.write(`Phase 9 verification passed; evidence: ${evidenceRoot}\n`);

async function realArtifact(root: string, artifactId?: string) {
  const assets = await locateWorkspaceAssets(root);
  const database = openSqlite(resolve(root, "data/self.sqlite3"), assets, { readonly: true });
  try {
    const row = artifactId
      ? database
          .query<{ artifact_id: string; status: string }, [string]>(
            "SELECT artifact_id, status FROM artifacts WHERE artifact_id = ?",
          )
          .get(artifactId)
      : database
          .query<{ artifact_id: string; status: string }, []>(
            "SELECT artifact_id, status FROM artifacts WHERE status <> 'deleted' LIMIT 1",
          )
          .get();
    if (!row) throw new Error("real data Artifact is missing");
    return row;
  } finally {
    database.close();
  }
}

async function verifyCoverage() {
  const manifest = (await Bun.file(resolve("tests/coverage-manifest.json")).json()) as {
    commands?: Record<string, string[]>;
  };
  const missing = COMMAND_SPECS.filter((spec) => !manifest.commands?.[spec.id]?.length).map(
    (spec) => spec.id,
  );
  if (missing.length > 0) throw new Error(`Coverage manifest missing: ${missing.join(", ")}`);
}

async function verifyNoCredentialPersistence() {
  const config = await Bun.file(resolve("data/self.toml")).text();
  if (!/offline\s*=\s*true/u.test(config)) throw new Error("real Workspace is not offline");
  if (/sk-[A-Za-z0-9]{20,}/u.test(config)) throw new Error("credential persisted in self.toml");
}

function changes(item: unknown): number {
  if (!item || typeof item !== "object") return 0;
  const row = item as Record<string, unknown>;
  return ["changes_created", "changes_modified", "changes_deleted", "changes_renamed"].reduce(
    (total, key) => total + Number(row[key] ?? 0),
    0,
  );
}

async function run(argv: string[]): Promise<CommandRecord> {
  const started = performance.now();
  const child = Bun.spawn(argv, {
    cwd: repository,
    env: { ...process.env, SELF_NO_OPEN: "1" },
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

function envelope(record: CommandRecord): Record<string, unknown> {
  const value = JSON.parse(record.stdout);
  if (value.ok !== true) throw new Error(record.stdout);
  return value.data as Record<string, unknown>;
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
    argv: record.argv.map((value) => (value.includes("sk-") ? "<redacted>" : value)),
    exit_code: record.exit_code,
    duration_ms: record.duration_ms,
  };
}
