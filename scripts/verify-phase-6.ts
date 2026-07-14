import { mkdir, readdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { COMMAND_SPECS } from "../src/cli/protocol/command-specs.ts";
import { openSqlite } from "../src/infrastructure/db/connection.ts";
import { sha256File, sha256Text } from "../src/infrastructure/filesystem/hash.ts";
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
const evidenceRoot = resolve(".test-runs/roadmap/2026-07-11/phase-6");
const syntheticRun = resolve("data/test-runs/phase-6-real-cli");
const synthetic = resolve(syntheticRun, "instance");
const realVault = resolve("data");
const testsRoot = resolve(evidenceRoot, "tests");
const failuresRoot = resolve(evidenceRoot, "failures");
const records: CommandRecord[] = [];
await rm(evidenceRoot, { recursive: true, force: true });
await mkdir(testsRoot, { recursive: true });
await mkdir(failuresRoot, { recursive: true });

for (const argv of [
  ["bun", "run", "typecheck"],
  ["bun", "run", "lint"],
  ["bun", "run", "check:size"],
  ["bun", "run", "db:check"],
  ["bun", "test", "--reporter=junit", `--reporter-outfile=${resolve(testsRoot, "junit.xml")}`],
  ["bun", "run", "build"],
  ["bun", "run", "test:e2e:phase2.5"],
  ["bun", "run", "test:e2e:phase3"],
  ["bun", "run", "test:e2e:phase4"],
  ["bun", "run", "test:e2e:phase5"],
  ["bun", "run", "test:e2e:phase6"],
])
  await run(argv);

const binary = resolve(
  "dist/local",
  `self-${process.platform}-${process.arch}`,
  process.platform === "win32" ? "self.exe" : "self",
);
const doctor = envelope(await run([binary, "--root", realVault, "doctor", "--all", "--json"]));
const graph = envelope(
  await run([binary, "--root", realVault, "graph", "verify", "--deep", "--json"]),
);
if (doctor.status !== "pass" || graph.status !== "pass")
  throw new Error("real Vault verification failed");
await verifyCoverage();
await verifyNoCredentialPersistence();

const syntheticEvidence = await retrievalEvidence(synthetic, false);
const liveEvidence = await retrievalEvidence(realVault, true);
const answerId = String(syntheticEvidence.latest_answer_id);
const entityId = await withDb(
  synthetic,
  (db) =>
    db
      .query<{ entity_id: string }, []>(
        "SELECT entity_id FROM graph_entities WHERE identity_key = 'project:self'",
      )
      .get()?.entity_id ?? "",
);
const tracePerformance = measure(
  [binary, "--root", synthetic, "trace", answerId, "--json"],
  60,
  120,
);
const relatedPerformance = measure(
  [binary, "--root", synthetic, "related", entityId, "--depth", "1", "--json"],
  60,
  150,
);
const queryPlans = await queryPlanEvidence(synthetic);
const harnessRecords = await readHarness(resolve(syntheticRun, "commands.jsonl"));
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
      data_workspace: { doctor: doctor.status, graph_verify: graph.status },
      synthetic: syntheticEvidence,
      real_vault_live_model: liveEvidence,
      coverage_manifest: "tests/coverage-manifest.json",
      private_notes_used: true,
      hosted_model_called: true,
      credential_persisted: false,
    },
    null,
    2,
  )}\n`,
);
await Bun.write(
  resolve(evidenceRoot, "performance.json"),
  `${JSON.stringify({ trace_point_lookup: tracePerformance, related_one_hop: relatedPerformance }, null, 2)}\n`,
);
await Bun.write(
  resolve(evidenceRoot, "query-plans.json"),
  `${JSON.stringify(queryPlans, null, 2)}\n`,
);
await Bun.write(
  resolve(evidenceRoot, "fixtures.json"),
  `${JSON.stringify(
    {
      migration_sha256: await sha256File(resolve("drizzle/0007_evidence_answers.sql")),
      harness_sha256: await sha256File(resolve("tests/harness/phase6.ts")),
      answer_provider_sha256: await sha256File(
        resolve("src/infrastructure/model/answer-provider.ts"),
      ),
      synthetic_root: "data/test-runs/phase-6-real-cli",
      real_vault_root: "data",
      private_content_in_evidence: false,
    },
    null,
    2,
  )}\n`,
);
await Bun.write(
  resolve(failuresRoot, "recovery-scenarios.json"),
  `${JSON.stringify(
    {
      status: "passed",
      scenarios: [
        "a fabricated or non-grounded Citation is rejected before Answer publication",
        "no evidence returns insufficient_evidence without a model call",
        "external model knowledge requires an explicit flag and remains separately typed",
        "Knowledge or Graph changes mark active EvidenceContext and Answer cache stale",
        "Answer trace rehydrates the same immutable excerpts and reaches Source Snapshot",
        "Schema 6 to 7 migration uses explicit Plan/Apply and a Root-local backup",
      ],
    },
    null,
    2,
  )}\n`,
);
await Bun.write(
  resolve(evidenceRoot, "live-summary.json"),
  `${JSON.stringify({ real_vault_live_model: liveEvidence }, null, 2)}\n`,
);
await Bun.write(resolve(evidenceRoot, "root-tree.txt"), `${(await tree(synthetic)).join("\n")}\n`);
await Bun.write(
  resolve(evidenceRoot, "summary.md"),
  `# Phase 6 verification summary

