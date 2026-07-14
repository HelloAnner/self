import { join } from "node:path";
import {
  type ArtifactBuildKind,
  assertPageIr,
  type PageIrV1,
} from "../../domains/artifact/index.ts";
import {
  artifactBuildInputs,
  type BuildDependency,
  type BuildStart,
  failArtifactBuild,
  finishArtifactBuild,
  startArtifactBuild,
} from "../../infrastructure/artifact/artifact-repository.ts";
import { loadArtifactTemplate } from "../../infrastructure/artifact/template-assets.ts";
import { sha256Text } from "../../infrastructure/filesystem/hash.ts";
import {
  readonlyModelDatabase,
  writableModelDatabase,
} from "../../infrastructure/model/model-db.ts";
import { topicReport } from "../../infrastructure/topic/topic-query-repository.ts";
import { renderKnowledgeAtlas } from "../../renderer/components/page.tsx";
import { failure } from "../../shared/errors/self-error.ts";
import {
  createArchiveWriter,
  publishArchive,
  safeRemoveTemporary,
  updateArtifactPointers,
} from "./artifact-files.ts";
import { createTopicPageIr } from "./page-ir.ts";

type Row = Record<string, unknown>;

export async function buildTopicArtifact(
  root: string,
  topicId: string,
  topicSnapshotId: string,
  input: { kind: ArtifactBuildKind; templateId?: string; themeId?: string },
) {
  const started = performance.now();
  const assets = await loadArtifactTemplate(root, input.templateId, input.themeId);
  let database = await readonlyModelDatabase(root);
  const report = topicReport(database, topicId, topicSnapshotId) as Row;
  const buildInputs = artifactBuildInputs(database, topicSnapshotId);
  database.close();
  const topic = row(report.topic);
  const snapshot = row(report.snapshot);
  const request = requestMarkdown(topic);
  const requestHash = sha256Text(request);
  const knowledgeHash = String(snapshot.snapshot_hash);
  database = await writableModelDatabase(root);
  let start: BuildStart;
  try {
    start = startArtifactBuild(database, {
      topicId,
      topicTitle: String(topic.name),
      topicSnapshotId,
      buildKind: input.kind,
      template: assets.template,
      theme: assets.theme,
      requestHash,
      knowledgeHash,
    });
  } finally {
    database.close();
  }
  const pageIr = createTopicPageIr(report, {
    artifactId: start.artifactId,
    buildId: start.buildId,
    parentBuildId: start.parentBuildId,
    buildKind: input.kind,
    templateId: assets.template.id,
    templateVersion: assets.template.version,
    themeId: assets.theme.id,
    themeVersion: assets.theme.version,
  });
  assertPageIr(pageIr);
  validateCitationHashes(pageIr);
  const dependencies = buildDependencies(report, pageIr, assets.template.hash, assets.theme.hash);
  const writer = await createArchiveWriter(root, start.buildId);
  let published = false;
  try {
    await writer.write("request.md", request, "text/markdown; charset=utf-8", "input");
    await writer.write("query-plan.json", json(buildInputs.retrieval), "application/json", "input");
    await writer.write(
      "retrieval.json",
      json(buildInputs.retrievalItems),
      "application/json",
      "input",
    );
    await writer.write(
      "knowledge-snapshot.json",
      json(report.knowledge_snapshot),
      "application/json",
      "input",
    );
    await writer.write("page.ir.json", json(pageIr), "application/json", "page_ir");
    await writer.write(
      "confidence.json",
      json(confidenceArchive(report)),
      "application/json",
      "data",
    );
    await writer.write("citations.json", json(pageIr.citations), "application/json", "data");
    await writer.write(
      "changes.json",
      json(changeArchive(snapshot, pageIr)),
      "application/json",
      "data",
    );
    const cssName = `${assets.theme.hash.slice(0, 16)}.css`;
    await writer.write(`assets/${cssName}`, assets.css, "text/css; charset=utf-8", "style");
    const html = renderKnowledgeAtlas(pageIr, { css: assets.css, cssHref: `./assets/${cssName}` });
    await writer.write("index.html", html, "text/html; charset=utf-8", "html");
    const pageIrHash = sha256Text(json(pageIr));
    const contentHash = sha256Text(html);
    const manifest = buildManifest(start, pageIr, writer.files, dependencies, {
      requestHash,
      knowledgeHash,
      pageIrHash,
      contentHash,
      templateHash: assets.template.hash,
      themeHash: assets.theme.hash,
      elapsedMs: elapsed(started),
      synthesis: buildInputs.synthesis,
      retrieval: buildInputs.retrieval,
    });
    await writer.write("manifest.json", json(manifest), "application/json", "manifest");
    const manifestFile = writer.files.find((file) => file.path === "manifest.json");
    if (!manifestFile) throw new Error("manifest file record missing");
    const destination = await publishArchive(root, writer.directory, start.relativeDirectory);
    published = true;
    database = await writableModelDatabase(root);
    let saved: Row;
    try {
      saved = finishArtifactBuild(database, {
        start,
        pageIr,
        pageIrHash,
        manifestHash: manifestFile.hash,
        contentHash,
        timings: { render_ms: elapsed(started), files: writer.files.length },
        warnings: [],
        dependencies,
        files: writer.files,
      }) as Row;
    } finally {
      database.close();
    }
    await updateArtifactPointers(root, {
      slug: start.slug,
      artifactId: start.artifactId,
      topicId,
      buildId: start.buildId,
      relativeDirectory: start.relativeDirectory,
      title: String(topic.name),
    });
    const components = rows(saved.components);
    return {
      artifact_id: start.artifactId,
      build_id: start.buildId,
      parent_build_id: start.parentBuildId,
      topic_snapshot_id: topicSnapshotId,
      build_kind: input.kind,
      state: "ready",
      relative_directory: start.relativeDirectory,
      index_path: join(destination, "index.html"),
      page_ir_hash: pageIrHash,
      manifest_hash: manifestFile.hash,
      component_count: pageIr.components.length,
      components_reused: components.filter((item) => item.reused_from_build_id).length,
      components_rebuilt: components.filter((item) => !item.reused_from_build_id).length,
      citation_count: pageIr.citations.length,
      render_ms: elapsed(started),
    };
  } catch (cause) {
    if (!published) await safeRemoveTemporary(writer.directory);
    database = await writableModelDatabase(root);
    try {
      failArtifactBuild(database, start.buildId, cause);
    } finally {
      database.close();
    }
    throw cause;
  }
}

