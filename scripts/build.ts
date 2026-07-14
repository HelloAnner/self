import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { getLoadablePath } from "sqlite-vec";
import { sha256File } from "../src/infrastructure/filesystem/hash.ts";
import { locateReleaseAssets } from "../src/infrastructure/runtime/assets.ts";
import { VERSION } from "../src/shared/version.ts";

const outputRoot = resolve("dist/local", `self-${process.platform}-${process.arch}`);
const executable = join(outputRoot, process.platform === "win32" ? "self.exe" : "self");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(dirname(executable), { recursive: true });

const build = await Bun.build({
  entrypoints: ["src/cli/main.ts"],
  compile: { outfile: executable },
  minify: true,
  sourcemap: "external",
});
if (!build.success) throw new AggregateError(build.logs, "Self build failed");

const assets = await locateReleaseAssets();
const sqliteLibrary = assets.sqliteLibrary;
const sqliteTarget = join(outputRoot, "runtime/sqlite", basename(sqliteLibrary));
await mkdir(dirname(sqliteTarget), { recursive: true });
await cp(sqliteLibrary, sqliteTarget, { dereference: true });

const vecPath = getLoadablePath();
const vecTarget = join(outputRoot, "runtime/extensions/sqlite-vec", basename(vecPath));
await mkdir(dirname(vecTarget), { recursive: true });
await cp(vecPath, vecTarget);

await cp("templates", join(outputRoot, "templates"), { recursive: true });
await cp("drizzle", join(outputRoot, "migrations"), { recursive: true });
await cp("LICENSE", join(outputRoot, "LICENSE"));
await mkdir(join(outputRoot, "LICENSES"), { recursive: true });
await cp("LICENSE", join(outputRoot, "LICENSES/SELF-MIT.txt"));

const packageManifest = (await Bun.file("package.json").json()) as {
  dependencies?: Record<string, string>;
};
const dependencies = Object.entries(packageManifest.dependencies ?? {}).map(([name, version]) => ({
  name,
  version,
  purl: `pkg:npm/${encodeURIComponent(name)}@${version}`,
}));
await Bun.write(
  join(outputRoot, "LICENSES/THIRD_PARTY.md"),
  `# Third-party components\n\nThe authoritative license texts are included by the npm dependency graph and source repository. Release verification checks this inventory.\n\n${dependencies.map((dependency) => `- ${dependency.name} ${dependency.version}`).join("\n")}\n`,
);

const sourceDate = sourceDateIso();
const commit = gitCommit();

const manifest = {
  cli_version: VERSION.cli,
  database_schema_version: VERSION.databaseSchema,
  cli_protocol_version: VERSION.cliProtocol,
  page_ir_version: VERSION.pageIr,
  bun_version: Bun.version,
  platform: process.platform,
  arch: process.arch,
  sqlite_library: sqliteLibrary ? basename(sqliteLibrary) : null,
  sqlite_vec: basename(vecPath),
  license: "MIT",
  source_commit: commit,
  source_date: sourceDate,
  artifact_format: "self-release-v1",
};
await Bun.write(join(outputRoot, "build-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await Bun.write(
  join(outputRoot, "sbom.cdx.json"),
  `${JSON.stringify(
    {
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      version: 1,
      metadata: {
        timestamp: sourceDate,
        component: {
          type: "application",
          name: "@helloanner/self",
          version: VERSION.cli,
          licenses: [{ license: { id: "MIT" } }],
        },
        properties: [
          { name: "self:git-commit", value: commit },
          { name: "self:database-schema", value: String(VERSION.databaseSchema) },
        ],
      },
      components: dependencies.map((dependency) => ({
        type: "library",
        name: dependency.name,
        version: dependency.version,
        purl: dependency.purl,
      })),
    },
    null,
    2,
  )}\n`,
);
const checksumEntries: string[] = [];
for (const path of await recursiveFiles(outputRoot)) {
  if (basename(path) === "checksums.txt") continue;
  checksumEntries.push(
    `${await sha256File(path)}  ${relative(outputRoot, path).split("\\").join("/")}`,
  );
}
await Bun.write(join(outputRoot, "checksums.txt"), `${checksumEntries.sort().join("\n")}\n`);

const smoke = Bun.spawnSync([executable, "version", "--json"], { stdout: "pipe", stderr: "pipe" });
if (smoke.exitCode !== 0) throw new Error(smoke.stderr.toString());
process.stdout.write(`${outputRoot}\n${smoke.stdout.toString()}`);

async function recursiveFiles(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await recursiveFiles(path)));
    else if (entry.isFile() && (await stat(path)).size >= 0) output.push(path);
  }
  return output;
}

function sourceDateIso(): string {
  const seconds = Number(process.env.SOURCE_DATE_EPOCH);
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds * 1_000).toISOString()
    : new Date().toISOString();
}

function gitCommit(): string {
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : "unknown";
}
