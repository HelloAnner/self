import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { PageIrV1 } from "../../domains/artifact/index.ts";
import {
  artifactForTopic,
  artifactView,
  recordArtifactExport,
} from "../../infrastructure/artifact/artifact-repository.ts";
import { loadArtifactTemplate } from "../../infrastructure/artifact/template-assets.ts";
import { atomicWrite } from "../../infrastructure/filesystem/atomic-write.ts";
import { sha256File } from "../../infrastructure/filesystem/hash.ts";
import {
  readonlyModelDatabase,
  writableModelDatabase,
} from "../../infrastructure/model/model-db.ts";
import { renderKnowledgeAtlas } from "../../renderer/components/page.tsx";
import { failure } from "../../shared/errors/self-error.ts";
import { copyHtmlExport, directoryHash, pageIrMarkdown } from "./artifact-files.ts";
import { loadBuildPageIr } from "./artifact-queries.ts";

export async function exportArtifact(
  root: string,
  resourceId: string,
  input: {
    resourceKind: "topic" | "artifact";
    format: "html" | "markdown" | "json";
    output?: string;
    singleFile?: boolean;
  },
) {
  const database = await readonlyModelDatabase(root);
  let artifact: Record<string, unknown>;
  try {
    const view =
      input.resourceKind === "topic"
        ? artifactForTopic(database, resourceId)
        : artifactView(database, resourceId);
    artifact = view.artifact as Record<string, unknown>;
  } finally {
    database.close();
  }
  const buildId = String(artifact.latest_build_id ?? "");
  if (!buildId) throw failure("artifact_not_built", "Artifact has no ready Build", "state");
  const loaded = await loadBuildPageIr(root, buildId);
  const pageIr = loaded.pageIr as PageIrV1;
  const output = resolveOutput(root, String(artifact.slug), input);
  let contentHash: string;
  if (input.format === "html" && !input.singleFile) {
    await copyHtmlExport(loaded.buildDirectory, output);
    contentHash = await directoryHash(output);
  } else {
    if (await Bun.file(output).exists())
      throw failure("artifact_export_exists", "Export output already exists", "conflict");
    await mkdir(dirname(output), { recursive: true });
    const content = await exportContent(root, pageIr, input.format);
    await atomicWrite(output, content);
    contentHash = await sha256File(output);
  }
  const writable = await writableModelDatabase(root);
  try {
    return {
      ...recordArtifactExport(writable, {
        artifactId: String(artifact.artifact_id),
        buildId,
        format: input.format,
        singleFile: Boolean(input.singleFile),
        outputPath: output,
        contentHash,
      }),
      output_path: output,
      content_hash: contentHash,
    };
  } finally {
    writable.close();
  }
}

async function exportContent(root: string, pageIr: PageIrV1, format: "html" | "markdown" | "json") {
  if (format === "json") return `${JSON.stringify(pageIr, null, 2)}\n`;
  if (format === "markdown") return pageIrMarkdown(pageIr);
  const assets = await loadArtifactTemplate(root, pageIr.template.id, pageIr.theme.id);
  return renderKnowledgeAtlas(pageIr, { css: assets.css });
}

function resolveOutput(
  root: string,
  slug: string,
  input: { format: string; output?: string; singleFile?: boolean },
) {
  if (input.output) return resolve(input.output);
  const base = join(root, "artifacts/exports");
  if (input.format === "html" && !input.singleFile) return join(base, slug);
  const extension =
    input.format === "markdown" ? ".md" : input.format === "json" ? ".json" : ".html";
  return join(base, `${slug}${extension}`);
}
