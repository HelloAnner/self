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
const evidenceRoot = resolve(".test-runs/roadmap/2026-07-11/phase-7");
const syntheticRun = resolve("data/test-runs/phase-7-real-cli");
const synthetic = resolve(syntheticRun, "instance");
const realRoot = resolve("data");
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
  ["bun", "run", "test:e2e:phase7"],
])
  await run(argv);

const binary = resolve(
  "dist/local",
  `self-${process.platform}-${process.arch}`,
  process.platform === "win32" ? "self.exe" : "self",
);
const doctor = envelope(await run([binary, "--root", realRoot, "doctor", "--all", "--json"]));
const graph = envelope(
  await run([binary, "--root", realRoot, "graph", "verify", "--deep", "--json"]),
);
if (doctor.status !== "pass" || graph.status !== "pass")
  throw new Error("real Vault verification failed");
await verifyCoverage();
await verifyNoCredentialPersistence();

const assetCache = new Map<string, Awaited<ReturnType<typeof locateWorkspaceAssets>>>();
assetCache.set(synthetic, await locateWorkspaceAssets(synthetic));
assetCache.set(realRoot, await locateWorkspaceAssets(realRoot));
const syntheticEvidence = topicEvidence(synthetic, false);
const liveEvidence = topicEvidence(realRoot, true);
const topicId = String(syntheticEvidence.topic_id);
const sectionId = String(syntheticEvidence.trace_section_id);
const topicShowPerformance = measure(
  [binary, "--root", synthetic, "topic", "show", topicId, "--json"],
  60,
  80,
);
const sectionTracePerformance = measure(
  [binary, "--root", synthetic, "trace", sectionId, "--json"],
  60,
  120,
);
const queryPlans = queryPlanEvidence(synthetic);
const harnessRecords = await readHarness(resolve(syntheticRun, "commands.jsonl"));
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
      data_workspace: { doctor: doctor.status, graph_verify: graph.status },
      synthetic: syntheticEvidence,
      real_vault_live_model: liveEvidence,
      private_notes_used: true,
      hosted_graph_extraction_observed: true,
      credential_persisted: false,
    },
    null,
    2,
  )}\n`,
);
await Bun.write(
  resolve(evidenceRoot, "performance.json"),
  `${JSON.stringify(
    { topic_show: topicShowPerformance, section_trace: sectionTracePerformance },
    null,
    2,
  )}\n`,
);
await Bun.write(
  resolve(evidenceRoot, "query-plans.json"),
  `${JSON.stringify(queryPlans, null, 2)}\n`,
);
await Bun.write(
  resolve(evidenceRoot, "fixtures.json"),
  `${JSON.stringify(
    {
      migration_sha256: await sha256File(resolve("drizzle/0008_topic_synthesis.sql")),
      harness_sha256: await sha256File(resolve("tests/harness/phase7.ts")),
      synthesis_rules_sha256: await sha256File(resolve("src/domains/topic/services/synthesis.ts")),
      synthetic_root: "data/test-runs/phase-7-real-cli",
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
        "unsupported hosted Graph output fails only its Chunk while the Generation continues",
        "network and credential failures still abort the Graph batch",
        "same-lineage reposts do not increase independent source count",
        "knowledge changes mark Topic stale and Claim moderation marks affected Topic needs_review",
        "Topic Snapshot and Report rows reject UPDATE and preserve historical versions",
        "Schema 7 to 8 migration uses explicit Plan/Apply and a Root-local backup",
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
  [
    "# Phase 7 verification summary",
    "",
    "- Result: passed.",
    "- Scope: Schema 8 Topic/Scope/Alias, SynthesisRun, immutable TopicSnapshot, local Graph, Claim clustering, source independence, structured report, KnowledgeGap, confidence/coverage/health, History, stale/needs_review and Section trace.",
    "- Safety: consensus requires at least two distinct source lineages; reposts collapse by lineage; opinion, inference, conflict and unknown remain distinct; every supported conclusion reaches a Claim and Root-local Chunk evidence.",
    "- Real Vault: an ignored data/ Topic built from hosted Graph extraction over the read-only archived notes corpus; this directory stores aggregate evidence only.",
    "- Live Model: invalid structured responses were isolated per Chunk and surfaced as explicit counts; the credential existed only in the process environment and offline mode was restored.",
    "- Deferred: Page IR, Artifact Build, HTML, export, diff and optimized topic refresh begin in Phase 8; generic detached Jobs remain Phase 10.",
    "",
  ].join("\n"),
);
process.stdout.write(`Phase 7 verification passed; evidence: ${evidenceRoot}\n`);

function topicEvidence(root: string, requireHosted: boolean) {
  return withDb(root, (db) => {
    const topic = db
      .query<Record<string, unknown>, []>(
        requireHosted
          ? "SELECT * FROM topics WHERE normalized_name = 'faiss 向量索引' ORDER BY created_at DESC LIMIT 1"
          : "SELECT * FROM topics WHERE latest_snapshot_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
      )
      .get();
    if (!topic?.latest_snapshot_id) throw new Error(`Topic evidence missing: ${root}`);
    const snapshotId = String(topic.latest_snapshot_id);
    const snapshot = db
      .query<Record<string, unknown>, [string]>(
        "SELECT * FROM topic_snapshots WHERE topic_snapshot_id = ?",
      )
      .get(snapshotId);
    const supported = scalar(
      db,
      `SELECT COUNT(*) count FROM topic_report_conclusions c JOIN topic_report_sections s
       ON s.section_id = c.section_id WHERE s.topic_snapshot_id = ? AND c.support_status = 'supported'`,
      snapshotId,
    );
    const citations = db
      .query<
        { excerpt_hash: string; content_text: string; excerpt_start: number; excerpt_end: number },
        [string]
      >(
        `SELECT tc.excerpt_hash, k.content_text, tc.excerpt_start, tc.excerpt_end
         FROM topic_report_citations tc JOIN topic_report_conclusions c
         ON c.conclusion_id = tc.conclusion_id JOIN topic_report_sections s
         ON s.section_id = c.section_id JOIN knowledge_chunks k ON k.chunk_id = tc.chunk_id
         WHERE s.topic_snapshot_id = ?`,
      )
      .all(snapshotId);
    const invalid = citations.filter(
      (row) =>
        sha256Text(row.content_text.slice(row.excerpt_start, row.excerpt_end)) !== row.excerpt_hash,
    ).length;
    if (supported === 0 || citations.length < supported || invalid !== 0)
      throw new Error(`Topic Citation evidence incomplete: ${root}`);
    const section = db
      .query<{ section_id: string }, [string]>(
        `SELECT section_id FROM topic_report_sections WHERE topic_snapshot_id = ?
         AND section_kind <> 'overview' ORDER BY ordinal LIMIT 1`,
      )
      .get(snapshotId);
    const hosted = requireHosted
      ? scalar(
          db,
          `SELECT COUNT(*) count FROM model_invocations WHERE operation_kind = 'graph.extract'
           AND status = 'succeeded' AND provider_actual_model_id IS NOT NULL`,
        )
      : 0;
    if (requireHosted && hosted === 0) throw new Error("Hosted Graph extraction evidence missing");
    return {
      topic_id: topic.topic_id,
      topic_snapshot_id: snapshotId,
      sequence: snapshot?.sequence,
      health_status: snapshot?.health_status,
      confidence_level: snapshot?.confidence_level,
      claims: scalar(
        db,
        "SELECT COUNT(*) count FROM topic_snapshot_claims WHERE topic_snapshot_id = ?",
        snapshotId,
      ),
      supported_conclusions: supported,
      citations: citations.length,
      invalid_citation_hashes: invalid,
      knowledge_gaps: scalar(
        db,
        "SELECT COUNT(*) count FROM topic_knowledge_gaps WHERE topic_snapshot_id = ?",
        snapshotId,
      ),
      trace_section_id: section?.section_id,
      hosted_graph_invocations: hosted,
      credential_storage: requireHosted ? "environment-only" : "fixture-provider",
    };
  });
}

function queryPlanEvidence(root: string) {
  return withDb(root, (db) => ({
    topic_latest: db
      .query<Record<string, unknown>, []>(
        "EXPLAIN QUERY PLAN SELECT latest_snapshot_id FROM topics WHERE topic_id = 'topic:fixture'",
      )
      .all(),
    snapshot_sections: db
      .query<Record<string, unknown>, []>(
        "EXPLAIN QUERY PLAN SELECT section_id FROM topic_report_sections WHERE topic_snapshot_id = 'topic-snapshot:fixture' ORDER BY ordinal",
      )
      .all(),
    conclusion_citations: db
      .query<Record<string, unknown>, []>(
        "EXPLAIN QUERY PLAN SELECT claim_id FROM topic_report_citations WHERE conclusion_id = 'conclusion:fixture'",
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
      "data/phase-7-live-graph.json",
    ],
    { cwd: repository, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode === 0) throw new Error("credential persisted in Phase 7 data");
}

function measure(argv: string[], samples: number, targetP95: number) {
  for (let index = 0; index < 5; index += 1) execute(argv);
  const durations: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    execute(argv);
    durations.push(performance.now() - started);
  }
  durations.sort((left, right) => left - right);
  const p95 = percentile(durations, 0.95);
  if (p95 > targetP95) throw new Error(`p95 ${p95}ms exceeds ${targetP95}ms`);
  return { samples, unit: "ms", p50: percentile(durations, 0.5), p95, target_p95: targetP95 };
}

function execute(argv: string[]) {
  const result = Bun.spawnSync(argv, { cwd: repository, stdout: "ignore", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function withDb<T>(root: string, action: (db: ReturnType<typeof openSqlite>) => T) {
  return openFor(root, action);
}

function openFor<T>(root: string, action: (db: ReturnType<typeof openSqlite>) => T): T {
  const db = openSqlite(resolve(root, "data/self.sqlite3"), cachedAssets(root), { readonly: true });
  try {
    return action(db);
  } finally {
    db.close();
  }
}

function cachedAssets(root: string) {
  const found = assetCache.get(root);
  if (!found) throw new Error(`assets not primed: ${root}`);
  return found;
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

function safeRecord(record: CommandRecord) {
  return {
    argv: record.argv.map((value) => (value.includes("sk-") ? "<redacted>" : value)),
    exit_code: record.exit_code,
    duration_ms: record.duration_ms,
  };
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
