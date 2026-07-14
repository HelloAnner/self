import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validatePageIr } from "../../src/domains/artifact/index.ts";
import { openSqlite } from "../../src/infrastructure/db/connection.ts";
import { sha256File } from "../../src/infrastructure/filesystem/hash.ts";
import { locateWorkspaceAssets } from "../../src/infrastructure/runtime/assets.ts";
import { VERSION } from "../../src/shared/version.ts";

type RunRecord = {
  argv: string[];
  exit_code: number;
  duration_ms: number;
  stdout: string;
  stderr: string;
};

const repository = resolve(".");
const runRoot = resolve("data/test-runs/phase-8-real-cli");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve("data/playwright-browsers");
const phase7Root = resolve("data/test-runs/phase-7-real-cli");
const instance = resolve(phase7Root, "instance");
const moved = resolve(runRoot, "moved-instance");
const records: RunRecord[] = [];
await rm(runRoot, { recursive: true, force: true });
await mkdir(runRoot, { recursive: true });
ok(await run(["bun", "run", "tests/harness/phase7.ts"]));

const binary = resolve(
  "dist/local",
  `self-${process.platform}-${process.arch}`,
  process.platform === "win32" ? "self.exe" : "self",
);
const ids = await withDb(instance, (database) => {
  const topic = database
    .query<{ topic_id: string }, []>(
      "SELECT topic_id FROM topics WHERE normalized_name = 'self agent knowledge'",
    )
    .get();
  const model = database
    .query<{ model_id: string }, []>(
      "SELECT model_id FROM models WHERE provider_model_id = 'fixture-topic-v1'",
    )
    .get();
  if (!topic || !model) throw new Error("Phase 7 prerequisite IDs are missing");
  return { topicId: topic.topic_id, modelId: model.model_id };
});
const before = await artifactState(instance, ids.topicId);
const hostile = resolve(runRoot, "hostile.md");
await Bun.write(
  hostile,
  [
    "# Self Agent hostile evidence",
    "",
    "@entity self|project|Self||project:self",
    "@entity archive|technology|Artifact Archive||technology:artifact-archive",
    "@claim self|uses|archive|Self evidence displays <script>globalThis.__SELF_PWNED__=true</script> as text.|fact|direct",
    "",
  ].join("\n"),
);
ok(
  await run([binary, "--root", instance, "source", "add", hostile, "--kind", "markdown", "--json"]),
);
ok(await run([binary, "--root", instance, "graph", "build", "--model", ids.modelId, "--json"]));
const refreshed = ok(
  await run([
    binary,
    "--root",
    instance,
    "topic",
    "refresh",
    ids.topicId,
    "--explain-changes",
    "--json",
  ]),
);
assert(refreshed.unchanged === false, "stale Topic refresh was incorrectly skipped");
const refreshedBuild = row(refreshed.artifact_build);
assert(refreshedBuild.build_kind === "refresh", "refresh did not create a refresh Build");
assert(Number(refreshedBuild.components_reused) > 0, "refresh reused no unaffected components");
assert(Number(refreshedBuild.components_rebuilt) > 0, "refresh rebuilt no affected components");
const refreshBuildId = str(refreshedBuild.build_id);
const afterRefresh = await artifactState(instance, ids.topicId);
assert(
  afterRefresh.buildCount === before.buildCount + 1,
  "refresh did not append exactly one Build",
);

const unchanged = ok(
  await run([binary, "--root", instance, "topic", "refresh", ids.topicId, "--json"]),
);
assert(unchanged.unchanged === true, "repeat refresh was not idempotent");
assert(
  row(unchanged.incremental).retrieval_skipped === true,
  "unchanged refresh did not skip retrieval",
);
const afterNoop = await artifactState(instance, ids.topicId);
assert(afterNoop.buildCount === afterRefresh.buildCount, "no-op refresh created another Build");

