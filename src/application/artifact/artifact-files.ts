import { cp, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { PageIrV1 } from "../../domains/artifact/index.ts";
import type { BuildFile } from "../../infrastructure/artifact/artifact-repository.ts";
import { atomicWrite } from "../../infrastructure/filesystem/atomic-write.ts";
import { sha256File, sha256Text } from "../../infrastructure/filesystem/hash.ts";
import { failure } from "../../shared/errors/self-error.ts";

export type ArchiveWriter = {
  directory: string;
  files: BuildFile[];
  write: (path: string, content: string, mediaType: string, role: string) => Promise<void>;
};

export async function createArchiveWriter(root: string, buildId: string): Promise<ArchiveWriter> {
  const directory = join(root, "runtime/tmp", `artifact-${safe(buildId)}`);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const files: BuildFile[] = [];
  return {
    directory,
    files,
    write: async (path, content, mediaType, role) => {
      const absolute = join(directory, path);
      await mkdir(dirname(absolute), { recursive: true });
      await Bun.write(absolute, content);
      const info = await stat(absolute);
      files.push({ path, hash: await sha256File(absolute), bytes: info.size, mediaType, role });
    },
  };
}

export async function publishArchive(root: string, temporary: string, relativeDirectory: string) {
  const destination = resolve(root, relativeDirectory);
  if (!destination.startsWith(`${resolve(root, "artifacts")}/`))
    throw failure(
      "artifact_path_invalid",
      "Artifact archive path escaped the Workspace",
      "internal",
    );
  if (await Bun.file(destination).exists())
    throw failure("artifact_build_exists", "Artifact Build directory already exists", "conflict");
  await mkdir(dirname(destination), { recursive: true });
  await rename(temporary, destination);
  return destination;
}

export async function updateArtifactPointers(
  root: string,
  input: {
    slug: string;
    artifactId: string;
    topicId: string;
    buildId: string;
    relativeDirectory: string;
    title: string;
  },
) {
  const base = join(root, "artifacts/topics", input.slug);
  await atomicWrite(
    join(base, "topic.json"),
    `${JSON.stringify({ schema: "self.topic-artifact", version: 1, artifact_id: input.artifactId, topic_id: input.topicId, slug: input.slug, title: input.title }, null, 2)}\n`,
  );
  await atomicWrite(
    join(base, "latest.json"),
    `${JSON.stringify({ schema: "self.artifact-latest", version: 1, build_id: input.buildId, relative_directory: input.relativeDirectory, index: `${input.relativeDirectory}/index.html`, updated_at: new Date().toISOString() }, null, 2)}\n`,
  );
}

export async function copyHtmlExport(sourceBuild: string, output: string) {
  if (await pathExists(output))
    throw failure("artifact_export_exists", "Export output already exists", "conflict");
  await mkdir(output, { recursive: true });
  await cp(join(sourceBuild, "index.html"), join(output, "index.html"));
  if (await pathExists(join(sourceBuild, "assets")))
    await cp(join(sourceBuild, "assets"), join(output, "assets"), { recursive: true });
}

export async function directoryHash(directory: string) {
  const paths = await recursiveFiles(directory);
  const entries: string[] = [];
  for (const path of paths) entries.push(`${relative(directory, path)}\n${await sha256File(path)}`);
  return sha256Text(entries.sort().join("\n"));
}

export function pageIrMarkdown(page: PageIrV1) {
  const lines = [`# ${page.topic.title}`, "", page.topic.scope, ""];
  for (const component of page.components) {
    if (component.type === "hero" || component.type === "evidence_blocks") continue;
    lines.push(`## ${component.title}`, "");
    const conclusions = rows(component.payload.conclusions);
    for (const conclusion of conclusions) lines.push(`- ${String(conclusion.statement ?? "")}`);
    const positions = rows(component.payload.positions);
    for (const position of positions) lines.push(`- ${String(position.statement ?? "")}`);
    const gaps = rows(component.payload.items);
    for (const gap of gaps) if (gap.question) lines.push(`- ${String(gap.question)}`);
    lines.push("");
  }
  lines.push("## 引用", "");
  page.citations.forEach((citation, index) => {
    lines.push(
      `${index + 1}. ${citation.sourceName} — ${citation.excerpt.replace(/\s+/gu, " ").trim()}`,
    );
  });
  return `${lines.join("\n").trim()}\n`;
}

export async function safeRemoveTemporary(path: string) {
  if (path.includes("/runtime/tmp/artifact-")) await rm(path, { recursive: true, force: true });
}

async function recursiveFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await recursiveFiles(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

async function pathExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
function safe(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/gu, "-");
}
function rows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}
