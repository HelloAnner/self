import { cp, mkdir, readdir, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256File } from "../../src/infrastructure/filesystem/hash.ts";

type CommandRecord = {
  argv: string[];
  cwd: string;
  exit_code: number;
  duration_ms: number;
  stdout: string;
  stderr: string;
};

const repository = resolve(".");
const runRoot = resolve("data/test-runs/phase-1-real-cli");
const records: CommandRecord[] = [];
assertTestPath(runRoot);
await rm(runRoot, { recursive: true, force: true });
await mkdir(runRoot, { recursive: true });

await run(["bun", "run", "build"], repository);
const binary = resolve(
  "dist/local",
  `self-${process.platform}-${process.arch}`,
  process.platform === "win32" ? "self.exe" : "self",
);

const noWrite = resolve(runRoot, "system-no-write");
await mkdir(noWrite, { recursive: true });
expectOkJson(await run([binary, "doctor", "--system", "--json"], noWrite));
expectOkJson(await run([binary, "system", "info", "--json"], noWrite));
const commands = expectOkJson(await run([binary, "commands", "--json"], noWrite));
assert(Array.isArray(commands.data), "command discovery did not return a list");
const configSetSchema = expectOkJson(
  await run([binary, "schema", "command", "config.set", "--json"], noWrite),
);
assert(
  Array.isArray(configSetSchema.data.required) && configSetSchema.data.required.length === 3,
  "config.set command schema is incomplete",
);
await run([binary, "completion", "zsh"], noWrite);
assert((await readdir(noWrite)).length === 0, "root-free doctor wrote into its working directory");

const instance = resolve(runRoot, "instance");
const initialized = expectOkJson(
  await run([binary, "init", instance, "--offline", "--json"], repository),
);
assert(initialized.data.state === "active", "init did not return active");
const databaseHash = await sha256File(resolve(instance, "data/self.sqlite3"));
const repeated = expectOkJson(
  await run([binary, "init", instance, "--offline", "--json"], repository),
);
assert(
  repeated.data.workspace_id === initialized.data.workspace_id,
  "idempotent init changed Workspace ID",
);
assert(
  repeated.data.operation_id === initialized.data.operation_id,
  "idempotent init changed Operation ID",
);
assert(
  (await sha256File(resolve(instance, "data/self.sqlite3"))) === databaseHash,
  "idempotent init changed database",
);

const nested = resolve(instance, "content/notes/nested");
await mkdir(nested, { recursive: true });
const discovered = expectOkJson(await run([binary, "status", "--json"], nested));
assert(
  discovered.data.workspace_id === initialized.data.workspace_id,
  "upward Root discovery failed",
);

const provider = JSON.stringify({
  protocol: "openai-compatible",
  base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  api_key_env: "SELF_DASHSCOPE_API_KEY",
});
expectOkJson(
  await run(
    [binary, "--root", instance, "config", "set", "models.providers.dashscope", provider, "--json"],
    repository,
  ),
);
expectOkJson(await run([binary, "--root", instance, "config", "list", "--json"], repository));
const loggingLevel = expectOkJson(
  await run([binary, "--root", instance, "config", "get", "logging.level", "--json"], repository),
);
assert(loggingLevel.data.value === "info", "config get returned an unexpected value");
expectOkJson(await run([binary, "--root", instance, "config", "validate", "--json"], repository));
const configText = await Bun.file(resolve(instance, "self.toml")).text();
assert(
  configText.includes("SELF_DASHSCOPE_API_KEY"),
  "provider environment reference was not saved",
);
assert(!configText.includes("sk-"), "plaintext API key leaked into self.toml");
const unset = expectOkJson(
  await run(
    [binary, "--root", instance, "config", "unset", "models.providers.dashscope", "--json"],
    repository,
  ),
);
assert(unset.data.value === null, "config unset did not return null");
assert(
  (await readdir(resolve(instance, "runtime/config-history"))).length === 3,
  "config snapshots are incomplete",
);

