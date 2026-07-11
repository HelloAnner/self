import { mkdir, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

type CommandRecord = {
  argv: string[];
  exit_code: number;
  duration_ms: number;
  stdout: string;
  stderr: string;
};

const evidenceRoot = resolve(".test-runs/roadmap/2026-07-11/phase-0");
const testsRoot = resolve(evidenceRoot, "tests");
const commandsPath = resolve(evidenceRoot, "commands.jsonl");
const records: CommandRecord[] = [];

await mkdir(testsRoot, { recursive: true });
await mkdir(resolve(evidenceRoot, "failures"), { recursive: true });

const commands = [
  ["bun", "--version"],
  ["bun", "install", "--frozen-lockfile", "--registry", "https://registry.npmjs.org"],
  ["bun", "run", "typecheck"],
  ["bun", "run", "lint"],
  ["bun", "run", "check:size"],
  ["bun", "run", "db:check"],
  ["bun", "test", "--reporter=junit", `--reporter-outfile=${resolve(testsRoot, "junit.xml")}`],
  ["bun", "run", "build"],
  ["bun", "run", "test:e2e"],
  ["bun", "run", "spike:sqlite"],
] as const;

for (const command of commands) await run([...command]);

const binaryName = process.platform === "win32" ? "self.exe" : "self";
const executable = resolve("dist/local", `self-${process.platform}-${process.arch}`, binaryName);
await run([executable, "version"]);
const versionRecord = await run([executable, "version", "--json"]);

await Bun.write(commandsPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

const versionEnvelope = JSON.parse(versionRecord.stdout);
await Bun.write(
  resolve(evidenceRoot, "verify.json"),
  `${JSON.stringify(
    {
      status: "passed",
      platform: process.platform,
      arch: process.arch,
      bun: Bun.version,
      version: versionEnvelope.data,
      gates: records.map(({ argv, exit_code, duration_ms }) => ({ argv, exit_code, duration_ms })),
    },
    null,
    2,
  )}\n`,
);

await Bun.write(
  resolve(evidenceRoot, "fixtures.json"),
  `${JSON.stringify(
    {
      sqlite_spike_source_sha256: await hashFile(
        "src/infrastructure/db/spikes/sqlite-capabilities.ts",
      ),
      package_lock_sha256: await hashFile("bun.lock"),
      e2e_result: "data/test-runs/phase-0-real-cli/run.json",
      clean_machine_result: "data/test-runs/phase-0-real-cli/clean-machine/result.json",
    },
    null,
    2,
  )}\n`,
);

const performanceResult = measureVersion(executable, 30);
await Bun.write(
  resolve(evidenceRoot, "performance.json"),
  `${JSON.stringify(performanceResult, null, 2)}\n`,
);

const tree = await listTree(resolve("data/test-runs/phase-0-real-cli"));
await Bun.write(resolve(evidenceRoot, "root-tree.txt"), `${tree.join("\n")}\n`);
process.stdout.write(`Phase 0 verification passed; evidence: ${evidenceRoot}\n`);

async function run(argv: string[]): Promise<CommandRecord> {
  const started = performance.now();
  const process = Bun.spawn(argv, { cwd: resolve("."), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
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

async function hashFile(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).arrayBuffer());
  return hasher.digest("hex");
}

function measureVersion(executable: string, samples: number) {
  const durations: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    const result = Bun.spawnSync([executable, "version", "--json"], {
      stdout: "ignore",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    durations.push(performance.now() - started);
  }
  durations.sort((left, right) => left - right);
  return {
    command: "self version --json",
    samples,
    unit: "ms",
    p50: percentile(durations, 0.5),
    p95: percentile(durations, 0.95),
    min: durations[0],
    max: durations.at(-1),
    target_p95: 30,
  };
}

function percentile(values: number[], ratio: number): number | undefined {
  const index = Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1);
  const value = values[index];
  return value === undefined ? undefined : Math.round(value * 100) / 100;
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
