import { cp, mkdir, rm } from "node:fs/promises";
import { basename, delimiter, dirname, parse, resolve } from "node:path";
import { VERSION } from "../../src/shared/version.ts";

export async function runPackageSpike(root: string, executable: string): Promise<void> {
  const platformKey = platformDirectory();
  const platformStage = resolve(root, "stage/platform");
  const metaStage = resolve(root, "stage/meta");
  const installRoot = resolve(root, "install");

  await rm(root, { recursive: true, force: true });
  await mkdir(platformStage, { recursive: true });
  await mkdir(metaStage, { recursive: true });
  await mkdir(installRoot, { recursive: true });

  await cp(
    resolve("packages/platforms", platformKey, "package.json"),
    resolve(platformStage, "package.json"),
  );
  await cp(dirname(executable), platformStage, { recursive: true });
  await mkdir(resolve(platformStage, "bin"), { recursive: true });
  await cp(executable, resolve(platformStage, "bin", basename(executable)));
  await cp("packages/npm-self", metaStage, { recursive: true });
  await cp("LICENSE", resolve(platformStage, "LICENSE"));
  await cp("LICENSE", resolve(metaStage, "LICENSE"));

  const platformTarball = pack(platformStage);
  const metaTarball = pack(metaStage);
  const install = Bun.spawnSync(
    [
      "npm",
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--workspaces=false",
      "--prefix",
      installRoot,
      platformTarball,
      metaTarball,
    ],
    { cwd: parse(root).root, env: npmEnvironment(root), stdout: "pipe", stderr: "pipe" },
  );
  if (install.exitCode !== 0) throw new Error(install.stderr.toString());

  const launcher = resolve(installRoot, "node_modules/@helloanner/self/bin/self.js");
  const node = Bun.which("node");
  if (!node) throw new Error("Node.js is required to test the npm launcher");
  const result = Bun.spawnSync([node, launcher, "version", "--json"], {
    cwd: installRoot,
    env: launcherEnvironment(root),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());

  const envelope = JSON.parse(result.stdout.toString());
  if (!envelope.ok || envelope.data.cli_version !== VERSION.cli) {
    throw new Error("npm meta-package did not execute the platform binary");
  }

  await Bun.write(
    resolve(root, "result.json"),
    `${JSON.stringify({ status: "passed", platformKey, envelope }, null, 2)}\n`,
  );
}

function pack(directory: string): string {
  const result = Bun.spawnSync(["npm", "pack", "--json"], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  const output = JSON.parse(result.stdout.toString()) as [{ filename: string }];
  const filename = output[0]?.filename;
  if (!filename) throw new Error(`npm pack produced no tarball for ${basename(directory)}`);
  return resolve(directory, filename);
}

function npmEnvironment(root: string): Record<string, string> {
  return {
    HOME: resolve(root, "home"),
    TMPDIR: resolve(root, "tmp"),
    npm_config_cache: resolve(root, "cache/npm"),
    PATH: process.env.PATH ?? "",
  };
}

function launcherEnvironment(root: string): Record<string, string> {
  const systemPath =
    process.platform === "win32"
      ? [
          process.env.SystemRoot
            ? resolve(process.env.SystemRoot, "System32")
            : "C:\\Windows\\System32",
        ]
      : ["/usr/bin", "/bin"];
  return {
    HOME: resolve(root, "home"),
    TMPDIR: resolve(root, "tmp"),
    PATH: systemPath.join(delimiter),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.ComSpec ? { ComSpec: process.env.ComSpec } : {}),
    ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
  };
}

function platformDirectory(): string {
  const key = `${process.platform}-${process.arch}`;
  const supported: Record<string, string> = {
    "darwin-arm64": "darwin-arm64",
    "darwin-x64": "darwin-x64",
    "linux-arm64": "linux-arm64",
    "linux-x64": "linux-x64",
    "win32-x64": "windows-x64",
  };
  const directory = supported[key];
  if (!directory) throw new Error(`unsupported_platform: ${key}`);
  return directory;
}