const moved = resolve(runRoot, "moved-instance");
await rename(instance, moved);
const movedStatus = expectOkJson(
  await run([binary, "--root", moved, "status", "--json"], repository),
);
assert(
  movedStatus.data.workspace_id === initialized.data.workspace_id,
  "moved Workspace changed identity",
);
assert(movedStatus.data.mode === "read_write", "active Workspace did not report write mode");
const components = expectOkJson(
  await run([binary, "--root", moved, "component", "list", "--json"], repository),
);
assert(Array.isArray(components.data), "component list did not return a list");
expectOkJson(
  await run([binary, "--root", moved, "component", "show", "sqlite", "--json"], repository),
);
expectOkJson(
  await run([binary, "--root", moved, "component", "verify", "--all", "--json"], repository),
);
expectOkJson(await run([binary, "--root", moved, "capability", "list", "--json"], repository));
expectOkJson(
  await run([binary, "--root", moved, "capability", "show", "fts", "--json"], repository),
);
const diagnostics = expectOkJson(
  await run([binary, "--root", moved, "diagnostics", "collect", "--redact", "--json"], repository),
);
const diagnosticsId = requireString(diagnostics.data.diagnostics_id);
const diagnosticsShown = expectOkJson(
  await run([binary, "--root", moved, "diagnostics", "show", diagnosticsId, "--json"], repository),
);
assert(
  !JSON.stringify(diagnosticsShown.data).includes("SELF_DASHSCOPE_API_KEY"),
  "diagnostics leaked provider configuration",
);
const diagnosticsVerified = expectOkJson(
  await run(
    [binary, "--root", moved, "diagnostics", "verify", diagnosticsId, "--json"],
    repository,
  ),
);
assert(diagnosticsVerified.data.valid === true, "diagnostics manifest verification failed");

const nonempty = resolve(runRoot, "nonempty");
await mkdir(nonempty, { recursive: true });
await Bun.write(resolve(nonempty, "keep.txt"), "keep");
expectErrorJson(
  await run([binary, "init", nonempty, "--json"], repository, 10),
  "init_requires_plan",
);
const initPlan = expectOkJson(
  await run([binary, "init", nonempty, "--plan", "--json"], repository),
);
expectOkJson(
  await run(
    [binary, "--root", nonempty, "apply", requireString(initPlan.data.plan_id), "--json"],
    repository,
  ),
);
assert(
  (await Bun.file(resolve(nonempty, "keep.txt")).text()) === "keep",
  "Init Plan overwrote unknown file",
);

const recovery = resolve(runRoot, "recovery");
await run(["bun", "run", "tests/helpers/fail-init.ts", recovery, "runtime_assets"], repository, 20);
assert(
  !(await Bun.file(resolve(recovery, "self.toml")).exists()),
  "failed init published self.toml",
);
const resumed = expectOkJson(await run([binary, "init", "resume", recovery, "--json"], repository));
assert(resumed.data.resumed === true, "CLI resume did not report resumed state");

const rollback = resolve(runRoot, "rollback");
await run(["bun", "run", "tests/helpers/fail-init.ts", rollback, "directories"], repository, 20);
await Bun.write(resolve(rollback, "user-file.txt"), "preserve");
const rollbackPlan = expectOkJson(
  await run([binary, "init", "rollback", rollback, "--plan", "--json"], repository),
);
expectOkJson(
  await run(
    [binary, "--root", rollback, "apply", requireString(rollbackPlan.data.plan_id), "--json"],
    repository,
  ),
);
assert(
  (await Bun.file(resolve(rollback, "user-file.txt")).text()) === "preserve",
  "rollback deleted user file",
);

const newer = resolve(runRoot, "newer-schema");
await cp(moved, newer, { recursive: true });
await run(["bun", "run", "tests/helpers/set-schema-version.ts", newer, "4"], repository);
const newerStatus = expectOkJson(
  await run([binary, "--root", newer, "status", "--json"], repository),
);
assert(newerStatus.data.state === "read_only", "newer schema did not enter read-only diagnostics");
assert(newerStatus.data.mode === "read_only", "newer schema did not report read-only mode");
expectErrorJson(
  await run(
    [binary, "--root", newer, "config", "set", "logging.level", "debug", "--json"],
    repository,
    5,
  ),
  "workspace_format_too_new",
);

const older = resolve(runRoot, "older-schema");
await cp(moved, older, { recursive: true });
await run(["bun", "run", "tests/helpers/set-schema-version.ts", older, "1"], repository);
const olderStatus = expectOkJson(
  await run([binary, "--root", older, "status", "--json"], repository),
);
assert(olderStatus.data.state === "needs_migration", "older schema did not require migration");
assert(olderStatus.data.mode === "read_only", "older schema did not report read-only mode");
expectErrorJson(
  await run(
    [binary, "--root", older, "config", "set", "logging.level", "debug", "--json"],
    repository,
    5,
  ),
  "workspace_migration_required",
);

