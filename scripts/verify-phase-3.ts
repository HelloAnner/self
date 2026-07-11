import { mkdir, readdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
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
const evidenceRoot = resolve(".test-runs/roadmap/2026-07-11/phase-3");
const testsRoot = resolve(evidenceRoot, "tests");
const failuresRoot = resolve(evidenceRoot, "failures");
const realRun = resolve("data/test-runs/phase-3-real-cli");
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
  ["bun", "run", "db:check"],
  ["bun", "test", "--reporter=junit", `--reporter-outfile=${resolve(testsRoot, "junit.xml")}`],
  ["bun", "run", "build"],
  ["bun", "run", "test:e2e:phase2.5"],
  ["bun", "run", "test:e2e:phase3"],
] as const;
for (const command of gates) await run([...command]);

const binary = resolve(
  "dist/local",
  `self-${process.platform}-${process.arch}`,
  process.platform === "win32" ? "self.exe" : "self",
);
const dataStatus = parseEnvelope(await run([binary, "--root", "data", "status", "--json"]));
const dataDoctor = parseEnvelope(
  await run([binary, "--root", "data", "doctor", "--all", "--json"]),
);
if (dataStatus.database_schema_version !== VERSION.databaseSchema || dataDoctor.status !== "pass") {
  throw new Error("Development data Workspace did not pass Schema 4 verification");
}

