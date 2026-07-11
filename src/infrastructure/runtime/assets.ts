import { copyFile, mkdir, readdir } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { getLoadablePath } from "sqlite-vec";
import { failure } from "../../shared/errors/self-error.ts";
import { atomicWrite } from "../filesystem/atomic-write.ts";
import { sha256File } from "../filesystem/hash.ts";

export type RuntimeAssets = {
  sqliteLibrary: string;
  sqliteVecExtension: string;
  templateDirectory: string;
};

export function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

export async function locateReleaseAssets(): Promise<RuntimeAssets> {
  const executableRoot = dirname(process.execPath);
  const packagedSqlite = await firstFile(join(executableRoot, "runtime/sqlite"));
  const packagedVec = await firstNativeLibrary(
    join(executableRoot, "runtime/extensions/sqlite-vec"),
  );
  if (packagedSqlite && packagedVec) {
    return {
      sqliteLibrary: packagedSqlite,
      sqliteVecExtension: packagedVec,
      templateDirectory: join(executableRoot, "templates"),
    };
  }

  const sqliteLibrary = await locateDevelopmentSqlite();
  if (!sqliteLibrary) {
    throw failure(
      "sqlite_extension_unavailable",
      "No extension-capable SQLite library is available",
      "external",
      { suggestedActions: ["Install the correct Self platform package."], exitCode: 6 },
    );
  }
  return {
    sqliteLibrary,
    sqliteVecExtension: getLoadablePath(),
    templateDirectory: resolve("templates"),
  };
}

export async function installRuntimeAssets(root: string): Promise<RuntimeAssets> {
  const source = await locateReleaseAssets();
  const base = join(root, "runtime/extensions", platformKey());
  const sqliteTarget = join(base, "sqlite", basename(source.sqliteLibrary));
  const vecTarget = join(base, "sqlite-vec", basename(source.sqliteVecExtension));
  await copyAsset(source.sqliteLibrary, sqliteTarget);
  await copyAsset(source.sqliteVecExtension, vecTarget);

  const manifest = {
    platform: process.platform,
    arch: process.arch,
    sqlite: { path: workspacePath(root, sqliteTarget), sha256: await sha256File(sqliteTarget) },
    sqlite_vec: { path: workspacePath(root, vecTarget), sha256: await sha256File(vecTarget) },
  };
  await atomicWrite(join(base, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    sqliteLibrary: sqliteTarget,
    sqliteVecExtension: vecTarget,
    templateDirectory: "templates",
  };
}

export async function locateWorkspaceAssets(root: string): Promise<RuntimeAssets> {
  const base = join(root, "runtime/extensions", platformKey());
  const sqliteLibrary = await firstFile(join(base, "sqlite"));
  const sqliteVecExtension = await firstNativeLibrary(join(base, "sqlite-vec"));
  if (!sqliteLibrary || !sqliteVecExtension) {
    throw failure("component_missing", "Workspace runtime SQLite assets are missing", "state", {
      suggestedActions: ["Run `self doctor --plan-fixes` with a matching platform package."],
    });
  }
  return { sqliteLibrary, sqliteVecExtension, templateDirectory: join(root, "templates") };
}

async function locateDevelopmentSqlite(): Promise<string | undefined> {
  const candidates = [
    process.env.SELF_SQLITE_LIBRARY,
    "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
    "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
    process.platform === "linux" ? "/usr/lib/x86_64-linux-gnu/libsqlite3.so.0" : undefined,
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) if (await Bun.file(candidate).exists()) return candidate;
  return undefined;
}

async function firstNativeLibrary(directory: string): Promise<string | undefined> {
  return firstFile(directory, (name) => [".dylib", ".so", ".dll"].includes(extname(name)));
}

async function firstFile(
  directory: string,
  predicate: (name: string) => boolean = () => true,
): Promise<string | undefined> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const entry = entries.find((candidate) => candidate.isFile() && predicate(candidate.name));
    return entry ? join(directory, entry.name) : undefined;
  } catch {
    return undefined;
  }
}

async function copyAsset(source: string, target: string): Promise<void> {
  if (await Bun.file(target).exists()) {
    if ((await sha256File(source)) !== (await sha256File(target))) {
      throw failure("component_integrity_failed", `Runtime asset differs at ${target}`, "conflict");
    }
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}

function workspacePath(root: string, path: string): string {
  return path
    .slice(root.length + 1)
    .split("\\")
    .join("/");
}
