import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { failure } from "../../shared/errors/self-error.ts";
import { sha256File } from "../filesystem/hash.ts";
import { locateReleaseAssets } from "../runtime/assets.ts";
import type { RegistryAsset } from "./artifact-repository.ts";

export type LoadedTemplate = {
  template: RegistryAsset;
  theme: RegistryAsset;
  css: string;
};

export async function loadArtifactTemplate(
  root: string,
  templateId = "knowledge-atlas",
  themeId = "self-light",
): Promise<LoadedTemplate> {
  const templateRelative = `templates/${templateId}/template.json`;
  const themeRelative = `templates/${templateId}/themes/${themeId}.css`;
  await copyBuiltinIfMissing(root, templateRelative);
  await copyBuiltinIfMissing(root, themeRelative);
  const templatePath = join(root, templateRelative);
  const themePath = join(root, themeRelative);
  let spec: Record<string, unknown>;
  try {
    spec = JSON.parse(await Bun.file(templatePath).text()) as Record<string, unknown>;
  } catch {
    throw failure("artifact_template_invalid", "Template metadata is not valid JSON", "state");
  }
  if (
    spec.id !== templateId ||
    spec.page_ir_version !== 1 ||
    typeof spec.version !== "string" ||
    typeof spec.renderer_version !== "string"
  )
    throw failure(
      "artifact_template_incompatible",
      "Template is incompatible with Page IR v1",
      "state",
    );
  const css = await Bun.file(themePath).text();
  return {
    template: {
      id: templateId,
      displayName: String(spec.display_name ?? templateId),
      version: String(spec.version),
      hash: await sha256File(templatePath),
      relativePath: templateRelative,
      rendererVersion: String(spec.renderer_version),
    },
    theme: {
      id: themeId,
      displayName: themeId === "self-light" ? "Self Light" : themeId,
      version: "1.0.0",
      hash: await sha256File(themePath),
      relativePath: themeRelative,
      rendererVersion: String(spec.renderer_version),
    },
    css,
  };
}

async function copyBuiltinIfMissing(root: string, relative: string) {
  const target = join(root, relative);
  if (await Bun.file(target).exists()) return;
  const release = await locateReleaseAssets();
  const sourceRelative = relative.replace(/^templates\//u, "");
  const source = join(release.templateDirectory, sourceRelative);
  if (!(await Bun.file(source).exists()))
    throw failure("artifact_template_missing", `Template asset is missing: ${relative}`, "state");
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}
