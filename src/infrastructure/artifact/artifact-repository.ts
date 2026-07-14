import type { Database } from "bun:sqlite";
import type { PageIrV1 } from "../../domains/artifact/index.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { sha256Text } from "../../shared/hash/sha256.ts";
import { createResourceId } from "../../shared/ids/id.ts";

type Row = Record<string, unknown>;

export type BuildStart = {
  artifactId: string;
  buildId: string;
  parentBuildId: string | null;
  slug: string;
  relativeDirectory: string;
  createdAt: string;
};

export function startArtifactBuild(
  database: Database,
  input: {
    topicId: string;
    topicTitle: string;
    topicSnapshotId: string;
    buildKind: "full" | "refresh" | "render";
    template: RegistryAsset;
    theme: RegistryAsset;
    requestHash: string;
    knowledgeHash: string;
  },
): BuildStart {
  const now = new Date().toISOString();
  const buildId = createResourceId("build");
  return database.transaction(() => {
    registerAssets(database, input.template, input.theme, now);
    let artifact = database
      .query<{ artifact_id: string; slug: string; latest_build_id: string | null }, [string]>(
        "SELECT artifact_id, slug, latest_build_id FROM artifacts WHERE topic_id = ?",
      )
      .get(input.topicId);
    if (!artifact) {
      artifact = {
        artifact_id: createResourceId("artifact"),
        slug: topicSlug(input.topicTitle, input.topicId),
        latest_build_id: null,
      };
      database
        .prepare(
          `INSERT INTO artifacts(artifact_id, artifact_type, topic_id, slug, title, status,
           created_at, updated_at) VALUES (?, 'topic_report', ?, ?, ?, 'stale', ?, ?)`,
        )
        .run(artifact.artifact_id, input.topicId, artifact.slug, input.topicTitle, now, now);
    }
    const directory = `artifacts/topics/${artifact.slug}/builds/${buildDirectory(now, buildId)}`;
    database
      .prepare(
        `INSERT INTO artifact_builds(build_id, artifact_id, parent_build_id,
         topic_snapshot_id, build_kind, state, page_ir_version, template_id,
         template_version, theme_id, theme_version, renderer_version, relative_directory,
         request_hash, knowledge_hash, created_at)
         VALUES (?, ?, ?, ?, ?, 'building', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        buildId,
        artifact.artifact_id,
        artifact.latest_build_id,
        input.topicSnapshotId,
        input.buildKind,
        input.template.id,
        input.template.version,
        input.theme.id,
        input.theme.version,
        input.template.rendererVersion,
        directory,
        input.requestHash,
        input.knowledgeHash,
        now,
      );
    return {
      artifactId: artifact.artifact_id,
      buildId,
      parentBuildId: artifact.latest_build_id,
      slug: artifact.slug,
      relativeDirectory: directory,
      createdAt: now,
    };
  })();
}

export function finishArtifactBuild(
  database: Database,
  input: {
    start: BuildStart;
    pageIr: PageIrV1;
    pageIrHash: string;
    manifestHash: string;
    contentHash: string;
    timings: Row;
    warnings: string[];
    dependencies: BuildDependency[];
    files: BuildFile[];
  },
) {
  const now = new Date().toISOString();
  database.transaction(() => {
    const previous = previousComponents(database, input.start.parentBuildId);
    const dependencyInsert = database.prepare(
      `INSERT INTO artifact_build_dependencies(build_id, dependency_kind, dependency_id,
       content_hash, role) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const dependency of uniqueDependencies(input.dependencies))
      dependencyInsert.run(
        input.start.buildId,
        dependency.kind,
        dependency.id,
        dependency.hash,
        dependency.role,
      );
    const componentInsert = database.prepare(
      `INSERT INTO artifact_build_components(build_id, component_key, ordinal, component_type,
       topic_section_id, content_hash, dependency_hash, reused_from_build_id,
       reused_from_component_key, payload_json, renderer_version, theme_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    input.pageIr.components.forEach((component, index) => {
      const before = previous.get(component.key);
      const reused =
        before?.content_hash === component.contentHash &&
        before.dependency_hash === component.dependencyHash;
      componentInsert.run(
        input.start.buildId,
        component.key,
        index + 1,
        component.type,
        component.topicSectionId,
        component.contentHash,
        component.dependencyHash,
        reused ? before.build_id : null,
        reused ? before.component_key : null,
        JSON.stringify(component.payload),
        "knowledge-atlas-react-v1",
        input.pageIr.theme.version,
      );
    });
    const fileInsert = database.prepare(
      `INSERT INTO artifact_build_files(build_id, relative_path, content_hash, byte_size,
       media_type, role) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const file of input.files)
      fileInsert.run(
        input.start.buildId,
        file.path,
        file.hash,
        file.bytes,
        file.mediaType,
        file.role,
      );
    database
      .prepare(
        `UPDATE artifact_builds SET state = 'ready', page_ir_hash = ?, manifest_hash = ?,
         content_hash = ?, timings_json = ?, warnings_json = ?, completed_at = ?
         WHERE build_id = ? AND state = 'building'`,
      )
      .run(
        input.pageIrHash,
        input.manifestHash,
        input.contentHash,
        JSON.stringify(input.timings),
        JSON.stringify(input.warnings),
        now,
        input.start.buildId,
      );
    database
      .prepare(
        `UPDATE artifacts SET latest_build_id = ?, status = 'ready', stale_reason = NULL,
         title = ?, version = version + 1, updated_at = ? WHERE artifact_id = ?`,
      )
      .run(input.start.buildId, input.pageIr.topic.title, now, input.start.artifactId);
  })();
  return artifactBuild(database, input.start.buildId);
}