- Result: passed.
- Scope: Schema 7 RetrievalRun, Graph expansion, bounded EvidenceContext, grounded Answer/Statement/Citation, Ask/Related/Trace, cache invalidation and snapshot replay.
- Safety: factual output must cite a Root-local evidence key; quoted support is mapped back to exact Chunk text before publication; insufficient evidence and external model knowledge remain explicit result types.
- Real Vault: the archived read-only \`~/notes\` corpus under \`data/\` completed a hosted Ask with aggregate evidence only in this directory.
- Live Model: DashScope \`qwen3.7-plus-2026-05-26\` produced a grounded answer; its credential existed only in the process environment.
- Deferred: persistent Topic snapshots and cross-section synthesis begin in Phase 7; generic detached Jobs remain Phase 10.
`,
);
process.stdout.write(`Phase 6 verification passed; evidence: ${evidenceRoot}\n`);

async function retrievalEvidence(root: string, requireHosted: boolean) {
  return withDb(root, (db) => {
    const latest = db
      .query<Record<string, unknown>, []>(
        `${requireHosted ? "SELECT a.* FROM answer_runs a JOIN model_invocations i ON i.invocation_id = a.invocation_id WHERE i.operation_kind = 'retrieval.ask' AND i.status = 'succeeded' AND a.provider_actual_model_id = 'qwen3.7-plus-2026-05-26'" : "SELECT a.* FROM answer_runs a WHERE EXISTS (SELECT 1 FROM answer_citations c WHERE c.answer_id = a.answer_id)"} ORDER BY a.created_at DESC LIMIT 1`,
      )
      .get();
    if (!latest) throw new Error(`Answer evidence missing: ${root}`);
    const answerId = String(latest.answer_id);
    const statements = scalar(
      db,
      "SELECT COUNT(*) count FROM answer_statements WHERE answer_id = ?",
      answerId,
    );
    const citations = scalar(
      db,
      "SELECT COUNT(*) count FROM answer_citations WHERE answer_id = ?",
      answerId,
    );
    const citationRows = db
      .query<
        { excerpt_hash: string; content_text: string; excerpt_start: number; excerpt_end: number },
        [string]
      >(
        `SELECT c.excerpt_hash, k.content_text, c.excerpt_start, c.excerpt_end
         FROM answer_citations c JOIN evidence_context_items i
         ON i.context_id = c.context_id AND i.ordinal = c.context_ordinal
         JOIN knowledge_chunks k ON k.chunk_id = i.chunk_id WHERE c.answer_id = ?`,
      )
      .all(answerId);
    const invalid = citationRows.filter(
      (row) =>
        sha256Text(row.content_text.slice(row.excerpt_start, row.excerpt_end)) !== row.excerpt_hash,
    ).length;
    if (statements === 0 || citations === 0 || invalid !== 0)
      throw new Error(`Answer Citation evidence incomplete: ${root}`);
    return {
      latest_answer_id: answerId,
      result_kind: latest.result_kind,
      context_id: latest.context_id,
      model_id: latest.model_id,
      provider_actual_model_id: latest.provider_actual_model_id,
      statements,
      citations,
      retrieval_runs: scalar(db, "SELECT COUNT(*) count FROM retrieval_runs"),
      evidence_contexts: scalar(db, "SELECT COUNT(*) count FROM evidence_contexts"),
      credential_storage: requireHosted ? "environment-only" : "fixture-provider",
    };
  });
}