const rendered = ok(
  await run([binary, "--root", instance, "artifact", "render", ids.topicId, "--json"]),
);
assert(rendered.build_kind === "render", "artifact render did not create a render Build");
assert(
  Number(rendered.components_reused) === Number(rendered.component_count),
  "pure render did not reuse every Page IR component",
);
const renderBuildId = str(rendered.build_id);
const artifactId = afterRefresh.artifactId;
const diff = ok(
  await run([
    binary,
    "--root",
    instance,
    "topic",
    "diff",
    ids.topicId,
    "--from",
    refreshBuildId,
    "--to",
    renderBuildId,
    "--json",
  ]),
);
assert(diff.knowledge_changed === false, "pure render changed the knowledge snapshot");
assert((diff.components_modified as unknown[]).length === 0, "pure render modified component data");
const artifactList = ok<unknown[]>(
  await run([binary, "--root", instance, "artifact", "list", "--json"]),
);
assert(
  artifactList.some((item) => row(item).artifact_id === artifactId),
  "artifact list omitted the Topic Artifact",
);
ok(await run([binary, "--root", instance, "artifact", "show", artifactId, "--json"]));
ok(await run([binary, "--root", instance, "artifact", "history", artifactId, "--json"]));
ok(
  await run([
    binary,
    "--root",
    instance,
    "artifact",
    "diff",
    refreshBuildId,
    renderBuildId,
    "--json",
  ]),
);
ok(await run([binary, "--root", instance, "template", "list", "--json"]));
const history = ok<unknown[]>(
  await run([binary, "--root", instance, "topic", "history", ids.topicId, "--json"]),
);
assert(history.length === afterRefresh.buildCount + 1, "Build history is incomplete");

