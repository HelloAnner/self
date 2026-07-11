import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import type { InputEntry, SourceKind, SourceMode, SourceSpec } from "../../domains/source/index.ts";
import { failure, SelfFailure } from "../../shared/errors/self-error.ts";

const DEFAULT_EXCLUDES = [
  ".git",
  ".git/**",
  "node_modules",
  "node_modules/**",
  ".DS_Store",
  ".obsidian/workspace.json",
  ".obsidian/workspace-mobile.json",
];

export type PreparedInput = { name: string; spec: SourceSpec; entries: InputEntry[] };

export async function prepareSourceInput(options: {
  input: string;
  kind: SourceKind | "auto";
  mode: SourceMode;
  name?: string;
  recursive: boolean;
  include: string[];
  exclude: string[];
  stdinBytes?: Uint8Array;
}): Promise<PreparedInput> {
  if (options.input === "-") return prepareStdin(options);
  if (isWebUrl(options.input)) return prepareWeb(options);
  return preparePath(options);
}

export async function readSourceSpec(root: string, spec: SourceSpec): Promise<InputEntry[]> {
  if (spec.locator_type === "stdin" || !spec.locator) {
    throw failure("source_not_syncable", "This Source has no rereadable locator", "state");
  }
  if (spec.locator_type === "url") {
    return (
      await prepareWeb({
        input: spec.locator,
        kind: "web",
        mode: spec.mode,
        recursive: false,
        include: spec.include,
        exclude: spec.exclude,
      })
    ).entries;
  }
  const input = spec.locator_type === "managed_path" ? join(root, spec.locator) : spec.locator;
  return (
    await preparePath({
      input,
      kind: spec.kind,
      mode: spec.mode,
      recursive: spec.recursive,
      include: spec.include,
      exclude: spec.exclude,
    })
  ).entries;
}

async function prepareStdin(
  options: Parameters<typeof prepareSourceInput>[0],
): Promise<PreparedInput> {
  if (options.kind !== "text" && options.kind !== "jsonl") {
    throw failure("source_input_invalid", "stdin requires --kind text or jsonl", "usage");
  }
  if (!options.name) throw failure("source_input_invalid", "stdin requires --name", "usage");
  if (!options.stdinBytes) throw failure("source_input_invalid", "stdin had no content", "usage");
  const now = new Date().toISOString();
  return {
    name: options.name,
    spec: {
      kind: options.kind,
      mode: options.mode,
      locator_type: "stdin",
      locator: null,
      original_locator: "stdin",
      recursive: false,
      include: [],
      exclude: [],
    },
    entries: [
      {
        logical_path: options.kind === "jsonl" ? "stdin.jsonl" : "stdin.txt",
        mime_type: options.kind === "jsonl" ? "application/x-ndjson" : "text/plain",
        origin_uri: "stdin:",
        acquired_at: now,
        content: { kind: "bytes", bytes: options.stdinBytes },
      },
    ],
  };
}

async function prepareWeb(
  options: Parameters<typeof prepareSourceInput>[0],
): Promise<PreparedInput> {
  if (options.kind !== "auto" && options.kind !== "web") {
    throw failure("source_input_invalid", "HTTP input requires --kind web", "usage");
  }
  let url: URL;
  try {
    url = new URL(options.input);
  } catch {
    throw failure("source_input_invalid", "Web Source URL is invalid", "usage");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw failure("source_input_invalid", "Web Source requires HTTP or HTTPS", "usage");
  }
  let response: Response;
  try {
    response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
  } catch (cause) {
    throw failure("source_unavailable", "Web Source could not be fetched", "external", {
      retryable: true,
      details: { reason: cause instanceof Error ? cause.message : String(cause) },
    });
  }
  if (!response.ok) {
    throw failure("source_unavailable", `Web Source returned HTTP ${response.status}`, "external", {
      retryable: response.status === 429 || response.status >= 500,
    });
  }
  const finalUrl = response.url || url.toString();
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || "text/html";
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    name: options.name ?? webName(new URL(finalUrl)),
    spec: {
      kind: "web",
      mode: options.mode,
      locator_type: "url",
      locator: url.toString(),
      original_locator: options.input,
      recursive: false,
      include: [],
      exclude: [],
    },
    entries: [
      {
        logical_path: "page.html",
        mime_type: contentType,
        origin_uri: finalUrl,
        acquired_at: new Date().toISOString(),
        content: { kind: "bytes", bytes },
      },
    ],
  };
}

