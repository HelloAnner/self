import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256File } from "../src/infrastructure/filesystem/hash.ts";
import { VERSION } from "../src/shared/version.ts";

const root = resolve("dist/release", `v${VERSION.cli}`);
const runRoot = resolve("data/test-runs/release-gate");
const binaryRoot = resolve("dist/local", `self-${process.platform}-${process.arch}`);
const binary = resolve(binaryRoot, process.platform === "win32" ? "self.exe" : "self");
await rm(runRoot, { recursive: true, force: true });
await Promise.all(
  ["home", "tmp", "cache", "workspace"].map((name) =>
    mkdir(resolve(runRoot, name), { recursive: true }),
  ),
);

await verifyChecksums(binaryRoot);
for (const required of [
  "build-manifest.json",
  "checksums.txt",
  "sbom.cdx.json",
  "LICENSE",
  "LICENSES/THIRD_PARTY.md",
]) {
  if (!(await Bun.file(resolve(binaryRoot, required)).exists()))
    throw new Error(`release file missing: ${required}`);
}

const standaloneEnv = cleanEnvironment(runRoot);
ok(run([binary, "version", "--json"], standaloneEnv), "standalone version");
const workspace = resolve(runRoot, "workspace");
await rm(workspace, { recursive: true, force: true });
ok(run([binary, "init", workspace, "--offline", "--json"], standaloneEnv), "standalone init");
ok(
  run([binary, "--root", workspace, "doctor", "--all", "--json"], standaloneEnv),
  "standalone doctor",
);
const backupJob = data(
  ok(
    run([binary, "--root", workspace, "backup", "create", "--wait", "--json"], standaloneEnv),
    "standalone backup",
  ),
);
const backupId = String((backupJob.result as Record<string, unknown>).backup_id);
const restored = resolve(runRoot, "restored");
const plan = data(
  ok(
    run(
      [
        binary,
        "--root",
        workspace,
        "backup",
        "restore",
        backupId,
        "--to",
        restored,
        "--plan",
        "--json",
      ],
      standaloneEnv,
    ),
    "standalone restore plan",
  ),
);
ok(
  run([binary, "apply", String(plan.plan_id), "--root", workspace, "--json"], standaloneEnv),
  "standalone restore",
);
ok(
  run([binary, "--root", restored, "verify", "--deep", "--wait", "--json"], standaloneEnv),
  "restored verify",
);

const npmRoot = resolve(root, "npm");
const platformDirectory = platformPackageDirectory();
const platformTarball = await onlyTarball(resolve(npmRoot, platformDirectory));
const metaTarball = await onlyTarball(resolve(npmRoot, "self"));
const installRoot = resolve(runRoot, "npm-install");
await mkdir(installRoot, { recursive: true });
const npmEnv = {
  ...process.env,
  HOME: resolve(runRoot, "home"),
  npm_config_cache: resolve(runRoot, "cache/npm"),
};
ok(
  run(
    [
      "npm",
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      installRoot,
      platformTarball,
      metaTarball,
    ],
    npmEnv,
  ),
  "npm install",
);
const launcher = resolve(installRoot, "node_modules/@helloanner/self/bin/self.js");
const node = Bun.which("node");
if (!node) throw new Error("Node.js is required for npm launcher verification");
ok(run([node, launcher, "version", "--json"], npmEnv), "npm launcher");
ok(
  run(
    [
      "npm",
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      installRoot,
      platformTarball,
      metaTarball,
    ],
    npmEnv,
  ),
  "npm same-version upgrade",
);
ok(
  run(["npm", "uninstall", "--prefix", installRoot, "@helloanner/self", packageName()], npmEnv),
  "npm uninstall",
);
if (!(await Bun.file(resolve(workspace, "self.toml")).exists()))
  throw new Error("CLI uninstall removed the Workspace Root");

await Bun.write(
  resolve(runRoot, "result.json"),
  `${JSON.stringify(
    {
      status: "passed",
      version: VERSION.cli,
      platform: `${process.platform}-${process.arch}`,
      standalone_without_node_or_bun_on_path: true,
      backup_restore: true,
      npm_install_upgrade_uninstall_root_preserved: true,
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(`Release gate passed: ${runRoot}\n`);

async function verifyChecksums(directory: string) {
  const lines = (await Bun.file(resolve(directory, "checksums.txt")).text()).trim().split("\n");
  for (const line of lines) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/u.exec(line);
    if (!match) throw new Error(`invalid checksum line: ${line}`);
    const actual = await sha256File(resolve(directory, match[2] ?? ""));
    if (actual !== match[1]) throw new Error(`checksum mismatch: ${match[2]}`);
  }
}

function run(argv: string[], env: Record<string, string | undefined>) {
  return Bun.spawnSync(argv, { env, stdout: "pipe", stderr: "pipe" });
}

function ok(result: ReturnType<typeof Bun.spawnSync>, label: string) {
  if (result.exitCode !== 0)
    throw new Error(
      `${label} failed: ${result.stdout?.toString() ?? ""}${result.stderr?.toString() ?? ""}`,
    );
  return result.stdout?.toString() ?? "";
}

function data(stdout: string): Record<string, unknown> {
  const parsed = JSON.parse(stdout) as { ok: boolean; data: Record<string, unknown> };
  if (!parsed.ok) throw new Error(stdout);
  return parsed.data;
}

function cleanEnvironment(root: string): Record<string, string> {
  return {
    HOME: resolve(root, "home"),
    TMPDIR: resolve(root, "tmp"),
    PATH: process.platform === "win32" ? (process.env.SystemRoot ?? "C:\\Windows") : "",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
}

async function onlyTarball(directory: string): Promise<string> {
  const glob = new Bun.Glob("*.tgz");
  const paths = [...glob.scanSync(directory)];
  if (paths.length !== 1) throw new Error(`Expected one npm tarball in ${directory}`);
  return resolve(directory, paths[0] ?? "");
}

function platformPackageDirectory(): string {
  return process.platform === "win32" ? "windows-x64" : `${process.platform}-${process.arch}`;
}

function packageName(): string {
  return `@helloanner/self-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
}
