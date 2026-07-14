import { mkdir, readdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { COMMAND_SPECS } from "../src/cli/protocol/command-specs.ts";
import { sha256File } from "../src/infrastructure/filesystem/hash.ts";
import { VERSION } from "../src/shared/version.ts";
import {
  immutableCounts,
  queryPlanEvidence,
  verifyLiveModel,
  verifyRealVault,
  verifySynthetic,
} from "./verify-phase-4-evidence.ts";

type CommandRecord = {
  argv: string[];
  exit_code: number;
  duration_ms: number;
  stdout: string;
  stderr: string;
};

const repository = resolve(".");
const evidenceRoot = resolve(".test-runs/roadmap/2026-07-11/phase-4");
const testsRoot = resolve(evidenceRoot, "tests");
const failuresRoot = resolve(evidenceRoot, "failures");
const syntheticRun = resolve("data/test-runs/phase-4-real-cli");
const synthetic = resolve(syntheticRun, "instance");
const liveModel = resolve("data/test-runs/phase-4-live-model");
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
  ["bun", "run", "test:e2e:phase4"],
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
if (dataStatus.database_schema_version !== VERSION.databaseSchema || dataDoctor.status !== "pass")
  throw new Error("Development data Workspace did not pass Schema 5 verification");
await run([binary, "--root", "data", "knowledge", "verify", "--deep", "--json"]);

await verifyCoverageManifest();
const syntheticEvidence = await verifySynthetic(synthetic);
const realVaultEvidence = await verifyRealVault("data");
const liveModelEvidence = await verifyLiveModel(liveModel);
const before = await immutableCounts(synthetic);
const ftsPerformance = measure(
  [
    binary,
    "--root",
    synthetic,
    "search",
    "immutable evidence",
    "--mode",
    "text",
    "--limit",
    "20",
    "--json",
  ],
  30,
  100,
);
const hybridPerformance = measure(
  [
    binary,
    "--root",
    synthetic,
    "search",
    "source snapshot immutable",
    "--mode",
    "hybrid",
    "--limit",
    "20",
    "--json",
  ],
  30,
  250,
  { SELF_ENABLE_TEST_PROVIDERS: "1" },
);
const realVaultFtsPerformance = measure(
  [binary, "--root", "data", "search", "向量搜索", "--mode", "text", "--limit", "20", "--json"],
  30,
  100,
);
const after = await immutableCounts(synthetic);
if (JSON.stringify(before) !== JSON.stringify(after))
  throw new Error("Read-only Search created immutable Model/Knowledge evidence");

const queryPlans = await queryPlanEvidence(synthetic, syntheticEvidence.active_vector_space_id);
const harnessRecords = await readHarnessRecords(resolve(syntheticRun, "commands.jsonl"));
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
      synthetic: syntheticEvidence,
      real_vault: realVaultEvidence,
      live_model: liveModelEvidence,
      immutable_search_evidence_unchanged: true,
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
  resolve(evidenceRoot, "fixtures.json"),
  `${JSON.stringify(
    {
      migration_sha256: await sha256File(resolve("drizzle/0005_search_vectors.sql")),
      harness_sha256: await sha256File(resolve("tests/harness/phase4.ts")),
      fts_index_sha256: await sha256File(resolve("src/infrastructure/knowledge/fts-index.ts")),
      vector_index_sha256: await sha256File(
        resolve("src/infrastructure/knowledge/vector-index.ts"),
      ),
      fingerprint_sha256: await sha256File(
        resolve("src/domains/model/services/vector-space-fingerprint.ts"),
      ),
      synthetic_result: "data/test-runs/phase-4-real-cli/result.json",
      live_model_root: "data/test-runs/phase-4-live-model",
      real_vault_root: "data",
      private_content_in_evidence: false,
    },
    null,
    2,
  )}\n`,
);
await Bun.write(
  resolve(evidenceRoot, "performance.json"),
  `${JSON.stringify(
    {
      synthetic_fts: ftsPerformance,
      synthetic_cached_hybrid: hybridPerformance,
      real_vault_fts: realVaultFtsPerformance,
    },
    null,
    2,
  )}\n`,
);
await Bun.write(
  resolve(evidenceRoot, "query-plans.json"),
  `${JSON.stringify(queryPlans, null, 2)}\n`,
);
await Bun.write(
  resolve(failuresRoot, "recovery-scenarios.json"),
  `${JSON.stringify(
    {
      status: "passed",
      scenarios: [
        "Vector build process exit after one committed batch resumes without duplicate Embeddings",
        "FTS process exit before pointer swap leaves the old Generation serving",
        "same dimensions with different fingerprints remain partition-isolated",
        "premature activation is rejected and deprecated active space can roll back",
        "floating sentinel drift opens Provider circuit; vector fails and hybrid degrades to FTS",
        "offline mode blocks hosted calls; enabled mode without credentials fails explicitly",
        "Provider replacement space rebuilds entirely from local Chunks",
        "505 Connection changes split into bounded 500 + 5 batches and converge to ingested",
        "Schema 4 migration uses explicit Plan/Apply with a Root-local backup",
      ],
    },
    null,
    2,
  )}\n`,
);
await Bun.write(
  resolve(evidenceRoot, "live-summary.json"),
  `${JSON.stringify({ real_vault: realVaultEvidence, live_model: liveModelEvidence }, null, 2)}\n`,
);
await Bun.write(
  resolve(evidenceRoot, "root-tree.txt"),
  `${(await listTree(synthetic)).join("\n")}\n`,
);
await Bun.write(
  resolve(evidenceRoot, "summary.md"),
  `# Phase 4 verification summary

- Result: passed
- Scope: Schema 5 Model Registry/Invocation, trigram FTS Generation, immutable VectorSpace, sqlite-vec partitioning, Query Cache and text/vector/hybrid Search.
- Safety: create/activate/migrate/delete use Plan/Apply; offline blocks hosted calls; no API Key is persisted; scores never mix across fingerprints.
- Recovery: Vector batch and FTS swap process exits recover while active indexes keep serving; Provider drift degrades Hybrid to FTS.
- Real Vault: read-only Markdown connection from \`~/notes\` is archived under \`data/\`; only aggregate counts are copied into this evidence directory.
- Live Model: DashScope \`text-embedding-v4@1024\` completed build, verify, activate and Hybrid Search in \`data/test-runs/phase-4-live-model\` using a temporary process environment credential.
- Deferred: Graph/Claim signals and Graph fallback remain Phase 5; generic detached Job scheduling remains Phase 10.
`,
);
process.stdout.write(`Phase 4 verification passed; evidence: ${evidenceRoot}\n`);

async function verifyCoverageManifest() {
  const manifest = (await Bun.file(resolve("tests/coverage-manifest.json")).json()) as {
    commands?: Record<string, string[]>;
  };
  const missing = COMMAND_SPECS.map((spec) => spec.id).filter(
    (id) => !manifest.commands?.[id]?.length,
  );
  if (missing.length > 0) throw new Error(`Coverage manifest is missing: ${missing.join(", ")}`);
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

function measure(
  argv: string[],
  samples: number,
  targetP95: number,
  extraEnvironment: Record<string, string> = {},
) {
  const durations: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    const result = Bun.spawnSync(argv, {
      cwd: repository,
      env: { ...process.env, ...extraEnvironment },
      stdout: "ignore",
      stderr: "pipe",
    });
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
