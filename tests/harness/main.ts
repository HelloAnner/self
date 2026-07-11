import { mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { runPackageSpike } from "./package-spike.ts";

const [action, suite] = process.argv.slice(2);
if (action !== "suite" || suite !== "fast") {
  throw new Error("Usage: bun run tests/harness/main.ts suite fast");
}

const runRoot = resolve("data/test-runs/phase-0-real-cli");
await rm(runRoot, { recursive: true, force: true });
await mkdir(runRoot, { recursive: true });

const build = Bun.spawnSync(["bun", "run", "build"], { stdout: "pipe", stderr: "pipe" });
if (build.exitCode !== 0) throw new Error(build.stderr.toString());

const binaryName = process.platform === "win32" ? "self.exe" : "self";
const executable = resolve("dist/local", `self-${process.platform}-${process.arch}`, binaryName);
const noWriteRoot = resolve(runRoot, "version-no-write");
await mkdir(noWriteRoot, { recursive: true });
const result = Bun.spawnSync([executable, "version", "--json"], {
  cwd: noWriteRoot,
  env: isolatedEnvironment(runRoot),
  stdout: "pipe",
  stderr: "pipe",
});
if (result.exitCode !== 0) throw new Error(result.stderr.toString());

const envelope = JSON.parse(result.stdout.toString());
if (!envelope.ok || envelope.data.cli_version !== "0.1.0") {
  throw new Error("Packaged CLI returned an invalid version envelope");
}
if ((await readdir(noWriteRoot)).length !== 0) {
  throw new Error("Root-free version command wrote into its working directory");
}

await Bun.write(
  resolve(runRoot, "run.json"),
  `${JSON.stringify({ suite, status: "passed", envelope }, null, 2)}\n`,
);
await runPackageSpike(resolve(runRoot, "clean-machine"), executable);
process.stdout.write(`Fast E2E passed: ${runRoot}\n`);

function isolatedEnvironment(root: string): Record<string, string> {
  return {
    HOME: resolve(root, "home"),
    TMPDIR: resolve(root, "tmp"),
    XDG_CACHE_HOME: resolve(root, "cache/xdg"),
    XDG_CONFIG_HOME: resolve(root, "home/.config"),
    XDG_DATA_HOME: resolve(root, "home/.local/share"),
    PATH: process.env.PATH ?? "",
  };
}