export async function renderExistingArtifact(
  root: string,
  topicId: string,
  input: { templateId?: string; themeId?: string } = {},
) {
  const database = await readonlyModelDatabase(root);
  try {
    const topic = database
      .query<{ latest_snapshot_id: string | null }, [string]>(
        "SELECT latest_snapshot_id FROM topics WHERE topic_id = ?",
      )
      .get(topicId);
    if (!topic?.latest_snapshot_id)
      throw failure("topic_not_built", "Topic has no completed synthesis snapshot", "state");
    return buildTopicArtifact(root, topicId, topic.latest_snapshot_id, {
      kind: "render",
      ...(input.templateId ? { templateId: input.templateId } : {}),
      ...(input.themeId ? { themeId: input.themeId } : {}),
    });
  } finally {
    database.close();
  }
}

function buildDependencies(report: Row, pageIr: PageIrV1, templateHash: string, themeHash: string) {
  const dependencies: BuildDependency[] = [
    {
      kind: "topic_snapshot",
      id: pageIr.topic.snapshotId,
      hash: sha256Text(JSON.stringify(report.snapshot)),
      role: "input",
    },
    { kind: "template", id: pageIr.template.id, hash: templateHash, role: "render" },
    { kind: "theme", id: pageIr.theme.id, hash: themeHash, role: "render" },
  ];
  const knowledge = row(report.knowledge_snapshot);
  for (const claim of rows(knowledge.claims))
    dependencies.push({
      kind: "claim",
      id: String(claim.claim_id),
      hash: sha256Text(JSON.stringify(claim)),
      role: "input",
    });
  for (const section of rows(row(report.report).sections))
    for (const conclusion of rows(section.conclusions))
      for (const citation of rows(conclusion.citations)) {
        dependencies.push({
          kind: "chunk",
          id: String(citation.chunk_id),
          hash: String(citation.chunk_content_hash),
          role: "citation",
        });
        dependencies.push({
          kind: "revision",
          id: String(citation.revision_id),
          hash: String(citation.revision_content_hash),
          role: "citation",
        });
        dependencies.push({
          kind: "document",
          id: String(citation.document_id),
          hash: String(citation.revision_content_hash),
          role: "citation",
        });
      }
  const graph = row(knowledge.local_graph);
  for (const node of rows(graph.nodes))
    if (node.node_kind === "entity")
      dependencies.push({
        kind: "entity",
        id: String(node.node_id),
        hash: sha256Text(JSON.stringify(node)),
        role: "input",
      });
  for (const relation of rows(graph.relations))
    dependencies.push({
      kind: "relation",
      id: String(relation.relation_id),
      hash: sha256Text(JSON.stringify(relation)),
      role: "input",
    });
  return dependencies;
}

