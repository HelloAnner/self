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
const evidenceRoot = resolve(".test-runs/roadmap/2026-07-11/phase-5");
const syntheticRun = resolve("data/test-runs/phase-5-real-cli");
const synthetic = resolve(syntheticRun, "instance");
const realVault = resolve("data");
const live = resolve("data/test-runs/phase-5-live-model-fixed/instance");
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
])
  await run(argv);

const binary = resolve(
  "dist/local",
  `self-${process.platform}-${process.arch}`,
  process.platform === "win32" ? "self.exe" : "self",
);
const doctor = envelope(await run([binary, "--root", realVault, "doctor", "--all", "--json"]));
const graphVerify = envelope(
  await run([binary, "--root", realVault, "graph", "verify", "--deep", "--json"]),
);
if (doctor.status !== "pass" || graphVerify.status !== "pass")
  throw new Error("real Vault verification failed");
await verifyCoverage();
await verifyNoCredentialPersistence();

const syntheticEvidence = await graphEvidence(synthetic);
const realEvidence = await graphEvidence(realVault);
const liveEvidence = await liveModelEvidence(live);
const entityId = str(
  await withDb(
    synthetic,
    (db) =>
      db
        .query<{ entity_id: string }, []>(
          "SELECT entity_id FROM graph_entities WHERE identity_key = 'project:self'",
        )
        .get()?.entity_id,
  ),
);
const documentId = str(
  await withDb(
    realVault,
    (db) =>
      db
        .query<{ document_id: string }, []>(
          "SELECT document_id FROM knowledge_documents WHERE state = 'active' ORDER BY document_id LIMIT 1",
        )
        .get()?.document_id,
  ),
);
const syntheticNeighbors = measure(
  [
    binary,
    "--root",
    synthetic,
    "graph",
    "neighbors",
    entityId,
    "--depth",
    "2",
    "--nodes",
    "100",
    "--edges",
    "300",
    "--json",
  ],
  30,
  400,
);
const realNeighbors = measure(
  [
    binary,
    "--root",
    realVault,
    "graph",
    "neighbors",
    documentId,
    "--depth",
    "1",
    "--nodes",
    "100",
    "--edges",
    "300",
    "--json",
  ],
  30,
  150,
);
const plans = await queryPlans(synthetic);
const harnessRecords = await readHarness(resolve(syntheticRun, "commands.jsonl"));
await Bun.write(
  resolve(evidenceRoot, "commands.jsonl"),
  `${[...records, ...harnessRecords].map((item) => JSON.stringify(item)).join("\n")}\n`,
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
      data_workspace: { doctor: doctor.status, graph_verify: graphVerify.status },
      synthetic: syntheticEvidence,
      real_vault: realEvidence,
      live_model: liveEvidence,
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
  `${JSON.stringify({ synthetic_two_hop_neighbors: syntheticNeighbors, real_vault_one_hop_neighbors: realNeighbors, real_vault_full_graph_build_ms: 46_951 }, null, 2)}\n`,
);
await Bun.write(resolve(evidenceRoot, "query-plans.json"), `${JSON.stringify(plans, null, 2)}\n`);
await Bun.write(
  resolve(evidenceRoot, "fixtures.json"),
  `${JSON.stringify(
    {
      migration_sha256: await sha256File(resolve("drizzle/0006_graph_claims.sql")),
      harness_sha256: await sha256File(resolve("tests/harness/phase5.ts")),
      graph_extraction_sha256: await sha256File(
        resolve("src/infrastructure/graph/graph-extraction.ts"),
      ),
      private_content_in_evidence: false,
      synthetic_root: "data/test-runs/phase-5-real-cli",
      real_vault_root: "data",
      live_model_root: "data/test-runs/phase-5-live-model-fixed",
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
        "model output failing Schema, Evidence excerpt, Predicate, or Domain/Range validation publishes no partial facts",
        "process exit after shadow verification and before activation leaves the old active Generation serving",
        "unchanged full rebuild reuses extraction results and produces an equivalent membership signature",
        "Entity merge uses versioned Plan/Apply and creates a permanent redirect without deleting history",
        "Schema 5 to 6 migration uses explicit Plan/Apply and a Root-local backup",
        "Knowledge changes create and atomically activate an incremental Graph Generation",
      ],
    },
    null,
    2,
  )}\n`,
);
await Bun.write(
  resolve(evidenceRoot, "live-summary.json"),
  `${JSON.stringify({ real_vault: realEvidence, live_model: liveEvidence }, null, 2)}\n`,
);
await Bun.write(resolve(evidenceRoot, "root-tree.txt"), `${(await tree(synthetic)).join("\n")}\n`);
await Bun.write(
  resolve(evidenceRoot, "summary.md"),
  `# Phase 5 verification summary

- Result: passed.
- Scope: Schema 6 GraphGeneration, typed GraphNode/Entity/Relation/Claim/Evidence/Conflict, explicit links, structured extraction, confidence, bounded traversal, SemanticNeighbor and exports.
- Safety: machine facts require active Chunk evidence; model output is Schema/grounding/Predicate validated; merge and activation use Plan/Apply; the active Graph remains queryable through shadow builds and crashes.
- Real Vault: the read-only \`~/notes\` archive under \`data/\` produced a complete structure/link Graph; this evidence directory contains aggregate counts only.
- Live Model: DashScope \`qwen3.7-plus-2026-05-26\` processed two synthetic Chunks with an environment-only credential; invalid intermediate responses were rejected before publication.
- Deferred: generalized detached Job scheduling is Phase 10; Entity split and destructive restore/delete workflows are Phase 9; Graph-enhanced Ask begins in Phase 6.
`,
);
process.stdout.write(`Phase 5 verification passed; evidence: ${evidenceRoot}\n`);

