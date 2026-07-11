import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ConnectionKind, ConnectionTarget } from "../../domains/connection/index.ts";
import { failure } from "../../shared/errors/self-error.ts";

export async function prepareConnectionTarget(options: {
  root: string;
  input: string;
  kind: ConnectionKind;
  scope: "external" | "managed_content";
  recursive: boolean;
}): Promise<Omit<ConnectionTarget, "target_id" | "connection_id" | "revision" | "status">> {
  const candidate = resolve(expandHome(options.input));
  const direct = await lstat(candidate).catch(() => null);
  if (!direct)
    throw failure("connection_target_unavailable", "Connection Target is unavailable", "external", {
      retryable: true,
    });
  if (direct.isSymbolicLink())
    throw failure(
      "connection_self_reference",
      "Connection Target cannot be a symbolic link",
      "usage",
    );
  const canonical = await realpath(candidate);
  const targetKind = direct.isFile() ? "file" : direct.isDirectory() ? "directory" : null;
  if (!targetKind)
    throw failure(
      "connection_target_invalid",
      "Target must be a regular file or directory",
      "usage",
    );
  if ((targetKind === "file") !== (options.kind === "file")) {
    throw failure(
      "connection_target_invalid",
      `Target type is incompatible with kind ${options.kind}`,
      "usage",
    );
  }
  assertScope(options.root, canonical, options.scope);
  const now = new Date().toISOString();
  return {
    uri:
      options.scope === "managed_content"
        ? workspaceUri(options.root, canonical)
        : pathToFileURL(canonical).toString(),
    target_kind: targetKind,
    location_scope: options.scope,
    canonical_path: canonical,
    target_identity_key: hash(`${options.scope}\n${canonical}`),
    path_fingerprint: await fingerprint(canonical, targetKind),
    recursive: targetKind === "directory" ? options.recursive : false,
    follow_symlinks: false,
    case_sensitivity: "unknown",
    last_verified_at: now,
    deleted_at: null,
    created_at: now,
    updated_at: now,
  } as Omit<ConnectionTarget, "target_id" | "connection_id" | "revision" | "status">;
}

export function pathsOverlap(left: string, right: string): boolean {
  const fromLeft = relative(left, right);
  const fromRight = relative(right, left);
  return isInside(fromLeft) || isInside(fromRight);
}

export async function verifyConnectionTarget(target: ConnectionTarget): Promise<void> {
  try {
    const direct = await lstat(target.canonical_path);
    if (direct.isSymbolicLink()) throw new Error("Target became a symbolic link");
    const canonical = await realpath(target.canonical_path);
    if (canonical !== target.canonical_path) throw new Error("Target canonical path changed");
    const actual = direct.isFile() ? "file" : direct.isDirectory() ? "directory" : "other";
    if (actual !== target.target_kind) throw new Error("Target type changed");
  } catch (cause) {
    throw failure("connection_target_unavailable", "Connection Target is unavailable", "external", {
      retryable: true,
      details: { reason: cause instanceof Error ? cause.message : String(cause) },
    });
  }
}

async function fingerprint(path: string, kind: "file" | "directory") {
  const metadata = await stat(path, { bigint: true });
  const firstLevel = kind === "directory" ? (await readdir(path)).sort().slice(0, 200) : [];
  return {
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    kind,
    first_level_hash: hash(JSON.stringify(firstLevel)),
  };
}

function assertScope(root: string, target: string, scope: "external" | "managed_content"): void {
  const fromRoot = relative(root, target).split("\\").join("/");
  const inside = !fromRoot.startsWith("..") && !isAbsolute(fromRoot);
  const managed = ["content/notes", "content/inbox"].some(
    (prefix) => fromRoot === prefix || fromRoot.startsWith(`${prefix}/`),
  );
  if (scope === "managed_content" && (!inside || !managed)) {
    throw failure(
      "connection_self_reference",
      "managed-content is limited to content/notes or content/inbox",
      "usage",
    );
  }
  if (scope === "external" && inside) {
    throw failure(
      "connection_self_reference",
      "External Connection cannot target its own Self Root",
      "usage",
    );
  }
}

function workspaceUri(root: string, target: string): string {
  return `self:///${relative(root, target).split("\\").join("/")}`;
}

function isInside(path: string): boolean {
  return path === "" || path === "." || (!path.startsWith("..") && !isAbsolute(path));
}

function hash(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function expandHome(input: string): string {
  if (input === "~") return process.env.HOME ?? input;
  if (input.startsWith("~/")) return join(process.env.HOME ?? "~", input.slice(2));
  return input;
}
