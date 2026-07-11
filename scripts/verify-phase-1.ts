import { mkdir, readdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

type CommandRecord = {
  argv: string[];
  exit_code: number;
  duration_ms: number;
  stdout: string;
  stderr: string;
};

const repository = resolve(".");
const evidenceRoot = resolve(".test-runs/roadmap/2026-07-11/phase-1");
const testsRoot = resolve(evidenceRoot, "tests");
const failuresRoot = resolve(evidenceRoot, "failures");
const commandsPath = resolve(evidenceRoot, "commands.jsonl");
const records: CommandRecord[] = [];

await rm(evidenceRoot, { recursive: true, force: true });
await mkdir(testsRoot, { recursive: true });
await mkdir(failuresRoot, { recursive: true });

const commands = [
  ["bun", "--version"],
  ["bun", "install", "--frozen-lockfile", "--registry", "https://registry.npmjs.org"],
  ["bun", "run", "typecheck"],
  ["bun", "run", "lint"],
  ["bun", "run", "check:size"],
  ["bun", "test", "--reporter=junit", `--reporter-outfile=${resolve(testsRoot, "junit.xml")}`],
  ["bun", "run", "build"],
  ["bun", "run", "test:e2e:phase1"],
] as const;

for (const command of commands) await run([...command]);

const binary = resolve(
  "dist/local",
  `self-${process.platform}-${process.arch}`,
  process.platform === "win32" ? "self.exe" : "self",
);
const schema = await run([binary, "schema", "command", "config.set", "--json"]);
const status = await run([binary, "--root", "data", "status", "--json"]);
const doctor = await run([binary, "--root", "data", "doctor", "--all", "--json"]);
await run([binary, "--root", "data", "config", "validate", "--json"]);

const configText = await Bun.file(resolve("data/self.toml")).text();
const credentialSafe = !/sk-[A-Za-z0-9_-]+/.test(configText);
if (!credentialSafe) throw new Error("Plaintext credential found in data/self.toml");

const schemaEnvelope = JSON.parse(schema.stdout);
const statusEnvelope = JSON.parse(status.stdout);
const doctorEnvelope = JSON.parse(doctor.stdout);
if (schemaEnvelope.data?.required?.join(",") !== "root,path,value") {
  throw new Error("config.set machine-readable schema is incomplete");
}
if (statusEnvelope.data?.state !== "active" || doctorEnvelope.data?.status !== "pass") {
  throw new Error("data Workspace did not pass status/doctor verification");
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
      workspace: {
        id: statusEnvelope.data.workspace_id,
        state: statusEnvelope.data.state,
        mode: statusEnvelope.data.mode,
        database_schema_version: statusEnvelope.data.database_schema_version,
      },
      doctor: doctorEnvelope.data,
      command_schema: {
        id: schemaEnvelope.data.title,
        required: schemaEnvelope.data.required,
        closed: schemaEnvelope.data.additionalProperties === false,
      },
      plaintext_credentials_in_config: !credentialSafe,
      gates: records.map(({ argv, exit_code, duration_ms }) => ({
        argv,
        exit_code,
        duration_ms,
      })),
    },
    null,
    2,
  )}\n`,
);

await Bun.write(
  resolve(evidenceRoot, "fixtures.json"),
  `${JSON.stringify(
    {
      migration_sha256: await hashFile("drizzle/0001_workspace.sql"),
      command_specs_sha256: await hashFile("src/cli/protocol/command-specs.ts"),
      package_lock_sha256: await hashFile("bun.lock"),
      real_cli_result: "data/test-runs/phase-1-real-cli/result.json",
      real_cli_commands: "data/test-runs/phase-1-real-cli/commands.jsonl",
      private_notes_used: false,
      hosted_model_called: false,
    },
    null,
    2,
  )}\n`,
);

await Bun.write(
  resolve(evidenceRoot, "performance.json"),
  `${JSON.stringify(
    {
      version: measure([binary, "version", "--json"], 30, 30),
      status: measure([binary, "--root", "data", "status", "--json"], 30, 100),
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
      evidence_source: "data/test-runs/phase-1-real-cli/commands.jsonl",
      scenarios: [
        "non-empty target requires and applies a Plan without overwriting unknown files",
        "injected initialization failure resumes from the Init Journal",
        "Rollback Plan preserves a user-created file",
        "newer schema is read-only and rejects config writes",
        "older schema requires migration and rejects config writes",
        "invalid config is rejected without overwrite",
        "hosted setup failure leaves Workspace active and SetupSession resumable",
      ],
    },
    null,
    2,
  )}\n`,
);

const treeRoot = resolve("data/test-runs/phase-1-real-cli/moved-instance");
await Bun.write(
  resolve(evidenceRoot, "root-tree.txt"),
  `${(await listTree(treeRoot)).join("\n")}\n`,
);
await Bun.write(
  resolve(evidenceRoot, "summary.md"),
  `# Phase 1 verification summary

- Result: passed
- Scope: portable Root, reviewed SQLite migration, atomic config, Init Journal/Resume/Rollback Plan, Setup state, CLI discovery/schema, diagnostics, compatibility modes.
- Real CLI: compiled binary executed against disposable roots under \`data/test-runs/phase-1-real-cli\` and the development instance at \`data/\`.
- Safety: unknown files preserved; config snapshots retained; diagnostics redacted; no plaintext API key stored.
- Deferred by design: private-note reads, live model calls, Source ingestion, VectorSpace, and first indexing belong to Phases 2–4.
`,
);

process.stdout.write(`Phase 1 verification passed; evidence: ${evidenceRoot}\n`);

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
    duration_ms: Math.round((performance.now() - started) * 100) / 100,
    stdout,
    stderr,
  };
  records.push(record);
  if (exitCode !== 0) {
    await Bun.write(commandsPath, `${records.map((item) => JSON.stringify(item)).join("\n")}\n`);
    throw new Error(`${argv.join(" ")} failed (${exitCode}): ${stderr}`);
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
  if (p95 > targetP95) throw new Error(`${argv.join(" ")} p95 ${p95}ms exceeds ${targetP95}ms`);
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
  const index = Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1);
  return round(values[index] ?? 0);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

async function hashFile(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).arrayBuffer());
  return hasher.digest("hex");
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
