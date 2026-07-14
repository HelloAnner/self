import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { sha256File } from "../src/infrastructure/filesystem/hash.ts";
import { VERSION } from "../src/shared/version.ts";

const platform = platformInfo();
const local = resolve("dist/local", `self-${process.platform}-${process.arch}`);
const root = resolve("dist/release", `v${VERSION.cli}`);
const archiveDirectory = resolve(root, platform.archiveName);
const npmRoot = resolve(root, "npm");
const platformStage = resolve(npmRoot, platform.packageDirectory);
const metaStage = resolve(npmRoot, "self");
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

await cp(local, archiveDirectory, { recursive: true });
const archive = await createArchive(root, archiveDirectory, platform.archiveName);

await mkdir(resolve(platformStage, "bin"), { recursive: true });
await cp(
  resolve("packages/platforms", platform.packageDirectory, "package.json"),
  resolve(platformStage, "package.json"),
);
await cp(resolve(local, "runtime"), resolve(platformStage, "runtime"), { recursive: true });
await cp(resolve(local, "templates"), resolve(platformStage, "templates"), { recursive: true });
await cp(resolve(local, "migrations"), resolve(platformStage, "migrations"), { recursive: true });
for (const name of ["build-manifest.json", "checksums.txt", "sbom.cdx.json", "LICENSE"]) {
  await cp(resolve(local, name), resolve(platformStage, name));
}
await cp(resolve(local, "LICENSES"), resolve(platformStage, "LICENSES"), { recursive: true });
await cp(
  resolve(local, process.platform === "win32" ? "self.exe" : "self"),
  resolve(platformStage, "bin", process.platform === "win32" ? "self.exe" : "self"),
);
await writePublishPackage(resolve(platformStage, "package.json"), VERSION.cli);
await writeChecksums(platformStage);

await cp("packages/npm-self", metaStage, { recursive: true });
await cp("LICENSE", resolve(metaStage, "LICENSE"));
await writePublishPackage(resolve(metaStage, "package.json"), VERSION.cli);

const platformTarball = pack(platformStage);
const metaTarball = pack(metaStage);
const releaseManifest = {
  format: "self-release-manifest-v1",
  version: VERSION.cli,
  platform: platform.key,
  files: await Promise.all(
    [archive, platformTarball, metaTarball].map(async (path) => ({
      name: basename(path),
      sha256: await sha256File(path),
    })),
  ),
};
await Bun.write(
  resolve(root, `release-manifest-${platform.key}.json`),
  `${JSON.stringify(releaseManifest, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify({ root, archive, platformTarball, metaTarball })}\n`);

async function writePublishPackage(path: string, version: string) {
  const value = (await Bun.file(path).json()) as Record<string, unknown>;
  delete value.private;
  value.version = version;
  value.repository = { type: "git", url: "git+https://github.com/HelloAnner/self.git" };
  value.publishConfig = { access: "public", provenance: true };
  if (value.optionalDependencies && typeof value.optionalDependencies === "object") {
    value.optionalDependencies = Object.fromEntries(
      Object.keys(value.optionalDependencies as Record<string, string>).map((name) => [
        name,
        version,
      ]),
    );
  }
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function pack(directory: string): string {
  const result = Bun.spawnSync(["npm", "pack", "--json"], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  const parsed = JSON.parse(result.stdout.toString()) as [{ filename: string }];
  const filename = parsed[0]?.filename;
  if (!filename) throw new Error(`npm pack did not produce a tarball in ${directory}`);
  return resolve(directory, filename);
}

async function createArchive(root: string, directory: string, name: string): Promise<string> {
  if (process.platform === "win32") {
    const output = resolve(root, `${name}.zip`);
    const result = Bun.spawnSync(
      [
        "powershell",
        "-NoProfile",
        "-Command",
        `Compress-Archive -Path '${directory}' -DestinationPath '${output}' -Force`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return output;
  }
  const output = resolve(root, `${name}.tar.gz`);
  const result = Bun.spawnSync(
    ["tar", "-czf", output, "-C", dirname(directory), basename(directory)],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return output;
}

function platformInfo() {
  const key = `${process.platform}-${process.arch}`;
  const values: Record<string, { key: string; packageDirectory: string; archiveName: string }> = {
    "darwin-arm64": { key, packageDirectory: "darwin-arm64", archiveName: "self-darwin-arm64" },
    "darwin-x64": { key, packageDirectory: "darwin-x64", archiveName: "self-darwin-x64" },
    "linux-arm64": { key, packageDirectory: "linux-arm64", archiveName: "self-linux-arm64" },
    "linux-x64": { key, packageDirectory: "linux-x64", archiveName: "self-linux-x64" },
    "win32-x64": { key, packageDirectory: "windows-x64", archiveName: "self-windows-x64" },
  };
  const selected = values[key];
  if (!selected) throw new Error(`unsupported_platform: ${key}`);
  return selected;
}

async function writeChecksums(directory: string) {
  const rows: string[] = [];
  for (const path of await recursiveFiles(directory)) {
    if (basename(path) === "checksums.txt" || basename(path) === "package.json") continue;
    rows.push(`${await sha256File(path)}  ${relative(directory, path).split("\\").join("/")}`);
  }
  await Bun.write(resolve(directory, "checksums.txt"), `${rows.sort().join("\n")}\n`);
}

async function recursiveFiles(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await recursiveFiles(path)));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}