export function failArtifactBuild(database: Database, buildId: string, cause: unknown) {
  const message = cause instanceof Error ? cause.message.slice(0, 500) : "Artifact build failed";
  database
    .prepare(
      `UPDATE artifact_builds SET state = 'failed', error_json = ?, completed_at = ?
       WHERE build_id = ? AND state = 'building'`,
    )
    .run(
      JSON.stringify({ code: "artifact_build_failed", message }),
      new Date().toISOString(),
      buildId,
    );
}

export function artifactBuildInputs(database: Database, topicSnapshotId: string) {
  const synthesis = database
    .query<Row, [string]>(
      `SELECT r.* FROM topic_synthesis_runs r JOIN topic_snapshots s
       ON s.synthesis_run_id = r.synthesis_run_id WHERE s.topic_snapshot_id = ?`,
    )
    .get(topicSnapshotId);
  if (!synthesis)
    throw failure("topic_snapshot_not_found", "Topic Snapshot does not exist", "not_found");
  const retrieval = synthesis.context_id
    ? database
        .query<Row, [string]>(
          `SELECT rr.*, ec.context_id, ec.context_hash, ec.token_budget, ec.token_count,
           ec.item_count, ec.prompt_spec_version FROM evidence_contexts ec
           JOIN retrieval_runs rr ON rr.retrieval_run_id = ec.retrieval_run_id
           WHERE ec.context_id = ?`,
        )
        .get(String(synthesis.context_id))
    : null;
  const retrievalItems = synthesis.context_id
    ? database
        .query<Row, [string]>(
          "SELECT * FROM evidence_context_items WHERE context_id = ? ORDER BY ordinal",
        )
        .all(String(synthesis.context_id))
    : [];
  return {
    synthesis: parseJson(synthesis),
    retrieval: retrieval ? parseJson(retrieval) : null,
    retrievalItems,
  };
}

export function artifactForTopic(database: Database, topicId: string) {
  const row = database
    .query<Row, [string]>("SELECT * FROM artifacts WHERE topic_id = ? AND status <> 'deleted'")
    .get(topicId);
  if (!row) throw failure("artifact_not_found", "Topic does not have an Artifact", "not_found");
  return artifactView(database, String(row.artifact_id));
}