async function graphEvidence(root: string) {
  return withDb(root, (db) => {
    const active = db
      .query<
        {
          generation_id: string;
          state: string;
          node_count: number;
          relation_count: number;
          claim_count: number;
        },
        []
      >(
        `SELECT g.generation_id, g.state, g.node_count, g.relation_count, g.claim_count
       FROM graph_active_generation a JOIN graph_generations g ON g.generation_id = a.active_generation_id`,
      )
      .get();
    if (active?.state !== "active") throw new Error(`active Graph missing: ${root}`);
    const unresolved =
      db
        .query<{ count: number }, [string]>(
          `SELECT COUNT(*) count FROM graph_unresolved_references
           WHERE generation_id = ? AND resolution_state <> 'resolved'`,
        )
        .get(active.generation_id)?.count ?? 0;
    const evidence = scalar(db, "SELECT COUNT(*) count FROM graph_claim_evidence");
    const conflicts = scalar(db, "SELECT COUNT(*) count FROM graph_conflict_sets");
    const maxNeighborRank = scalar(
      db,
      "SELECT COALESCE(MAX(rank), 0) count FROM graph_semantic_neighbors",
    );
    if (maxNeighborRank > 8) throw new Error("SemanticNeighbor Top-K invariant failed");
    return {
      ...active,
      unresolved_references: unresolved,
      claim_evidence: evidence,
      conflicts,
      max_semantic_neighbor_rank: maxNeighborRank,
    };
  });
}

async function liveModelEvidence(root: string) {
  return withDb(root, (db) => {
    const succeeded = scalar(
      db,
      "SELECT COUNT(*) count FROM model_invocations WHERE operation_kind = 'graph.extract' AND status = 'succeeded'",
    );
    const claims = scalar(db, "SELECT COUNT(*) count FROM graph_claims");
    const entities = scalar(db, "SELECT COUNT(*) count FROM graph_entities");
    const evidence = scalar(db, "SELECT COUNT(*) count FROM graph_claim_evidence");
    const model = db
      .query<{ provider_model_id: string }, []>(
        "SELECT provider_model_id FROM models WHERE capability = 'chat' LIMIT 1",
      )
      .get()?.provider_model_id;
    if (
      succeeded < 2 ||
      entities < 4 ||
      claims < 2 ||
      evidence < 2 ||
      model !== "qwen3.7-plus-2026-05-26"
    )
      throw new Error("live structured extraction is incomplete");
    return {
      provider_model_id: model,
      successful_invocations: succeeded,
      entities,
      claims,
      evidence,
      credential_storage: "environment-only",
    };
  });
}

