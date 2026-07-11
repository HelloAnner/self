import { cp, mkdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { getLoadablePath } from "sqlite-vec";
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
};
await Bun.write(join(outputRoot, "build-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const smoke = Bun.spawnSync([executable, "version", "--json"], { stdout: "pipe", stderr: "pipe" });
if (smoke.exitCode !== 0) throw new Error(smoke.stderr.toString());
process.stdout.write(`${outputRoot}\n${smoke.stdout.toString()}`);