export function artifactView(database: Database, artifactId: string) {
  const artifact = database
    .query<Row, [string]>("SELECT * FROM artifacts WHERE artifact_id = ?")
    .get(artifactId);
  if (!artifact) throw failure("artifact_not_found", "Artifact does not exist", "not_found");
  const latest = artifact.latest_build_id
    ? artifactBuild(database, String(artifact.latest_build_id))
    : null;
  return { artifact: parseJson(artifact), latest_build: latest };
}

export function artifactBuild(
  database: Database,
  buildId: string,
): Row & { components: Row[]; files: Row[] } {
  const build = database
    .query<Row, [string]>("SELECT * FROM artifact_builds WHERE build_id = ?")
    .get(buildId);
  if (!build)
    throw failure("artifact_build_not_found", "Artifact Build does not exist", "not_found");
  const components = database
    .query<Row, [string]>(
      `SELECT component_key, ordinal, component_type, topic_section_id, content_hash,
       dependency_hash, reused_from_build_id, reused_from_component_key
       FROM artifact_build_components WHERE build_id = ? ORDER BY ordinal`,
    )
    .all(buildId);
  const files = database
    .query<Row, [string]>(
      "SELECT * FROM artifact_build_files WHERE build_id = ? ORDER BY relative_path",
    )
    .all(buildId);
  return { ...parseJson(build), components, files };
}

export function listArtifacts(database: Database, status?: string) {
  return database
    .query<Row, [] | [string]>(
      `SELECT a.*, b.created_at latest_built_at, b.build_kind latest_build_kind
       FROM artifacts a LEFT JOIN artifact_builds b ON b.build_id = a.latest_build_id
       ${status ? "WHERE a.status = ?" : ""} ORDER BY a.updated_at DESC`,
    )
    .all(...(status ? [status] : []))
    .map(parseJson);
}

export function artifactHistory(database: Database, artifactId: string) {
  requireArtifact(database, artifactId);
  return database
    .query<Row, [string]>(
      `SELECT build_id, parent_build_id, topic_snapshot_id, build_kind, state,
       page_ir_version, template_id, template_version, theme_id, theme_version,
       renderer_version, relative_directory, page_ir_hash, manifest_hash, content_hash,
       timings_json, warnings_json, created_at, completed_at
       FROM artifact_builds WHERE artifact_id = ? ORDER BY created_at DESC`,
    )
    .all(artifactId)
    .map(parseJson);
}

export function listArtifactTemplates(database: Database) {
  return {
    templates: database
      .query<Row, []>("SELECT * FROM artifact_templates ORDER BY template_id")
      .all()
      .map(parseJson),
    themes: database
      .query<Row, []>("SELECT * FROM artifact_themes ORDER BY theme_id")
      .all()
      .map(parseJson),
  };
}