async function preparePath(
  options: Parameters<typeof prepareSourceInput>[0],
): Promise<PreparedInput> {
  const potential = resolve(expandHome(options.input));
  let path: string;
  try {
    const inputStats = await lstat(potential);
    if (inputStats.isSymbolicLink()) {
      throw failure("source_input_invalid", "Symbolic link Sources are not accepted", "usage");
    }
    path = await realpath(potential);
  } catch (cause) {
    if (cause instanceof SelfFailure) throw cause;
    throw failure("source_unavailable", "Source path is unavailable", "external", {
      retryable: true,
    });
  }
  const stats = await lstat(path);
  if (!stats.isFile() && !stats.isDirectory()) {
    throw failure("source_input_invalid", "Source path must be a file or directory", "usage");
  }
  assertPathKind(stats.isDirectory(), options.kind);
  const kind = await detectKind(path, stats.isDirectory(), options.kind);
  const entries = stats.isFile()
    ? [fileEntry(path, basename(path))]
    : await directoryEntries(path, kind, options.recursive, options.include, options.exclude);
  return {
    name: options.name ?? basename(path),
    spec: {
      kind,
      mode: options.mode,
      locator_type: "external_path",
      locator: path,
      original_locator: options.input,
      recursive: stats.isDirectory() ? options.recursive : false,
      include: [...options.include],
      exclude: [...options.exclude],
    },
    entries,
  };
}

function assertPathKind(directory: boolean, kind: SourceKind | "auto"): void {
  if (kind === "auto" || kind === "markdown") return;
  const directoryKinds: SourceKind[] = ["directory", "obsidian"];
  if (directory !== directoryKinds.includes(kind)) {
    throw failure(
      "source_input_invalid",
      directory
        ? `Directory input is incompatible with --kind ${kind}`
        : `File input is incompatible with --kind ${kind}`,
      "usage",
    );
  }
}

async function detectKind(
  path: string,
  directory: boolean,
  requested: SourceKind | "auto",
): Promise<SourceKind> {
  if (requested !== "auto") return requested;
  if (!directory) return extname(path).toLowerCase() === ".md" ? "markdown" : "file";
  try {
    if ((await lstat(join(path, ".obsidian"))).isDirectory()) return "obsidian";
  } catch {
    // A normal directory has no .obsidian marker.
  }
  return "directory";
}

async function directoryEntries(
  root: string,
  kind: SourceKind,
  recursive: boolean,
  includes: string[],
  excludes: string[],
): Promise<InputEntry[]> {
  const output: InputEntry[] = [];
  let excluded: Bun.Glob[];
  let included: Bun.Glob[];
  try {
    excluded = [...DEFAULT_EXCLUDES, ...excludes].map((pattern) => new Bun.Glob(pattern));
    included = includes.map((pattern) => new Bun.Glob(pattern));
  } catch {
    throw failure("source_input_invalid", "Source include/exclude Glob is invalid", "usage");
  }
  await visit(root);
  output.sort((left, right) => left.logical_path.localeCompare(right.logical_path));
  return output;

  async function visit(directory: string): Promise<void> {
    const items = await readdir(directory, { withFileTypes: true });
    items.sort((left, right) => left.name.localeCompare(right.name));
    for (const item of items) {
      if (item.isSymbolicLink()) continue;
      const absolute = join(directory, item.name);
      const logical = relative(root, absolute).split("\\").join("/");
      if (matches(excluded, logical)) continue;
      if (item.isDirectory()) {
        if (recursive) await visit(absolute);
        continue;
      }
      if (!item.isFile() || (included.length > 0 && !matches(included, logical))) continue;
      if (kind === "markdown" && extname(item.name).toLowerCase() !== ".md") continue;
      output.push(fileEntry(absolute, logical));
    }
  }
}

function fileEntry(path: string, logicalPath: string): InputEntry {
  return {
    logical_path: logicalPath,
    mime_type: mimeType(path),
    origin_uri: `file://${path}`,
    acquired_at: new Date().toISOString(),
    content: { kind: "file", path },
  };
}

function matches(globs: Bun.Glob[], path: string): boolean {
  return globs.some((glob) => glob.match(path));
}

function isWebUrl(input: string): boolean {
  return input.startsWith("http://") || input.startsWith("https://");
}

function webName(url: URL): string {
  return url.pathname === "/" ? url.hostname : basename(url.pathname) || url.hostname;
}

function mimeType(path: string): string {
  const extension = extname(path).toLowerCase();
  const types: Record<string, string> = {
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".json": "application/json",
    ".jsonl": "application/x-ndjson",
    ".html": "text/html",
    ".htm": "text/html",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".pdf": "application/pdf",
  };
  return types[extension] ?? "application/octet-stream";
}

function expandHome(input: string): string {
  if (input === "~") return process.env.HOME ?? input;
  if (input.startsWith("~/")) return join(process.env.HOME ?? "~", input.slice(2));
  return input;
}
