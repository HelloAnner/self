import { join, resolve } from "node:path";
import {
  artifactBuild,
  artifactForTopic,
  artifactHistory,
  artifactView,
  diffArtifactBuilds,
  listArtifacts,
  listArtifactTemplates,
} from "../../infrastructure/artifact/artifact-repository.ts";
import { readonlyModelDatabase } from "../../infrastructure/model/model-db.ts";
import { failure } from "../../shared/errors/self-error.ts";

export async function readArtifacts(root: string, status?: string) {
  const database = await readonlyModelDatabase(root);
  try {
    return listArtifacts(database, status);
  } finally {
    database.close();
  }
}

export async function readArtifact(root: string, artifactId: string) {
  const database = await readonlyModelDatabase(root);
  try {
    return withPaths(root, artifactView(database, artifactId));
  } finally {
    database.close();
  }
}

export async function readTopicArtifact(root: string, topicId: string) {
  const database = await readonlyModelDatabase(root);
  try {
    return withPaths(root, artifactForTopic(database, topicId));
  } finally {
    database.close();
  }
}

export async function readArtifactHistory(root: string, artifactId: string) {
  const database = await readonlyModelDatabase(root);
  try {
    return artifactHistory(database, artifactId);
  } finally {
    database.close();
  }
}

export async function readTopicArtifactHistory(root: string, topicId: string) {
  const database = await readonlyModelDatabase(root);
  try {
    const view = artifactForTopic(database, topicId);
    return artifactHistory(
      database,
      String((view.artifact as Record<string, unknown>).artifact_id),
    );
  } finally {
    database.close();
  }
}

export async function readArtifactDiff(root: string, fromId: string, toId: string) {
  const database = await readonlyModelDatabase(root);
  try {
    return diffArtifactBuilds(database, fromId, toId);
  } finally {
    database.close();
  }
}

export async function readTopicArtifactDiff(
  root: string,
  topicId: string,
  fromId: string,
  toId = "latest",
) {
  const database = await readonlyModelDatabase(root);
  try {
    const view = artifactForTopic(database, topicId);
    const artifact = view.artifact as Record<string, unknown>;
    const resolvedTo = toId === "latest" ? String(artifact.latest_build_id) : toId;
    return diffArtifactBuilds(database, fromId, resolvedTo);
  } finally {
    database.close();
  }
}

export async function readTemplates(root: string) {
  const database = await readonlyModelDatabase(root);
  try {
    return listArtifactTemplates(database);
  } finally {
    database.close();
  }
}

export async function openArtifact(root: string, resourceId: string, kind: "artifact" | "topic") {
  const database = await readonlyModelDatabase(root);
  let build: Record<string, unknown>;
  try {
    const view =
      kind === "topic"
        ? artifactForTopic(database, resourceId)
        : artifactView(database, resourceId);
    if (!view.latest_build)
      throw failure("artifact_not_built", "Artifact has no ready Build", "state");
    build = view.latest_build as Record<string, unknown>;
  } finally {
    database.close();
  }
  if (build.state !== "ready")
    throw failure("artifact_not_ready", "Latest Artifact Build is not ready", "state");
  const indexPath = resolve(root, String(build.relative_directory), "index.html");
  const artifactRoot = resolve(root, "artifacts");
  if (!indexPath.startsWith(`${artifactRoot}/`) || !(await Bun.file(indexPath).exists()))
    throw failure("artifact_file_missing", "Artifact index.html is missing", "state");
  const launched = process.env.SELF_NO_OPEN !== "1" && launch(indexPath);
  return { build_id: build.build_id, index_path: indexPath, url: `file://${indexPath}`, launched };
}

export async function loadBuildPageIr(root: string, buildId: string) {
  const database = await readonlyModelDatabase(root);
  let build: Record<string, unknown>;
  try {
    build = artifactBuild(database, buildId) as Record<string, unknown>;
  } finally {
    database.close();
  }
  if (build.state !== "ready")
    throw failure("artifact_not_ready", "Artifact Build is not ready", "state");
  const buildDirectory = resolve(root, String(build.relative_directory));
  if (!buildDirectory.startsWith(`${resolve(root, "artifacts")}/`))
    throw failure("artifact_path_invalid", "Artifact path escaped the Workspace", "state");
  const path = join(buildDirectory, "page.ir.json");
  if (!(await Bun.file(path).exists()))
    throw failure("artifact_file_missing", "Page IR is missing", "state");
  return {
    build,
    buildDirectory,
    pageIr: JSON.parse(await Bun.file(path).text()) as Record<string, unknown>,
  };
}

function withPaths(root: string, value: Record<string, unknown>) {
  const latest = value.latest_build as Record<string, unknown> | null;
  return latest
    ? {
        ...value,
        latest_build: {
          ...latest,
          index_path: join(root, String(latest.relative_directory), "index.html"),
        },
      }
    : value;
}

function launch(path: string) {
  const command =
    process.platform === "darwin"
      ? ["open", path]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", path]
        : ["xdg-open", path];
  try {
    const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
