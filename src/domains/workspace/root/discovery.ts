import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { failure } from "../../../shared/errors/self-error.ts";

export async function discoverWorkspaceRoot(options: {
  explicit?: string;
  cwd?: string;
  environment?: string;
}): Promise<string> {
  const selected = options.explicit ?? options.environment;
  if (selected) {
    const root = await canonicalizePotentialPath(selected);
    if (!(await Bun.file(join(root, "self.toml")).exists())) throw workspaceNotFound(root);
    return root;
  }

  let current = await realpath(options.cwd ?? process.cwd());
  while (true) {
    if (await Bun.file(join(current, "self.toml")).exists()) return current;
    const parent = dirname(current);
    if (parent === current) throw workspaceNotFound(current);
    current = parent;
  }
}

export async function canonicalizePotentialPath(input: string): Promise<string> {
  const absolute = resolve(expandHome(input));
  let ancestor = absolute;
  const suffix: string[] = [];
  while (true) {
    try {
      const stats = await lstat(ancestor);
      if (!stats.isDirectory()) {
        throw failure(
          "workspace_path_invalid",
          "Workspace target ancestor is not a directory",
          "usage",
        );
      }
      break;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        suffix.unshift(basename(ancestor));
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
        continue;
      }
      throw error;
    }
  }
  return join(await realpath(ancestor), ...suffix);
}

export function workspaceRelativePath(root: string, path: string): string {
  const value = relative(root, path);
  if (!value || value === ".") return ".";
  if (value.startsWith("..") || isAbsolute(value)) {
    throw failure("path_outside_workspace", "Path escapes the Workspace root", "usage");
  }
  return value.split("\\").join("/");
}

function expandHome(input: string): string {
  if (input === "~") return process.env.HOME ?? input;
  if (input.startsWith("~/")) return join(process.env.HOME ?? "~", input.slice(2));
  return input;
}

function workspaceNotFound(root: string) {
  return failure("workspace_not_found", `No Self Workspace was found from ${root}`, "not_found", {
    suggestedActions: ["Pass `--root <DIR>` or run the command inside a Self Workspace."],
  });
}
