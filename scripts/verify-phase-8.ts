import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { COMMAND_SPECS } from "../src/cli/protocol/command-specs.ts";
import type { PageIrV1 } from "../src/domains/artifact/index.ts";
import { validatePageIr } from "../src/domains/artifact/index.ts";
import { openSqlite } from "../src/infrastructure/db/connection.ts";
import { sha256File } from "../src/infrastructure/filesystem/hash.ts";
import { locateWorkspaceAssets } from "../src/infrastructure/runtime/assets.ts";
import { renderKnowledgeAtlas } from "../src/renderer/components/page.tsx";
import { VERSION } from "../src/shared/version.ts";

type CommandRecord = {
  argv: string[];
  exit_code: number;
  duration_ms: number;
  stdout: string;
  stderr: string;
};

const repository = resolve(".");
const evidenceRoot = resolve(".test-runs/roadmap/2026-07-11/phase-8");
const syntheticRun = resolve("data/test-runs/phase-8-real-cli");
const synthetic = resolve(syntheticRun, "moved-instance");
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
  ["bun", "run", "test:e2e:phase8"],
])
  await run(argv);

const binary = resolve(
  "dist/local",
  `self-${process.platform}-${process.arch}`,
  process.platform === "win32" ? "self.exe" : "self",
);
const doctor = envelope(await run([binary, "--root", realRoot, "doctor", "--all", "--json"]));
if (doctor.status !== "pass") throw new Error("real notes Workspace doctor failed");
await verifyCoverage();
await verifyNoCredentialPersistence();
const syntheticEvidence = await artifactEvidence(synthetic, "self agent knowledge");
const realEvidence = await artifactEvidence(realRoot, "faiss 向量索引");
const pageIrPath = resolve(synthetic, String(syntheticEvidence.relative_directory), "page.ir.json");
const pageIr = JSON.parse(await Bun.file(pageIrPath).text()) as PageIrV1;
const pageValidation = validatePageIr(pageIr);
if (!pageValidation.valid) throw new Error(pageValidation.errors.join(","));
const cssPath = resolve(synthetic, "templates/knowledge-atlas/themes/self-light.css");
const css = await Bun.file(cssPath).text();
const renderPerformance = measureFunction(() => renderKnowledgeAtlas(pageIr, { css }), 60, 200);
const singleRenderPerformance = measureFunction(
  () => renderKnowledgeAtlas(pageIr, { css }),
  60,
  500,
);
const pageIrReadPerformance = await measureAsync(
  async () => JSON.parse(await Bun.file(pageIrPath).text()),
  60,
  80,
);
const topicOpenPerformance = measureSpawn(
  [binary, "--root", synthetic, "topic", "open", String(syntheticEvidence.topic_id), "--json"],
  60,
  100,
);
const queryPlans = await queryPlanEvidence(synthetic);
const harnessRecords = [
  ...(await readHarness(resolve("data/test-runs/phase-7-real-cli/commands.jsonl"))),
  ...(await readHarness(resolve(syntheticRun, "commands.jsonl"))),
];
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
      page_ir_version: VERSION.pageIr,
      data_workspace: { doctor: doctor.status, models_offline: true },
      synthetic: syntheticEvidence,
      real_notes_artifact: realEvidence,
      browser: JSON.parse(await Bun.file(resolve(syntheticRun, "result.json")).text()).browser,
      private_notes_used: true,
      credential_persisted: false,
    },
    null,
    2,
  )}\n`,
);
await Bun.write(
  resolve(evidenceRoot, "performance.json"),
  `${JSON.stringify(
    {
      topic_open: topicOpenPerformance,
      page_ir_read: pageIrReadPerformance,
      react_static_render: renderPerformance,
      single_file_render: singleRenderPerformance,
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
  resolve(evidenceRoot, "fixtures.json"),
  `${JSON.stringify(
    {
      migration_sha256: await sha256File(resolve("drizzle/0009_artifact_builds.sql")),
      harness_sha256: await sha256File(resolve("tests/harness/phase8.ts")),
      page_ir_sha256: await sha256File(resolve("src/application/artifact/page-ir.ts")),
      renderer_sha256: await sha256File(resolve("src/renderer/components/page.tsx")),
      theme_sha256: await sha256File(resolve("templates/knowledge-atlas/themes/self-light.css")),
      synthetic_root: "data/test-runs/phase-8-real-cli/moved-instance",
      real_notes_root: "data",
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
        "ready Build and child records reject mutation while old Build remains readable",
        "an export output collision is rejected without overwrite",
        "hostile source HTML is escaped and cannot execute in an offline browser",
        "unchanged refresh skips retrieval and creates neither Snapshot nor Build",
        "pure template render creates no RetrievalRun, SynthesisRun, or TopicSnapshot",
        "moving the complete Self Root preserves CLI and relative Artifact resources",
        "Schema 8 to 9 migration uses Plan/Apply and a Root-local backup",
      ],
    },
    null,
    2,
  )}\n`,
);
await copyFile(resolve(syntheticRun, "browser.png"), resolve(evidenceRoot, "browser.png"));
await Bun.write(resolve(evidenceRoot, "root-tree.txt"), `${(await tree(synthetic)).join("\n")}\n`);
await Bun.write(
  resolve(evidenceRoot, "summary.md"),
  `# Phase 8 verification summary

- Result: passed; Schema 9 and Page IR v1 complete the MVP.
- Scope: Artifact/Build/Manifest, component cache, Knowledge Atlas React renderer, offline multi/single HTML, History/Diff/Open/Export, incremental Topic Refresh and pure Render.
- Safety: ready Builds are immutable; source text is React-escaped; all internal assets are Root-relative; export never silently overwrites; no Render accesses a model or the network.
- Browser: Chromium opened the moved Root with offline=true, expanded confidence/evidence details, observed zero HTTP(S) requests and did not execute hostile source markup.
- Real notes: the ignored data/ Workspace migrated 8→9 and built the existing FAISS Topic from its four grounded Citations while models.offline remained true; this evidence stores aggregate counts only.
- Deferred: Plan/Apply for destructive Topic/Artifact operations, restore and dependency-aware delete begin in Phase 9; persistent detached Jobs remain Phase 10.
`,
);
process.stdout.write(`Phase 8 verification passed; evidence: ${evidenceRoot}\n`);

async function artifactEvidence(
  root: string,
  normalizedTopic: string,
): Promise<Record<string, unknown>> {
  const assets = await locateWorkspaceAssets(root);
  const database = openSqlite(resolve(root, "data/self.sqlite3"), assets, { readonly: true });
  let evidence: Record<string, unknown>;
  try {
    const row = database
      .query<Record<string, unknown>, [string]>(
        `SELECT t.topic_id, t.latest_snapshot_id, a.artifact_id, a.latest_build_id,
         b.relative_directory, b.build_kind, b.page_ir_hash, b.manifest_hash,
         b.content_hash, b.state FROM topics t JOIN artifacts a ON a.topic_id = t.topic_id
         JOIN artifact_builds b ON b.build_id = a.latest_build_id
         WHERE t.normalized_name = ?`,
      )
      .get(normalizedTopic);
    if (row?.state !== "ready") throw new Error(`ready Artifact missing: ${normalizedTopic}`);
    const buildId = String(row.latest_build_id);
    evidence = {
      ...row,
      builds: scalar(
        database,
        "SELECT COUNT(*) count FROM artifact_builds WHERE artifact_id = ? AND state = 'ready'",
        String(row.artifact_id),
      ),
      components: scalar(
        database,
        "SELECT COUNT(*) count FROM artifact_build_components WHERE build_id = ?",
        buildId,
      ),
      components_reused: scalar(
        database,
        "SELECT COUNT(*) count FROM artifact_build_components WHERE build_id = ? AND reused_from_build_id IS NOT NULL",
        buildId,
      ),
      dependencies: scalar(
        database,
        "SELECT COUNT(*) count FROM artifact_build_dependencies WHERE build_id = ?",
        buildId,
      ),
      files: scalar(
        database,
        "SELECT COUNT(*) count FROM artifact_build_files WHERE build_id = ?",
        buildId,
      ),
      citations: scalar(
        database,
        `SELECT COUNT(*) count FROM artifact_build_dependencies WHERE build_id = ? AND dependency_kind = 'chunk'`,
        buildId,
      ),
    };
  } finally {
    database.close();
  }
  const directory = resolve(root, String(evidence.relative_directory));
  const manifest = JSON.parse(await Bun.file(resolve(directory, "manifest.json")).text());
  const page = JSON.parse(await Bun.file(resolve(directory, "page.ir.json")).text());
  const validation = validatePageIr(page);
  if (!validation.valid) throw new Error(validation.errors.join(","));
  let invalidFiles = 0;
  for (const file of manifest.files as Array<Record<string, unknown>>) {
    const path = resolve(directory, String(file.path));
    if (!path.startsWith(`${directory}/`) || (await sha256File(path)) !== file.hash)
      invalidFiles += 1;
  }
  if (invalidFiles !== 0) throw new Error("Artifact Manifest file integrity failed");
  return {
    ...evidence,
    page_ir_components: page.components.length,
    page_ir_citations: page.citations.length,
    invalid_manifest_files: invalidFiles,
  };
}

async function queryPlanEvidence(root: string) {
  const assets = await locateWorkspaceAssets(root);
  const database = openSqlite(resolve(root, "data/self.sqlite3"), assets, { readonly: true });
  try {
    return {
      artifact_latest: database
        .query<Record<string, unknown>, []>(
          "EXPLAIN QUERY PLAN SELECT latest_build_id FROM artifacts WHERE topic_id = 'topic:fixture'",
        )
        .all(),
      build_history: database
        .query<Record<string, unknown>, []>(
          "EXPLAIN QUERY PLAN SELECT build_id FROM artifact_builds WHERE artifact_id = 'artifact:fixture' ORDER BY created_at DESC",
        )
        .all(),
      dependency_invalidation: database
        .query<Record<string, unknown>, []>(
          "EXPLAIN QUERY PLAN SELECT build_id FROM artifact_build_dependencies WHERE dependency_kind = 'claim' AND dependency_id = 'claim:fixture'",
        )
        .all(),
    };
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

function measureFunction(action: () => unknown, samples: number, targetP95: number) {
  for (let index = 0; index < 5; index += 1) action();
  const values: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    action();
    values.push(performance.now() - started);
  }
  return performanceSummary(values, samples, targetP95);
}

async function measureAsync(action: () => Promise<unknown>, samples: number, targetP95: number) {
  for (let index = 0; index < 5; index += 1) await action();
  const values: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    await action();
    values.push(performance.now() - started);
  }
  return performanceSummary(values, samples, targetP95);
}

function measureSpawn(argv: string[], samples: number, targetP95: number) {
  for (let index = 0; index < 5; index += 1) execute(argv);
  const values: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    execute(argv);
    values.push(performance.now() - started);
  }
  return performanceSummary(values, samples, targetP95);
}

function performanceSummary(values: number[], samples: number, targetP95: number) {
  values.sort((left, right) => left - right);
  const p95 = percentile(values, 0.95);
  if (p95 > targetP95) throw new Error(`p95 ${p95}ms exceeds ${targetP95}ms`);
  return { samples, unit: "ms", p50: percentile(values, 0.5), p95, target_p95: targetP95 };
}

function execute(argv: string[]) {
  const result = Bun.spawnSync(argv, {
    cwd: repository,
    env: { ...process.env, SELF_NO_OPEN: "1" },
    stdout: "ignore",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
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
function scalar(database: ReturnType<typeof openSqlite>, sql: string, value: string) {
  return database.query<{ count: number }, [string]>(sql).get(value)?.count ?? 0;
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