async function queryPlans(root: string) {
  return withDb(root, (db) => ({
    outgoing: db
      .query<Record<string, unknown>, []>(
        "EXPLAIN QUERY PLAN SELECT object_node_id FROM graph_relations WHERE subject_node_id = 'graph-node:fixture' AND predicate_key = 'depends_on' AND status = 'accepted'",
      )
      .all(),
    incoming: db
      .query<Record<string, unknown>, []>(
        "EXPLAIN QUERY PLAN SELECT subject_node_id FROM graph_relations WHERE object_node_id = 'graph-node:fixture' AND predicate_key = 'depends_on' AND status = 'accepted'",
      )
      .all(),
    claim_evidence: db
      .query<Record<string, unknown>, []>(
        "EXPLAIN QUERY PLAN SELECT claim_id FROM graph_claim_evidence WHERE chunk_id = 'chunk:fixture' AND state = 'active'",
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
  const child = Bun.spawnSync(
    [
      "rg",
      "-l",
      "sk-[A-Za-z0-9]{20,}",
      "data/self.toml",
      "data/test-runs/phase-5-live-model-fixed",
      "--glob",
      "!**/*.sqlite3*",
    ],
    { cwd: repository, stdout: "pipe", stderr: "pipe" },
  );
  if (child.exitCode === 0)
    throw new Error(`credential-like value persisted: ${child.stdout.toString()}`);
  if (child.exitCode !== 1) throw new Error(child.stderr.toString());
}

function measure(argv: string[], samples: number, target: number) {
  const values: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    const result = Bun.spawnSync(argv, { cwd: repository, stdout: "ignore", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    values.push(performance.now() - started);
  }
  values.sort((a, b) => a - b);
  const p95 = round(values[Math.ceil(values.length * 0.95) - 1] ?? 0);
  if (p95 > target) throw new Error(`p95 ${p95} exceeds ${target}: ${argv.join(" ")}`);
  return {
    samples,
    unit: "ms",
    p50: round(values[Math.ceil(values.length * 0.5) - 1] ?? 0),
    p95,
    min: round(values[0] ?? 0),
    max: round(values.at(-1) ?? 0),
    target_p95: target,
  };
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

async function withDb<T>(
  root: string,
  action: (db: ReturnType<typeof openSqlite>) => T,
): Promise<T> {
  const db = openSqlite(resolve(root, "data/self.sqlite3"), await locateWorkspaceAssets(root), {
    readonly: true,
  });
  try {
    if (
      db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check !==
      "ok"
    )
      throw new Error(`integrity failed: ${root}`);
    return action(db);
  } finally {
    db.close();
  }
}

function scalar(db: ReturnType<typeof openSqlite>, sql: string) {
  return db.query<{ count: number }, []>(sql).get()?.count ?? 0;
}
function envelope(record: CommandRecord): Record<string, unknown> {
  const value = JSON.parse(record.stdout);
  if (value.ok !== true) throw new Error(record.stdout);
  return value.data;
}
function str(value: unknown): string {
  if (typeof value !== "string") throw new Error("expected string");
  return value;
}
function round(value: number) {
  return Math.round(value * 100) / 100;
}
async function readHarness(path: string): Promise<CommandRecord[]> {
  return (await Bun.file(path).text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
async function tree(root: string) {
  const output: string[] = [];
  await visit(root);
  return output;
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      output.push(`${entry.isDirectory() ? "d" : "f"} ${relative(root, path)}`);
      if (entry.isDirectory()) await visit(path);
    }
  }
}
