import { lstat, mkdir, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { InitJournal } from "../../domains/workspace/init/types.ts";
import { sha256File } from "../../infrastructure/filesystem/hash.ts";

export async function ensureDirectory(journal: InitJournal, absolute: string): Promise<void> {
  if (await pathExists(absolute)) return;
  const missing: string[] = [];
  let current = absolute;
  while (current.startsWith(journal.target_root) && !(await pathExists(current))) {
    missing.unshift(current);
    if (current === journal.target_root) break;
    current = dirname(current);
  }
  await mkdir(absolute, { recursive: true });
  for (const path of missing) {
    const relativePath = relative(journal.target_root, path).split("\\").join("/") || ".";
    if (!journal.created_paths.some((item) => item.path === relativePath)) {
      journal.created_paths.push({ path: relativePath, kind: "directory" });
    }
  }
}

export async function recordCreatedFile(journal: InitJournal, absolute: string): Promise<void> {
  const path = relative(journal.target_root, absolute).split("\\").join("/");
  const sha256 = await sha256File(absolute);
  const existing = journal.created_paths.find((item) => item.path === path);
  if (existing) existing.sha256 = sha256;
  else journal.created_paths.push({ path, kind: "file", sha256 });
}

export async function recordFilesRecursively(
  journal: InitJournal,
  directory: string,
): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await recordFilesRecursively(journal, path);
    else if (entry.isFile()) await recordCreatedFile(journal, path);
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