const opened = ok(await run([binary, "--root", instance, "topic", "open", ids.topicId, "--json"]));
assert(opened.launched === false, "test open unexpectedly launched an external application");
const artifactOpened = ok(
  await run([binary, "--root", instance, "artifact", "open", artifactId, "--json"]),
);
assert(artifactOpened.build_id === renderBuildId, "artifact open did not resolve latest Build");
const indexPath = str(opened.index_path);
const buildDirectory = resolve(indexPath, "..");
const pageIrPath = join(buildDirectory, "page.ir.json");
const pageIr = JSON.parse(await readFile(pageIrPath, "utf8"));
const validation = validatePageIr(pageIr);
assert(validation.valid, `Page IR validation failed: ${validation.errors.join(",")}`);
const manifest = JSON.parse(await readFile(join(buildDirectory, "manifest.json"), "utf8"));
assert(
  Array.isArray(manifest.dependencies) &&
    manifest.dependencies.some((item: Record<string, unknown>) =>
      item.dependency_kind === undefined ? item.kind === "claim" : item.dependency_kind === "claim",
    ),
  "BuildManifest does not record Claim dependencies",
);
await verifyBuildFiles(buildDirectory, manifest.files as Array<Record<string, unknown>>);
const html = await readFile(indexPath, "utf8");
assert(
  !html.includes("<script>globalThis.__SELF_PWNED__"),
  "source script reached executable HTML",
);
assert(
  html.includes("&lt;script&gt;globalThis.__SELF_PWNED__"),
  "hostile source text was not escaped",
);
assert(!/https?:\/\//u.test(html), "offline HTML contains a network URL");
await verifyRelativeAssets(buildDirectory, html);
await assertBuildImmutable(instance, renderBuildId);

const exportsRoot = resolve(runRoot, "exports");
const multiPath = resolve(exportsRoot, "multi");
const singlePath = resolve(exportsRoot, "single.html");
const markdownPath = resolve(exportsRoot, "report.md");
const jsonPath = resolve(exportsRoot, "report.json");
const artifactJsonPath = resolve(exportsRoot, "artifact.json");
ok(
  await run([
    binary,
    "--root",
    instance,
    "topic",
    "export",
    ids.topicId,
    "--format",
    "html",
    "--output",
    multiPath,
    "--json",
  ]),
);
ok(
  await run([
    binary,
    "--root",
    instance,
    "artifact",
    "export",
    artifactId,
    "--format",
    "json",
    "--output",
    artifactJsonPath,
    "--json",
  ]),
);
ok(
  await run([
    binary,
    "--root",
    instance,
    "topic",
    "export",
    ids.topicId,
    "--format",
    "html",
    "--single-file",
    "--output",
    singlePath,
    "--json",
  ]),
);
ok(
  await run([
    binary,
    "--root",
    instance,
    "topic",
    "export",
    ids.topicId,
    "--format",
    "markdown",
    "--output",
    markdownPath,
    "--json",
  ]),
);
ok(
  await run([
    binary,
    "--root",
    instance,
    "topic",
    "export",
    ids.topicId,
    "--format",
    "json",
    "--output",
    jsonPath,
    "--json",
  ]),
);
const singleHtml = await readFile(singlePath, "utf8");
assert(singleHtml.includes("<style>"), "single-file HTML did not inline its theme");
assert(!singleHtml.includes('rel="stylesheet"'), "single-file HTML still requires a CSS file");
const collision = await run(
  [
    binary,
    "--root",
    instance,
    "topic",
    "export",
    ids.topicId,
    "--format",
    "json",
    "--output",
    jsonPath,
    "--json",
  ],
  4,
);
assert(
  row(JSON.parse(collision.stdout).error).code === "artifact_export_exists",
  "export overwrite was not rejected",
);

const migrationRoot = resolve(runRoot, "migration-instance");
ok(await run([binary, "init", migrationRoot, "--offline", "--json"]));
await run(["bun", "run", "tests/helpers/downgrade-to-schema8-fixture.ts", migrationRoot]);
const migrationPlan = ok(
  await run([binary, "--root", migrationRoot, "migration", "plan", "--json"]),
);
ok(await run([binary, "--root", migrationRoot, "apply", str(migrationPlan.plan_id), "--json"]));
const migratedVersion = await withDb(
  migrationRoot,
  (database) =>
    database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0,
);
assert(migratedVersion === VERSION.databaseSchema, "Schema 8 to 9 migration failed");

await rename(instance, moved);
const movedStatus = ok(await run([binary, "--root", moved, "status", "--json"]));
assert(movedStatus.database_schema_version === VERSION.databaseSchema, "moved Root is not usable");
const movedIndex = indexPath.replace(instance, moved);
const browserEvidence = await browserCheck(movedIndex, singlePath);
await Bun.write(
  resolve(runRoot, "commands.jsonl"),
  `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
);
await Bun.write(
  resolve(runRoot, "result.json"),
  `${JSON.stringify(
    {
      ok: true,
      phase: 8,
      schema: VERSION.databaseSchema,
      topic_id: ids.topicId,
      refresh_build_id: refreshBuildId,
      render_build_id: renderBuildId,
      builds: history.length,
      components_reused_on_refresh: refreshedBuild.components_reused,
      components_rebuilt_on_refresh: refreshedBuild.components_rebuilt,
      page_ir_components: pageIr.components.length,
      citations: pageIr.citations.length,
      browser: browserEvidence,
      moved_root_verified: true,
      hostile_script_executed: false,
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(
  `${JSON.stringify({ ok: true, phase: 8, schema: VERSION.databaseSchema, builds: history.length, browser: browserEvidence })}\n`,
);

async function browserCheck(index: string, single: string) {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ offline: true });
    const network: string[] = [];
    const page = await context.newPage();
    page.on("request", (request) => {
      if (/^https?:/u.test(request.url())) network.push(request.url());
    });
    await page.goto(pathToFileURL(index).href);
    assert((await page.title()).includes("Self Agent knowledge"), "offline page title is missing");
    assert(
      (await page.locator("[data-component='evidence_blocks'] details").count()) > 0,
      "evidence drawers are missing",
    );
    const trust = page.locator(".trust-details").first();
    await trust.locator("summary").click();
    assert(
      await trust.evaluate((element) => (element as HTMLDetailsElement).open),
      "confidence drawer does not open",
    );
    assert(
      await page.evaluate(() => !("__SELF_PWNED__" in globalThis)),
      "hostile source script executed",
    );
    assert(network.length === 0, "offline page attempted a network request");
    await page.screenshot({ path: resolve(runRoot, "browser.png"), fullPage: true });
    const singlePage = await context.newPage();
    await singlePage.goto(pathToFileURL(single).href);
    assert(
      (await singlePage.locator("style").count()) === 1,
      "single-file export did not open standalone",
    );
    return {
      offline: true,
      network_requests: network.length,
      evidence_drawer: true,
      single_file: true,
      title: await page.title(),
    };
  } finally {
    await browser.close();
  }
}

async function verifyBuildFiles(directory: string, files: Array<Record<string, unknown>>) {
  for (const file of files) {
    const path = resolve(directory, String(file.path));
    assert(path.startsWith(`${directory}/`), "manifest file escaped the Build directory");
    assert((await stat(path)).isFile(), `manifest file is missing: ${file.path}`);
    assert((await sha256File(path)) === file.hash, `manifest hash differs: ${file.path}`);
  }
}

async function verifyRelativeAssets(directory: string, html: string) {
  const references = [...html.matchAll(/(?:href|src)="([^"#]+)"/gu)].map((match) => match[1] ?? "");
  for (const reference of references) {
    assert(!reference.startsWith("/"), `absolute HTML resource found: ${reference}`);
    assert(
      await Bun.file(resolve(directory, reference)).exists(),
      `HTML resource missing: ${reference}`,
    );
  }
}

async function assertBuildImmutable(root: string, buildId: string) {
  const assets = await locateWorkspaceAssets(root);
  const database = openSqlite(resolve(root, "data/self.sqlite3"), assets);
  try {
    let blocked = false;
    try {
      database
        .prepare("UPDATE artifact_builds SET content_hash = ? WHERE build_id = ?")
        .run("0".repeat(64), buildId);
    } catch (cause) {
      blocked = String(cause).includes("artifact_build_immutable");
    }
    assert(blocked, "ready Artifact Build UPDATE was not blocked");
  } finally {
    database.close();
  }
}

async function artifactState(root: string, topicId: string) {
  return withDb(root, (database) => {
    const artifact = database
      .query<{ artifact_id: string; latest_build_id: string }, [string]>(
        "SELECT artifact_id, latest_build_id FROM artifacts WHERE topic_id = ?",
      )
      .get(topicId);
    if (!artifact) throw new Error("Topic Artifact is missing");
    const count = database
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) count FROM artifact_builds WHERE artifact_id = ? AND state = 'ready'",
      )
      .get(artifact.artifact_id)?.count;
    return {
      artifactId: artifact.artifact_id,
      latestBuildId: artifact.latest_build_id,
      buildCount: count ?? 0,
    };
  });
}

async function withDb<T>(root: string, action: (database: ReturnType<typeof openSqlite>) => T) {
  const database = openSqlite(
    resolve(root, "data/self.sqlite3"),
    await locateWorkspaceAssets(root),
    { readonly: true },
  );
  try {
    return action(database);
  } finally {
    database.close();
  }
}

function ok<T = Record<string, unknown>>(record: RunRecord): T {
  const value = JSON.parse(record.stdout);
  assert(value.ok === true, record.stdout);
  return value.data as T;
}
function row(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function str(value: unknown) {
  if (typeof value !== "string") throw new Error("expected string");
  return value;
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function run(argv: string[], expected = 0): Promise<RunRecord> {
  const started = performance.now();
  const child = Bun.spawn(argv, {
    cwd: repository,
    env: {
      HOME: resolve(runRoot, "home"),
      TMPDIR: resolve(runRoot, "tmp"),
      XDG_CACHE_HOME: resolve(runRoot, "cache"),
      PATH: process.env.PATH ?? "",
      SELF_ENABLE_TEST_PROVIDERS: "1",
      SELF_NO_OPEN: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const record = {
    argv,
    exit_code: exit,
    duration_ms: Math.round((performance.now() - started) * 100) / 100,
    stdout,
    stderr,
  };
  records.push(record);
  if (exit !== expected)
    throw new Error(`${argv.join(" ")} exited ${exit}, expected ${expected}: ${stdout}${stderr}`);
  return record;
}
