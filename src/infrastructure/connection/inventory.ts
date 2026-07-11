import { readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import type {
  ConnectionKind,
  ConnectionTarget,
  FilterPolicy,
  InventoryEntry,
  Observation,
  ScanPolicy,
} from "../../domains/connection/index.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { sha256File, sha256Text } from "../filesystem/hash.ts";

type Candidate = {
  absolute: string;
  relative: string;
  metadata: Awaited<ReturnType<typeof metadata>>;
};

export async function buildInventory(options: {
  target: ConnectionTarget;
  connectionKind: ConnectionKind;
  filters: FilterPolicy;
  scanPolicy: ScanPolicy;
  previous: Observation[];
  fullHash: boolean;
}) {
  const candidates: Candidate[] = [];
  const ignored: { path: string; reason: string }[] = [];
  const include = compileGlobs(options.filters.include_globs);
  const exclude = compileGlobs(options.filters.exclude_globs);
  await enumerate(options.target.canonical_path, options.target.target_kind === "file");
  if (options.scanPolicy.write_settle_window_ms > 0 && candidates.length > 0) {
    await Bun.sleep(options.scanPolicy.write_settle_window_ms);
  }
  const before = new Map(options.previous.map((item) => [item.normalized_path_key, item]));
  const entries: InventoryEntry[] = [];
  let hashed = 0;
  let reused = 0;
  for (const candidate of candidates) {
    const stable = await metadata(candidate.absolute);
    if (
      stable.size_bytes !== candidate.metadata.size_bytes ||
      stable.mtime_ns !== candidate.metadata.mtime_ns ||
      stable.quick_fingerprint !== candidate.metadata.quick_fingerprint
    ) {
      throw failure(
        "connection_file_unstable",
        `File did not settle: ${candidate.relative}`,
        "external",
        { retryable: true },
      );
    }
    const key = normalize(candidate.relative, options.target.case_sensitivity);
    const old = before.get(key);
    const canReuse =
      !options.fullHash &&
      old?.size_bytes === stable.size_bytes &&
      old.mtime_ns === stable.mtime_ns &&
      old.quick_fingerprint === stable.quick_fingerprint;
    const contentHash = canReuse ? old.content_hash : await sha256File(candidate.absolute);
    if (canReuse) reused += 1;
    else hashed += 1;
    entries.push({
      relative_path: candidate.relative,
      normalized_path_key: key,
      file_identity: stable.file_identity,
      size_bytes: stable.size_bytes,
      mtime_ns: stable.mtime_ns,
      quick_fingerprint: stable.quick_fingerprint,
      content_hash: contentHash,
    });
  }
  entries.sort((left, right) => left.normalized_path_key.localeCompare(right.normalized_path_key));
  return { entries, ignored, files_hashed: hashed, hashes_reused: reused };

  async function enumerate(path: string, single: boolean): Promise<void> {
    if (single) {
      await consider(path, basename(path));
      return;
    }
    await visit(path);
  }

  async function visit(directory: string): Promise<void> {
    const items = await readdir(directory, { withFileTypes: true });
    items.sort((left, right) => left.name.localeCompare(right.name));
    for (const item of items) {
      const absolute = join(directory, item.name);
      const logical = relative(options.target.canonical_path, absolute).split("\\").join("/");
      if (item.isSymbolicLink()) {
        ignored.push({ path: logical, reason: "symlink" });
        continue;
      }
      if (matches(exclude, logical) || hidden(logical, options.connectionKind, options.filters)) {
        if (item.isFile()) ignored.push({ path: logical, reason: "excluded" });
        continue;
      }
      if (item.isDirectory()) {
        if (options.target.recursive) await visit(absolute);
        continue;
      }
      if (item.isFile()) await consider(absolute, logical);
    }
  }

  async function consider(absolute: string, logical: string): Promise<void> {
    if (!matches(include, logical)) {
      ignored.push({ path: logical, reason: "not_included" });
      return;
    }
    if (sensitive(logical) && options.filters.sensitive_file_mode !== "allow") {
      ignored.push({ path: logical, reason: "sensitive" });
      return;
    }
    const value = await metadata(absolute);
    if (value.size_bytes > options.filters.max_file_bytes) {
      ignored.push({ path: logical, reason: "too_large" });
      return;
    }
    candidates.push({ absolute, relative: logical, metadata: value });
  }
}

async function metadata(path: string) {
  const value = await stat(path, { bigint: true });
  const size = Number(value.size);
  const first = new Uint8Array(await Bun.file(path).slice(0, Math.min(size, 4096)).arrayBuffer());
  const lastStart = Math.max(0, size - 4096);
  const last = new Uint8Array(await Bun.file(path).slice(lastStart, size).arrayBuffer());
  return {
    size_bytes: size,
    mtime_ns: value.mtimeNs.toString(),
    file_identity: `${value.dev}:${value.ino}`,
    quick_fingerprint: sha256Text(
      `${size}\n${value.mtimeNs}\n${hashBytes(first)}\n${hashBytes(last)}`,
    ),
  };
}

function compileGlobs(patterns: string[]): Bun.Glob[] {
  try {
    return patterns.map((pattern) => new Bun.Glob(pattern));
  } catch {
    throw failure("connection_filter_invalid", "Connection Glob is invalid", "usage");
  }
}

function matches(globs: Bun.Glob[], path: string): boolean {
  return globs.some((glob) => glob.match(path));
}

function hidden(path: string, kind: ConnectionKind, policy: FilterPolicy): boolean {
  if (policy.include_hidden) return false;
  return path
    .split("/")
    .some((part) => part.startsWith(".") && !(kind === "obsidian" && part === ".obsidian"));
}

function sensitive(path: string): boolean {
  const name = basename(path).toLowerCase();
  return (
    name.startsWith(".env") ||
    [".pem", ".key", ".p12"].includes(extname(name)) ||
    ["credentials.json", "secrets.json"].includes(name)
  );
}

function normalize(path: string, sensitivity: ConnectionTarget["case_sensitivity"]): string {
  return sensitivity === "insensitive" ? path.toLocaleLowerCase("en-US") : path;
}

function hashBytes(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}