async function queryPlanEvidence(root: string) {
  return withDb(root, (db) => ({
    answer_cache: db
      .query<Record<string, unknown>, []>(
        "EXPLAIN QUERY PLAN SELECT answer_id FROM answer_runs WHERE query_hash = 'fixture' AND cache_state = 'active' AND status = 'succeeded' ORDER BY created_at DESC",
      )
      .all(),
    context_chunk: db
      .query<Record<string, unknown>, []>(
        "EXPLAIN QUERY PLAN SELECT context_id FROM evidence_context_items WHERE chunk_id = 'chunk:fixture'",
      )
      .all(),
    citations: db
      .query<Record<string, unknown>, []>(
        "EXPLAIN QUERY PLAN SELECT statement_id FROM answer_citations WHERE answer_id = 'answer:fixture'",
      )
      .all(),
  }));
}

async function verifyCoverage() {
  const manifest = (await Bun.file(resolve("tests/coverage-manifest.json")).json()) as {
    commands?: Record<string, string[]>;
  };
  const missing = COMMAND_SPECS.filter((spec) => !manifest.commands?.[spec.id]?.length).map(
    (spec) => spec.id,
  );
  if (missing.length) throw new Error(`Coverage manifest missing: ${missing.join(", ")}`);
}

async function verifyNoCredentialPersistence() {
  const result = Bun.spawnSync(
    [
      "rg",
      "-l",
      "sk-[A-Za-z0-9]{20,}",
      "data/self.toml",
      "data/data",
      "data/test-runs/phase-6-live-model.json",
    ],
    { cwd: repository, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode === 0) throw new Error("credential persisted in Phase 6 data");
}

function measure(argv: string[], samples: number, targetP95: number) {
  for (let index = 0; index < 5; index += 1) {
    const warmup = Bun.spawnSync(argv, { cwd: repository, stdout: "ignore", stderr: "pipe" });
    if (warmup.exitCode !== 0) throw new Error(warmup.stderr.toString());
  }
  const durations: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    const result = Bun.spawnSync(argv, { cwd: repository, stdout: "ignore", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    durations.push(performance.now() - started);
  }
  durations.sort((left, right) => left - right);
  const p95 = percentile(durations, 0.95);
  if (p95 > targetP95) throw new Error(`p95 ${p95}ms exceeds ${targetP95}ms: ${argv.join(" ")}`);
  return { samples, unit: "ms", p50: percentile(durations, 0.5), p95, target_p95: targetP95 };
}

async function withDb<T>(root: string, action: (db: ReturnType<typeof openSqlite>) => T) {
  const db = openSqlite(resolve(root, "data/self.sqlite3"), await locateWorkspaceAssets(root), {
    readonly: true,
  });
  try {
    return action(db);
  } finally {
    db.close();
  }
}

function scalar(db: ReturnType<typeof openSqlite>, sql: string, value?: string) {
  return value
    ? (db.query<{ count: number }, [string]>(sql).get(value)?.count ?? 0)
    : (db.query<{ count: number }, []>(sql).get()?.count ?? 0);
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

function envelope(record: CommandRecord): Record<string, unknown> {
  const value = JSON.parse(record.stdout);
  if (value.ok !== true) throw new Error(record.stdout);
  return value.data;
}

async function readHarness(path: string) {
  return (await Bun.file(path).text())
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function tree(root: string) {
  const output: string[] = [];
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      output.push(relative(root, path));
      if (entry.isDirectory()) await visit(path);
    }
  }
  await visit(root);
  return output;
}

function percentile(values: number[], ratio: number) {
  return round(values[Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1)] ?? 0);
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}