const invalid = resolve(runRoot, "invalid-config");
await cp(moved, invalid, { recursive: true });
await Bun.write(
  resolve(invalid, "self.toml"),
  `${await Bun.file(resolve(invalid, "self.toml")).text()}\nunknown_key = true\n`,
);
const invalidHash = await sha256File(resolve(invalid, "self.toml"));
expectErrorJson(
  await run([binary, "--root", invalid, "config", "validate", "--json"], repository, 5),
  "config_invalid",
);
assert(
  (await sha256File(resolve(invalid, "self.toml"))) === invalidHash,
  "validation overwrote invalid config",
);

expectErrorJson(
  await run([binary, "--init", "--root", resolve(runRoot, "interactive"), "--json"], repository, 2),
  "interactive_json_conflict",
);
expectErrorJson(
  await run([binary, "--root", moved, "setup", "--interactive", "--json"], repository, 2),
  "interactive_json_conflict",
);
const specPath = resolve(runRoot, "offline-setup.toml");
await Bun.write(
  specPath,
  `format_version = 1\nroot = "${resolve(runRoot, "spec-instance")}"\nprofile = "offline"\noffline = true\n`,
);
expectOkJson(await run([binary, "setup", "plan", "--spec", specPath, "--json"], repository));

const hosted = resolve(runRoot, "hosted-failure");
await run(["bun", "run", "tests/helpers/fail-hosted-setup.ts", hosted], repository, 6);
const hostedStatus = expectOkJson(
  await run([binary, "--root", hosted, "status", "--json"], repository),
);
assert(hostedStatus.data.state === "active", "model setup failure damaged Workspace");
const setupStatus = expectOkJson(
  await run([binary, "--root", hosted, "setup", "status", "--json"], repository),
);
assert(setupStatus.data.state === "waiting_for_user", "hosted setup was not resumable");
expectErrorJson(
  await run([binary, "--root", hosted, "setup", "resume", "--json"], repository, 2),
  "interactive_json_conflict",
);

await Bun.write(
  resolve(runRoot, "commands.jsonl"),
  `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
);
await Bun.write(
  resolve(runRoot, "result.json"),
  `${JSON.stringify({ status: "passed", commands: records.length }, null, 2)}\n`,
);
process.stdout.write(`Phase 1 real CLI E2E passed: ${runRoot}\n`);

async function run(argv: string[], cwd: string, expected = 0): Promise<CommandRecord> {
  const started = performance.now();
  const child = Bun.spawn(argv, {
    cwd,
    env: isolatedEnvironment(),
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
    cwd,
    exit_code: exitCode,
    duration_ms: Math.round((performance.now() - started) * 100) / 100,
    stdout,
    stderr,
  };
  records.push(record);
  if (exitCode !== expected)
    throw new Error(`${argv.join(" ")} exited ${exitCode}, expected ${expected}: ${stderr}`);
  return record;
}

function expectOkJson(record: CommandRecord): { data: Record<string, unknown> } {
  const value = JSON.parse(record.stdout);
  assert(value.ok === true, `expected success envelope: ${record.stdout}`);
  return value;
}

function expectErrorJson(record: CommandRecord, code: string): void {
  const value = JSON.parse(record.stdout);
  assert(value.ok === false && value.error?.code === code, `expected ${code}: ${record.stdout}`);
}

function isolatedEnvironment(): Record<string, string> {
  return {
    HOME: resolve(runRoot, "home"),
    TMPDIR: resolve(runRoot, "tmp"),
    XDG_CACHE_HOME: resolve(runRoot, "cache/xdg"),
    XDG_CONFIG_HOME: resolve(runRoot, "home/.config"),
    XDG_DATA_HOME: resolve(runRoot, "home/.local/share"),
    PATH: process.env.PATH ?? "",
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertTestPath(path: string): void {
  if (!path.startsWith(resolve("data/test-runs"))) throw new Error(`Unsafe test path: ${path}`);
}

function requireString(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a string value in JSON envelope");
  return value;
}