export function recordArtifactExport(
  database: Database,
  input: {
    artifactId: string;
    buildId: string;
    format: "html" | "markdown" | "json";
    singleFile: boolean;
    outputPath: string;
    contentHash: string;
  },
) {
  const exportId = createResourceId("export");
  database
    .prepare(
      `INSERT INTO artifact_exports(export_id, artifact_id, build_id, export_format,
       single_file, output_path, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      exportId,
      input.artifactId,
      input.buildId,
      input.format,
      input.singleFile ? 1 : 0,
      input.outputPath,
      input.contentHash,
      new Date().toISOString(),
    );
  return { export_id: exportId, ...input };
}

export function diffArtifactBuilds(database: Database, fromId: string, toId: string) {
  const from = artifactBuild(database, fromId);
  const to = artifactBuild(database, toId);
  if (from.artifact_id !== to.artifact_id)
    throw failure(
      "artifact_diff_scope_mismatch",
      "Builds belong to different Artifacts",
      "conflict",
    );
  const old = new Map((from.components as Row[]).map((item) => [String(item.component_key), item]));
  const current = new Map(
    (to.components as Row[]).map((item) => [String(item.component_key), item]),
  );
  return {
    artifact_id: from.artifact_id,
    from_build_id: fromId,
    to_build_id: toId,
    components_added: [...current.keys()].filter((key) => !old.has(key)),
    components_removed: [...old.keys()].filter((key) => !current.has(key)),
    components_modified: [...current.keys()].filter(
      (key) => old.has(key) && old.get(key)?.content_hash !== current.get(key)?.content_hash,
    ),
    components_unchanged: [...current.keys()].filter(
      (key) => old.get(key)?.content_hash === current.get(key)?.content_hash,
    ),
    knowledge_changed: from.knowledge_hash !== to.knowledge_hash,
    template_changed:
      from.template_version !== to.template_version || from.theme_version !== to.theme_version,
  };
}

export type RegistryAsset = {
  id: string;
  displayName: string;
  version: string;
  hash: string;
  relativePath: string;
  rendererVersion: string;
};
export type BuildDependency = { kind: string; id: string; hash: string; role: string };
export type BuildFile = {
  path: string;
  hash: string;
  bytes: number;
  mediaType: string;
  role: string;
};

function registerAssets(
  database: Database,
  template: RegistryAsset,
  theme: RegistryAsset,
  now: string,
) {
  database
    .prepare(
      `INSERT INTO artifact_templates(template_id, display_name, version, page_ir_version,
       content_hash, relative_path, status, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, 'active', ?, ?)
       ON CONFLICT(template_id) DO UPDATE SET display_name=excluded.display_name,
       version=excluded.version, content_hash=excluded.content_hash,
       relative_path=excluded.relative_path, updated_at=excluded.updated_at`,
    )
    .run(
      template.id,
      template.displayName,
      template.version,
      template.hash,
      template.relativePath,
      now,
      now,
    );
  database
    .prepare(
      `INSERT INTO artifact_themes(theme_id, display_name, version, content_hash,
       relative_path, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
       ON CONFLICT(theme_id) DO UPDATE SET display_name=excluded.display_name,
       version=excluded.version, content_hash=excluded.content_hash,
       relative_path=excluded.relative_path, updated_at=excluded.updated_at`,
    )
    .run(theme.id, theme.displayName, theme.version, theme.hash, theme.relativePath, now, now);
}

function previousComponents(database: Database, buildId: string | null) {
  if (!buildId)
    return new Map<
      string,
      { build_id: string; component_key: string; content_hash: string; dependency_hash: string }
    >();
  const rows = database
    .query<
      { build_id: string; component_key: string; content_hash: string; dependency_hash: string },
      [string]
    >(
      `SELECT build_id, component_key, content_hash, dependency_hash
       FROM artifact_build_components WHERE build_id = ?`,
    )
    .all(buildId);
  return new Map(rows.map((row) => [row.component_key, row]));
}

function uniqueDependencies(rows: BuildDependency[]) {
  const unique = new Map<string, BuildDependency>();
  for (const row of rows) unique.set(`${row.kind}\n${row.id}\n${row.role}`, row);
  return [...unique.values()];
}

function requireArtifact(database: Database, artifactId: string) {
  if (
    !database
      .query<{ id: string }, [string]>("SELECT artifact_id id FROM artifacts WHERE artifact_id = ?")
      .get(artifactId)
  )
    throw failure("artifact_not_found", "Artifact does not exist", "not_found");
}

function topicSlug(title: string, topicId: string) {
  const normalized = title
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 48);
  return `${normalized || "topic"}-${sha256Text(topicId).slice(0, 8)}`;
}

function buildDirectory(now: string, buildId: string) {
  return `${now.replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z")}_${sha256Text(buildId).slice(0, 8)}`;
}

function parseJson(row: Row) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      key.endsWith("_json") && typeof value === "string" ? JSON.parse(value) : value,
    ]),
  );
}