function buildManifest(
  start: BuildStart,
  pageIr: PageIrV1,
  files: Array<Record<string, unknown>>,
  dependencies: BuildDependency[],
  hashes: Row,
) {
  return {
    schema: "self.artifact-build-manifest",
    version: 1,
    build_id: start.buildId,
    artifact_id: start.artifactId,
    parent_build_id: start.parentBuildId,
    build_kind: pageIr.artifact.buildKind,
    state: "ready",
    created_at: start.createdAt,
    page_ir: { version: pageIr.version, hash: hashes.pageIrHash },
    template: { ...pageIr.template, hash: hashes.templateHash },
    theme: { ...pageIr.theme, hash: hashes.themeHash },
    request_hash: hashes.requestHash,
    knowledge_hash: hashes.knowledgeHash,
    content_hash: hashes.contentHash,
    synthesis: hashes.synthesis,
    retrieval: hashes.retrieval,
    dependencies,
    components: pageIr.components.map((component) => ({
      key: component.key,
      type: component.type,
      content_hash: component.contentHash,
      dependency_hash: component.dependencyHash,
    })),
    files,
    timings: { total_ms: hashes.elapsedMs },
  };
}

function validateCitationHashes(pageIr: PageIrV1) {
  const invalid = pageIr.citations.filter(
    (citation) => sha256Text(citation.excerpt) !== citation.excerptHash,
  );
  if (invalid.length > 0)
    throw failure(
      "artifact_citation_invalid",
      "Citation excerpt no longer matches evidence",
      "state",
      { details: { citation_ids: invalid.map((item) => item.citationId) } },
    );
}

function confidenceArchive(report: Row) {
  const snapshot = row(report.snapshot);
  return {
    health_status: snapshot.health_status,
    confidence_level: snapshot.confidence_level,
    confidence: snapshot.confidence_json,
    coverage: snapshot.coverage_json,
    sections: rows(row(report.report).sections).map((section) => ({
      section_id: section.section_id,
      confidence_level: section.confidence_level,
      confidence: section.confidence_json,
      coverage: section.coverage_json,
      health_status: section.health_status,
    })),
  };
}
function changeArchive(snapshot: Row, pageIr: PageIrV1) {
  return {
    topic_changes: snapshot.change_summary_json,
    parent_build_id: pageIr.artifact.parentBuildId,
    components: pageIr.components.map((component) => ({
      key: component.key,
      content_hash: component.contentHash,
      dependency_hash: component.dependencyHash,
    })),
  };
}
function requestMarkdown(topic: Row) {
  return `# ${String(topic.name)}\n\n## Scope\n\n${String(topic.scope_text)}\n\n## Exclude\n\n${String(topic.exclude_text || "None")}\n`;
}
function json(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
function elapsed(started: number) {
  return Math.round((performance.now() - started) * 100) / 100;
}
function row(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
}
function rows(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Row => Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}
