import { cp, mkdir, rename, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ArchivedEntry, InputEntry } from "../../domains/source/index.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { atomicWrite } from "../filesystem/atomic-write.ts";
import { sha256File } from "../filesystem/hash.ts";

export async function persistEntries(
  root: string,
  entries: InputEntry[],
): Promise<ArchivedEntry[]> {
  const output: ArchivedEntry[] = [];
  for (const entry of entries) output.push(await persistEntry(root, entry));
  return output.sort((left, right) => left.logical_path.localeCompare(right.logical_path));
}

export async function copyEntriesToManaged(
  root: string,
  sourceId: string,
  entries: InputEntry[],
): Promise<{ relativeRoot: string; entries: InputEntry[] }> {
  const relativeRoot = `content/sources/imports/${sourceId.replace(":", "_")}`;
  const absoluteRoot = join(root, relativeRoot);
  const copied: InputEntry[] = [];
  for (const entry of entries) {
    const target = safeEntryPath(absoluteRoot, entry.logical_path);
    if (entry.content.kind === "file") await atomicCopy(entry.content.path, target);
    else await atomicWrite(target, entry.content.bytes);
    copied.push({ ...entry, content: { kind: "file", path: target } });
  }
  return { relativeRoot, entries: copied };
}

async function persistEntry(root: string, entry: InputEntry): Promise<ArchivedEntry> {
  const content = entry.content;
  const bytes = content.kind === "bytes" ? content.bytes : undefined;
  const sha256 =
    content.kind === "bytes" ? hashBytes(content.bytes) : await sha256File(content.path);
  const size =
    content.kind === "bytes" ? content.bytes.byteLength : (await stat(content.path)).size;
  const relativePath = `content/sources/blobs/sha256/${sha256.slice(0, 2)}/${sha256}`;
  const target = join(root, relativePath);
  if (await Bun.file(target).exists()) {
    if ((await sha256File(target)) !== sha256) {
      throw failure(
        "source_blob_corrupt",
        `Stored Blob failed hash verification: ${sha256}`,
        "state",
      );
    }
  } else if (bytes) {
    await atomicWrite(target, bytes);
  } else if (content.kind === "file") {
    await atomicCopy(content.path, target);
  }
  return {
    logical_path: entry.logical_path,
    mime_type: entry.mime_type,
    origin_uri: entry.origin_uri,
    acquired_at: entry.acquired_at,
    blob_sha256: sha256,
    size_bytes: size,
    blob_relative_path: relativePath,
  };
}

async function atomicCopy(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${crypto.randomUUID()}`;
  await cp(source, temporary);
  await rename(temporary, target);
}

function safeEntryPath(root: string, logicalPath: string): string {
  const target = resolve(root, logicalPath);
  const fromRoot = relative(root, target);
  if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw failure("source_input_invalid", "Source entry path escapes its managed root", "usage");
  }
  return target;
}

function hashBytes(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}