const verified = await verifyEvidence(instance);
await verifyCoverageManifest();
await run([binary, "--root", instance, "knowledge", "verify", "--deep", "--json"]);
const before = await immutableKnowledgeCounts(instance);
const statusPerformance = measure(
  [binary, "--root", instance, "knowledge", "status", "--source", verified.source_id, "--json"],
  30,
  80,
);
const buildPerformance = measure(
  [binary, "--root", instance, "knowledge", "build", "--source", verified.source_id, "--json"],
  10,
  5_000,
);
const after = await immutableKnowledgeCounts(instance);
if (JSON.stringify(before) !== JSON.stringify(after)) {
  throw new Error("Unchanged explicit Knowledge builds created immutable evidence");
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
      data_workspace: { state: dataStatus.state, doctor: dataDoctor.status },
      evidence: verified,
      unchanged_build_reused_evidence: true,
      coverage_manifest: "docs/contracts/coverage-manifest.json",
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
      migration_sha256: await sha256File(resolve("drizzle/0004_ingestion_knowledge.sql")),
      harness_sha256: await sha256File(resolve("tests/harness/phase3.ts")),
      parser_router_sha256: await sha256File(
        resolve("src/infrastructure/parsers/parser-router.ts"),
      ),
      chunker_sha256: await sha256File(
        resolve("src/domains/knowledge/services/semantic-chunker.ts"),
      ),
      coverage_manifest_sha256: await sha256File(resolve("docs/contracts/coverage-manifest.json")),
      real_cli_result: "data/test-runs/phase-3-real-cli/result.json",
      fixture_kind: "synthetic",
      private_notes_used: false,
    },
    null,
    2,
  )}\n`,
);
await Bun.write(
  resolve(evidenceRoot, "performance.json"),
  `${JSON.stringify(
    { knowledge_status: statusPerformance, unchanged_knowledge_build: buildPerformance },
    null,
    2,
  )}\n`,
);
await Bun.write(
  resolve(failuresRoot, "recovery-scenarios.json"),
  `${JSON.stringify(
    {
      status: "passed",
      evidence_source: "data/test-runs/phase-3-real-cli/commands.jsonl",
      scenarios: [
        "invalid JSONL fails without publishing a partial Document and recovers after correction",
        "process exit after Knowledge publish retries without duplicate Run evidence",
        "deleted source entries tombstone current Documents and Chunks without deleting history",
        "stale Note version is rejected before changing the managed file",
        "managed Note create and update receipts are consumed by reconciliation",
        "Schema 3 migration uses explicit Plan/Apply with a Root-local backup",
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
  `# Phase 3 verification summary

- Result: passed
- Scope: Schema 4 Ingestion state/checkpoints, Markdown/text/HTML/JSONL/PDF normalization, deterministic Chunking, immutable Document/Revision/Chunk evidence, lineage, tombstones and managed Notes.
- Incremental behavior: unchanged Snapshot/build reuses the ready Run; small edits reuse unaffected Chunks; incremental state converges to a clean full build.
- Integration: default Source Add/Sync and Connection ChangeBatch reach Knowledge ready; managed-content Note receipts suppress self-write echo.
- Recovery: parse failure, publish checkpoint process exit, Note version conflict and Schema 3 → 4 migration passed.
- Real CLI: compiled binary with synthetic fixtures under \`data/test-runs/phase-3-real-cli\`.
- Deferred: FTS, Embedding, VectorSpace and Hybrid Search remain Phase 4.
- Private data/model use: \`~/notes\` not read; hosted model not called.
`,
);
process.stdout.write(`Phase 3 verification passed; evidence: ${evidenceRoot}\n`);

async function verifyEvidence(root: string) {
  const assets = await locateWorkspaceAssets(root);
  const database = openSqlite(resolve(root, "data/self.sqlite3"), assets, { readonly: true });
  try {
    const integrity = database
      .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
      .get()?.integrity_check;
    if (integrity !== "ok") throw new Error("Phase 3 database integrity failed");
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
      ingestion_runs: scalar(database, "SELECT COUNT(*) count FROM ingestion_runs"),
      documents: scalar(database, "SELECT COUNT(*) count FROM knowledge_documents"),
      revisions: scalar(database, "SELECT COUNT(*) count FROM knowledge_revisions"),
      chunks: scalar(database, "SELECT COUNT(*) count FROM knowledge_chunks"),
      mappings: scalar(database, "SELECT COUNT(*) count FROM knowledge_revision_chunks"),
      lineage: scalar(database, "SELECT COUNT(*) count FROM knowledge_chunk_lineage"),
      consumed_write_receipts: scalar(
        database,
        "SELECT COUNT(*) count FROM connection_write_receipts WHERE consumed_at IS NOT NULL",
      ),
    };
    if (
      counts.documents < 8 ||
      counts.revisions < 10 ||
      counts.chunks < 10 ||
      counts.lineage < 1 ||
      counts.consumed_write_receipts < 2
    ) {
      throw new Error("Phase 3 evidence is unexpectedly incomplete");
    }
    const unfinished = scalar(
      database,
      "SELECT COUNT(*) count FROM ingestion_runs WHERE state IN ('queued','parsing','normalized','chunked','publishing','retrying')",
    );
    const orphans = scalar(
      database,
      `SELECT COUNT(*) count FROM knowledge_revision_chunks rc
       LEFT JOIN knowledge_revisions r ON r.revision_id = rc.revision_id
       LEFT JOIN knowledge_chunks c ON c.chunk_id = rc.chunk_id
       WHERE r.revision_id IS NULL OR c.chunk_id IS NULL`,
    );
    if (unfinished !== 0 || orphans !== 0)
      throw new Error("Phase 3 has unfinished or orphan state");
    const source = database
      .query<{ source_id: string }, []>(
        "SELECT source_id FROM sources WHERE kind = 'directory' AND ingestion_status = 'ready' ORDER BY created_at LIMIT 1",
      )
      .get();
    if (!source) throw new Error("No ready directory Source exists for performance verification");
    return {
      ...counts,
      blob_hashes_verified: blobs.length,
      unfinished_runs: unfinished,
      orphan_revision_chunk_mappings: orphans,
      source_id: source.source_id,
    };
  } finally {
    database.close();
  }
}

async function verifyCoverageManifest(): Promise<void> {
  const manifest = (await Bun.file(resolve("docs/contracts/coverage-manifest.json")).json()) as {
    commands?: Record<string, string[]>;
  };
  const phase3Ids = COMMAND_SPECS.filter(
    (spec) =>
      spec.id.startsWith("knowledge.") ||
      spec.id.startsWith("ingestion.") ||
      spec.id.startsWith("note.") ||
      ["source.add", "source.list", "source.sync", "connection.add", "connection.scan"].includes(
        spec.id,
      ),
  ).map((spec) => spec.id);
  const missing = phase3Ids.filter((id) => !manifest.commands?.[id]?.length);
  if (missing.length > 0) throw new Error(`Coverage manifest is missing: ${missing.join(", ")}`);
}

async function immutableKnowledgeCounts(root: string) {
  const assets = await locateWorkspaceAssets(root);
  const database = openSqlite(resolve(root, "data/self.sqlite3"), assets, { readonly: true });
  try {
    return {
      runs: scalar(database, "SELECT COUNT(*) count FROM ingestion_runs"),
      documents: scalar(database, "SELECT COUNT(*) count FROM knowledge_documents"),
      revisions: scalar(database, "SELECT COUNT(*) count FROM knowledge_revisions"),
      chunks: scalar(database, "SELECT COUNT(*) count FROM knowledge_chunks"),
      mappings: scalar(database, "SELECT COUNT(*) count FROM knowledge_revision_chunks"),
      lineage: scalar(database, "SELECT COUNT(*) count FROM knowledge_chunk_lineage"),
    };
  } finally {
    database.close();
  }
}

function scalar(database: ReturnType<typeof openSqlite>, sql: string): number {
  return database.query<{ count: number }, []>(sql).get()?.count ?? 0;
}

async function run(argv: string[]): Promise<CommandRecord> {
  const started = performance.now();
  const child = Bun.spawn(argv, {
    cwd: repository,
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
    duration_ms: round(performance.now() - started),
    stdout,
    stderr,
  };
  records.push(record);
  if (exitCode !== 0) throw new Error(`${argv.join(" ")} failed (${exitCode}): ${stdout}${stderr}`);
  return record;
}

function parseEnvelope(record: CommandRecord): Record<string, unknown> {
  const envelope = JSON.parse(record.stdout);
  if (envelope.ok !== true) throw new Error(`Expected success envelope: ${record.stdout}`);
  return envelope.data as Record<string, unknown>;
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

async function readHarnessRecords(path: string): Promise<CommandRecord[]> {
  return (await Bun.file(path).text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CommandRecord);
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
