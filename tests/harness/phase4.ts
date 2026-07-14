import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { openSqlite } from "../../src/infrastructure/db/connection.ts";
import { locateWorkspaceAssets } from "../../src/infrastructure/runtime/assets.ts";
import { VERSION } from "../../src/shared/version.ts";

type CommandRecord = {
  argv: string[];
  exit_code: number;
  duration_ms: number;
  stdout: string;
  stderr: string;
};

const repository = resolve(".");
const runRoot = resolve("data/test-runs/phase-4-real-cli");
const fixtureRoot = resolve(runRoot, "fixtures/vault");
const largeConnectionRoot = resolve(runRoot, "fixtures/large-connection");
const instance = resolve(runRoot, "instance");
const records: CommandRecord[] = [];
assertTestPath(runRoot);
await rm(runRoot, { recursive: true, force: true });
await prepareFixtures();
await run(["bun", "run", "build"]);
const binary = resolve(
  "dist/local",
  `self-${process.platform}-${process.arch}`,
  process.platform === "win32" ? "self.exe" : "self",
);
expectOk(await run([binary, "init", instance, "--offline", "--json"]));
expectOk(
  await run([
    binary,
    "--root",
    instance,
    "config",
    "set",
    "ingestion.max_chunk_tokens",
    "20",
    "--json",
  ]),
);
expectOk(
  await run([
    binary,
    "--root",
    instance,
    "config",
    "set",
    "ingestion.chunk_overlap_tokens",
    "2",
    "--json",
  ]),
);

const source = expectOk(
  await run([
    binary,
    "--root",
    instance,
    "source",
    "add",
    fixtureRoot,
    "--kind",
    "directory",
    "--recursive",
    "--json",
  ]),
);
const sourceId = requireString(source.source_id);
assert(source.ingestion_status === "ready", "Fixture Source did not reach ready");
const initialFts = await activeFtsGeneration(instance);
assert(initialFts, "Initial Ingestion did not create an active FTS Generation");

const english = searchData(
  expectOk(
    await run([
      binary,
      "--root",
      instance,
      "search",
      "immutable evidence",
      "--mode",
      "text",
      "--explain",
      "--json",
    ]),
  ),
);
assert(english.results.length > 0, "English FTS did not return evidence");
assertEvidence(english.results[0]);
const chinese = searchData(
  expectOk(
    await run([binary, "--root", instance, "search", "本地知识证据", "--mode", "text", "--json"]),
  ),
);
assert(chinese.results.length > 0, "Chinese trigram FTS did not return evidence");
const tagged = searchData(
  expectOk(
    await run([
      binary,
      "--root",
      instance,
      "search",
      "evidence",
      "--mode",
      "text",
      "--tag",
      "phase4",
      "--path",
      "architecture.md",
      "--type",
      "text/markdown",
      "--source",
      sourceId,
      "--json",
    ]),
  ),
);
assert(tagged.results.length > 0, "Combined Search filters removed valid evidence");
expectOk(await run([binary, "--root", instance, "search", '" OR *', "--mode", "text", "--json"]));
const degradedBeforeActive = searchData(
  expectOk(
    await run([binary, "--root", instance, "search", "evidence", "--mode", "hybrid", "--json"]),
  ),
);
assert(
  degradedBeforeActive.warnings.includes("vector_degraded") &&
    degradedBeforeActive.results.length > 0,
  "Hybrid Search did not explicitly degrade before Vector activation",
);
expectError(
  await run([binary, "--root", instance, "search", "evidence", "--mode", "vector", "--json"], 5),
  "vector_space_not_active",
);

const modelA = expectOk(
  await run([
    binary,
    "--root",
    instance,
    "model",
    "add",
    "--provider",
    "fixture",
    "--capability",
    "embedding",
    "--model",
    "fixture-embedding-a",
    "--revision",
    "fixture-a-v1",
    "--dimensions",
    "32",
    "--json",
  ]),
);
const modelAId = requireString(modelA.model_id);
expectOk(
  await run([
    binary,
    "--root",
    instance,
    "model",
    "test",
    modelAId,
    "--suite",
    "embedding-compat",
    "--json",
  ]),
);
expectOk(
  await run([binary, "--root", instance, "model", "list", "--capability", "embedding", "--json"]),
);
expectOk(await run([binary, "--root", instance, "model", "show", modelAId, "--json"]));
const dashscope = expectOk(
  await run([
    binary,
    "--root",
    instance,
    "model",
    "add",
    "--provider",
    "dashscope",
    "--capability",
    "embedding",
    "--model",
    "text-embedding-v4",
    "--revision",
    "floating",
    "--dimensions",
    "1024",
    "--json",
  ]),
);
expectError(
  await run(
    [
      binary,
      "--root",
      instance,
      "model",
      "test",
      requireString(dashscope.model_id),
      "--suite",
      "embedding-compat",
      "--json",
    ],
    5,
  ),
  "model_network_disabled",
);
expectOk(
  await run([binary, "--root", instance, "config", "set", "models.offline", "false", "--json"]),
);
expectError(
  await run(
    [
      binary,
      "--root",
      instance,
      "model",
      "test",
      requireString(dashscope.model_id),
      "--suite",
      "embedding-compat",
      "--json",
    ],
    6,
  ),
  "model_credentials_missing",
);

const spaceA = await createSpace(binary, modelAId, 32);
const prematureActivation = expectOk(
  await run([binary, "--root", instance, "vector-space", "activate", spaceA, "--plan", "--json"]),
);
expectError(
  await run(
    [binary, "--root", instance, "apply", requireString(prematureActivation.plan_id), "--json"],
    5,
  ),
  "vector_space_not_ready",
);
await run(
  [binary, "--root", instance, "vector-space", "build", spaceA, "--batch-size", "1", "--json"],
  99,
  { SELF_TEST_CRASH_VECTOR_AFTER_BATCH: "1" },
);
assert(
  (await vectorBuildState(instance, spaceA)) === "building",
  "Vector crash checkpoint was not durable",
);
const embeddingsAfterCrash = await embeddingCount(instance, spaceA);
assert(embeddingsAfterCrash === 1, "Vector crash did not commit exactly one batch");
const resumedBuild = expectOk(
  await run([
    binary,
    "--root",
    instance,
    "vector-space",
    "build",
    spaceA,
    "--batch-size",
    "1",
    "--json",
  ]),
);
assert(resumedBuild.state === "verifying", "Vector build did not resume to verifying");
assert(
  (await embeddingCount(instance, spaceA)) > embeddingsAfterCrash,
  "Vector retry did not continue",
);
expectOk(
  await run([binary, "--root", instance, "vector-space", "verify", spaceA, "--deep", "--json"]),
);
await activateSpace(binary, spaceA);
expectOk(await run([binary, "--root", instance, "vector-space", "active", "--json"]));
expectOk(await run([binary, "--root", instance, "vector-space", "show", spaceA, "--json"]));
expectOk(await run([binary, "--root", instance, "vector-space", "list", "--json"]));

const hybridA = searchData(
  expectOk(
    await run([
      binary,
      "--root",
      instance,
      "search",
      "source snapshot immutable",
      "--mode",
      "hybrid",
      "--explain",
      "--json",
    ]),
  ),
);
assert(hybridA.trace?.vector_space_id === spaceA, "Hybrid Search did not use active Space A");
assert(
  hybridA.results.some((item) => item.routes.length === 2),
  "Hybrid Search did not fuse two routes",
);
const queryInvocations = await queryInvocationCount(instance);
expectOk(
  await run([
    binary,
    "--root",
    instance,
    "search",
    "source snapshot immutable",
    "--mode",
    "hybrid",
    "--json",
  ]),
);
assert(
  (await queryInvocationCount(instance)) === queryInvocations,
  "Repeated Query did not reuse Root-local Query Embedding cache",
);
const vectorOnly = searchData(
  expectOk(
    await run([
      binary,
      "--root",
      instance,
      "search",
      "durable evidence",
      "--mode",
      "vector",
      "--json",
    ]),
  ),
);
assert(vectorOnly.results.length > 0, "Vector Search returned no results");

const modelB = expectOk(
  await run([
    binary,
    "--root",
    instance,
    "model",
    "add",
    "--provider",
    "fixture",
    "--capability",
    "embedding",
    "--model",
    "fixture-embedding-b",
    "--revision",
    "fixture-b-v1",
    "--dimensions",
    "32",
    "--json",
  ]),
);
const modelBId = requireString(modelB.model_id);
const spaceB = await createSpace(binary, modelBId, 32);
const whileShadowBuilding = searchData(
  expectOk(
    await run([
      binary,
      "--root",
      instance,
      "search",
      "immutable evidence",
      "--mode",
      "hybrid",
      "--explain",
      "--json",
    ]),
  ),
);
assert(
  whileShadowBuilding.trace?.vector_space_id === spaceA,
  "Shadow build displaced active Space A",
);
expectOk(await run([binary, "--root", instance, "vector-space", "build", spaceB, "--json"]));
expectOk(
  await run([binary, "--root", instance, "vector-space", "verify", spaceB, "--deep", "--json"]),
);
const compared = expectOk(
  await run([
    binary,
    "--root",
    instance,
    "vector-space",
    "compare",
    spaceA,
    spaceB,
    "--fixture",
    "phase4-golden-v1",
    "--json",
  ]),
);
assert(compared.same_fingerprint === false, "Different Models produced the same space fingerprint");
await activateSpace(binary, spaceB);
const hybridB = searchData(
  expectOk(
    await run([
      binary,
      "--root",
      instance,
      "search",
      "immutable evidence",
      "--mode",
      "hybrid",
      "--explain",
      "--json",
    ]),
  ),
);
assert(hybridB.trace?.vector_space_id === spaceB, "Activation did not switch to Space B");
await activateSpace(binary, spaceA);
assert((await activeVectorSpaceId(instance)) === spaceA, "Deprecated Space A could not roll back");

const migrated = expectOk(
  await run([
    binary,
    "--root",
    instance,
    "vector-space",
    "migrate",
    "--from",
    spaceA,
    "--to-model",
    modelBId,
    "--dimensions",
    "32",
    "--from-local-chunks",
    "--plan",
    "--json",
  ]),
);
const migratedResult = expectOk(
  await run([binary, "--root", instance, "apply", requireString(migrated.plan_id), "--json"]),
);
assert(
  migratedResult.vector_space_id === spaceB,
  "Migration did not reuse compatible shadow Space B",
);
await deleteSpace(binary, spaceB);

expectError(
  await run([binary, "--root", instance, "vector-space", "verify", spaceA, "--deep", "--json"], 6, {
    SELF_TEST_EMBEDDING_DRIFT: "1",
  }),
  "model_drift_detected",
);
const driftDegraded = searchData(
  expectOk(
    await run([binary, "--root", instance, "search", "evidence", "--mode", "hybrid", "--json"]),
  ),
);
assert(driftDegraded.warnings.includes("vector_degraded"), "Drift did not degrade Hybrid Search");
expectError(
  await run([binary, "--root", instance, "search", "evidence", "--mode", "vector", "--json"], 6),
  "model_provider_unavailable",
);
expectOk(
  await run([
    binary,
    "--root",
    instance,
    "model",
    "test",
    modelAId,
    "--suite",
    "embedding-compat",
    "--json",
  ]),
);
expectOk(
  await run([binary, "--root", instance, "vector-space", "verify", spaceA, "--deep", "--json"]),
);

await Bun.write(
  resolve(fixtureRoot, "architecture.md"),
  architectureFixture("quantum orchard update"),
);
const synced = expectOk(
  await run([binary, "--root", instance, "source", "sync", sourceId, "--json"]),
);
assert(
  (synced.vector_projection as { state?: string } | undefined)?.state === "ready",
  "Incremental Source did not refresh active vectors",
);
assert(
  await activeVectorCoverageComplete(instance, spaceA),
  "Incremental vector coverage is incomplete",
);
const incremental = searchData(
  expectOk(
    await run([
      binary,
      "--root",
      instance,
      "search",
      "quantum orchard",
      "--mode",
      "hybrid",
      "--json",
    ]),
  ),
);
assert(incremental.results.length > 0, "Incremental FTS/Vector indexes missed new evidence");

await run([binary, "--root", instance, "knowledge", "rebuild", "--layer", "fts", "--json"], 98, {
  SELF_TEST_CRASH_FTS_BEFORE_SWAP: "1",
});
assert(
  (await activeFtsGeneration(instance)) === initialFts,
  "Crashed FTS shadow build moved active pointer",
);
const afterFtsCrash = searchData(
  expectOk(
    await run([
      binary,
      "--root",
      instance,
      "search",
      "quantum orchard",
      "--mode",
      "text",
      "--explain",
      "--json",
    ]),
  ),
);
assert(
  afterFtsCrash.trace?.fts_generation_id === initialFts,
  "Old FTS did not serve after shadow crash",
);
expectOk(
  await run([binary, "--root", instance, "knowledge", "rebuild", "--layer", "fts", "--json"]),
);
const rebuiltFts = await activeFtsGeneration(instance);
assert(rebuiltFts && rebuiltFts !== initialFts, "FTS rebuild did not atomically switch Generation");
expectOk(
  await run([binary, "--root", instance, "knowledge", "rebuild", "--layer", "vectors", "--json"]),
);
const rebuiltAll = expectOk<Record<string, unknown>[]>(
  await run([
    binary,
    "--root",
    instance,
    "knowledge",
    "rebuild",
    "--layer",
    "all",
    "--source",
    sourceId,
    "--json",
  ]),
);
assert(
  rebuiltAll.at(-1)?.layer === "vectors" && rebuiltAll.at(-1)?.state === "ready",
  "Knowledge all rebuild did not include active vector catch-up",
);
expectOk(await run([binary, "--root", instance, "knowledge", "verify", "--deep", "--json"]));

const largeConnection = expectOk(
  await run([
    binary,
    "--root",
    instance,
    "connection",
    "add",
    largeConnectionRoot,
    "--kind",
    "directory",
    "--recursive",
    "--include",
    "*.md",
    "--settle",
    "0ms",
    "--delete-grace",
    "0ms",
    "--no-daemon",
    "--json",
  ]),
);
assert(
  Array.isArray(largeConnection.change_batch_ids) && largeConnection.change_batch_ids.length === 2,
  "Large Connection scan was not split into deterministic bounded batches",
);
assert(
  await largeConnectionBatchesComplete(instance, requireString(largeConnection.connection_id)),
  "Large Connection batches did not all reach ingested",
);

await verifySchemaMigration(binary);
await verifyDatabase(instance, spaceA);
await Bun.write(
  resolve(runRoot, "commands.jsonl"),
  `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
);
await Bun.write(
  resolve(runRoot, "result.json"),
  `${JSON.stringify(
    {
      status: "passed",
      commands: records.length,
      source_id: sourceId,
      active_vector_space_id: spaceA,
      private_notes_used: false,
      hosted_model_called: false,
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(`Phase 4 real CLI E2E passed: ${runRoot}\n`);

async function createSpace(binaryPath: string, modelId: string, dimensions: number) {
  const plan = expectOk(
    await run([
      binaryPath,
      "--root",
      instance,
      "vector-space",
      "create",
      "--model",
      modelId,
      "--dimensions",
      String(dimensions),
      "--plan",
      "--json",
    ]),
  );
  const created = expectOk(
    await run([binaryPath, "--root", instance, "apply", requireString(plan.plan_id), "--json"]),
  );
  return requireString(created.vector_space_id);
}

async function activateSpace(binaryPath: string, vectorSpaceId: string) {
  const plan = expectOk(
    await run([
      binaryPath,
      "--root",
      instance,
      "vector-space",
      "activate",
      vectorSpaceId,
      "--plan",
      "--json",
    ]),
  );
  return expectOk(
    await run([binaryPath, "--root", instance, "apply", requireString(plan.plan_id), "--json"]),
  );
}

async function deleteSpace(binaryPath: string, vectorSpaceId: string) {
  const plan = expectOk(
    await run([
      binaryPath,
      "--root",
      instance,
      "vector-space",
      "delete",
      vectorSpaceId,
      "--plan",
      "--json",
    ]),
  );
  const deleted = expectOk(
    await run([binaryPath, "--root", instance, "apply", requireString(plan.plan_id), "--json"]),
  );
  assert(deleted.state === "deleted", "Inactive VectorSpace was not deleted");
}

async function verifySchemaMigration(binaryPath: string) {
  const legacy = resolve(runRoot, "schema-4-instance");
  expectOk(await run([binaryPath, "init", legacy, "--offline", "--json"]));
  await run(["bun", "run", "tests/helpers/downgrade-to-schema4-fixture.ts", legacy]);
  const status = expectOk(await run([binaryPath, "--root", legacy, "status", "--json"]));
  assert(status.state === "needs_migration", "Schema 4 fixture did not require migration");
  const plan = expectOk(await run([binaryPath, "--root", legacy, "migration", "plan", "--json"]));
  const applied = expectOk(
    await run([binaryPath, "--root", legacy, "apply", requireString(plan.plan_id), "--json"]),
  );
  assert(
    applied.to_version === VERSION.databaseSchema,
    "Schema 4 migration did not reach Schema 5",
  );
  assert(
    await Bun.file(resolve(legacy, requireString(applied.backup_relative_path))).exists(),
    "Schema 4 migration backup is missing",
  );
}

async function verifyDatabase(root: string, activeSpaceId: string) {
  await withDatabase(root, (database) => {
    assert(
      database.query<{ value: string }, []>("PRAGMA integrity_check").get()?.value === "ok" ||
        database.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()
          ?.integrity_check === "ok",
      "Database integrity failed",
    );
    const active = activeVectorSpaceIdFromDatabase(database);
    assert(active === activeSpaceId, "Unexpected active VectorSpace");
    const space = database
      .query<{ state: string; dimensions: number }, [string]>(
        "SELECT state, dimensions FROM vector_spaces WHERE vector_space_id = ?",
      )
      .get(activeSpaceId);
    assert(space?.state === "ready", "Active VectorSpace is not ready");
    const mixed = database
      .query<{ count: number }, [string]>(
        `SELECT COUNT(*) count FROM knowledge_embeddings e
         JOIN vector_spaces v ON v.vector_space_id = e.vector_space_id
         WHERE e.vector_space_id != ? AND e.state = 'active'`,
      )
      .get(activeSpaceId)?.count;
    assert((mixed ?? 0) === 0, "Deleted shadow space retained active Embeddings");
    const unfinished = database
      .query<{ count: number }, []>(
        "SELECT COUNT(*) count FROM vector_build_runs WHERE state IN ('queued','building','verifying')",
      )
      .get()?.count;
    assert((unfinished ?? 0) === 0, "Vector build remained unfinished");
  });
}

async function prepareFixtures() {
  await mkdir(fixtureRoot, { recursive: true });
  await mkdir(largeConnectionRoot, { recursive: true });
  await Bun.write(resolve(fixtureRoot, "architecture.md"), architectureFixture("initial baseline"));
  await Bun.write(
    resolve(fixtureRoot, "中文知识.md"),
    "# 本地知识证据\n\n本地优先系统保留原始资料，并让每条结论都能回溯到可靠证据。\n\n持续更新不会覆盖历史版本。\n",
  );
  await Bun.write(
    resolve(fixtureRoot, "code.ts"),
    "export function stableEvidenceId(source: string): string {\n  return 'chunk:' + source;\n}\n",
  );
  await Bun.write(
    resolve(fixtureRoot, "operations.txt"),
    "Vector shadow rebuild keeps the active index serving queries. Provider failure degrades hybrid retrieval to full text evidence.\n",
  );
  for (let index = 0; index < 505; index += 1)
    await Bun.write(
      resolve(largeConnectionRoot, `batch-${String(index).padStart(3, "0")}.md`),
      `# Batch ${index}\n\nbounded connection batch evidence ${index}\n`,
    );
}

function architectureFixture(change: string) {
  return `---\ntags: [phase4, retrieval]\n---\n# Search Architecture\n\nThe source snapshot is immutable evidence for every indexed chunk.\n\n## Vector Space\n\nA vector space fingerprint locks model revision, dimensions, normalization, distance, and input instructions.\n\n## Update\n\n${change}. Incremental indexing must converge to a full rebuild without mixing spaces.\n`;
}

function searchData(value: Record<string, unknown>) {
  return value as unknown as {
    warnings: string[];
    results: Array<Record<string, unknown> & { routes: unknown[] }>;
    trace?: { vector_space_id: string | null; fts_generation_id: string };
  };
}

function assertEvidence(value: Record<string, unknown> | undefined) {
  assert(value, "Search result is missing");
  for (const key of [
    "chunk_id",
    "document_id",
    "revision_id",
    "snapshot_id",
    "blob_sha256",
    "source_id",
  ])
    assert(typeof value[key] === "string", `Search evidence is missing ${key}`);
}

async function activeFtsGeneration(root: string) {
  return withDatabase(
    root,
    (database) =>
      database
        .query<{ active_generation_id: string | null }, []>(
          "SELECT active_generation_id FROM knowledge_active_indexes WHERE index_kind = 'fts'",
        )
        .get()?.active_generation_id ?? null,
  );
}

async function vectorBuildState(root: string, space: string) {
  return withDatabase(
    root,
    (database) =>
      database
        .query<{ state: string }, [string]>(
          "SELECT state FROM vector_build_runs WHERE vector_space_id = ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(space)?.state,
  );
}

async function embeddingCount(root: string, space: string) {
  return withDatabase(
    root,
    (database) =>
      database
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) count FROM knowledge_embeddings WHERE vector_space_id = ? AND state = 'active'",
        )
        .get(space)?.count ?? 0,
  );
}

async function queryInvocationCount(root: string) {
  return withDatabase(
    root,
    (database) =>
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) count FROM model_invocations WHERE operation_kind = 'retrieval.query-embedding'",
        )
        .get()?.count ?? 0,
  );
}

async function activeVectorSpaceId(root: string) {
  return withDatabase(root, activeVectorSpaceIdFromDatabase);
}

function activeVectorSpaceIdFromDatabase(database: ReturnType<typeof openSqlite>) {
  return (
    database
      .query<{ active_vector_space_id: string | null }, []>(
        "SELECT active_vector_space_id FROM knowledge_active_vector_space WHERE singleton_id = 1",
      )
      .get()?.active_vector_space_id ?? null
  );
}

async function activeVectorCoverageComplete(root: string, space: string) {
  return withDatabase(root, (database) => {
    const active =
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) count FROM knowledge_chunks WHERE state = 'active'",
        )
        .get()?.count ?? 0;
    const embeddings =
      database
        .query<{ count: number }, [string]>(
          `SELECT COUNT(*) count FROM knowledge_embeddings e JOIN knowledge_chunks c ON c.chunk_id = e.chunk_id
           WHERE e.vector_space_id = ? AND e.state = 'active' AND c.state = 'active'
           AND e.chunk_content_hash = c.content_hash`,
        )
        .get(space)?.count ?? 0;
    return active > 0 && embeddings === active;
  });
}

async function largeConnectionBatchesComplete(root: string, connectionId: string) {
  return withDatabase(root, (database) => {
    const batches = database
      .query<{ item_count: number; ingested: number }, [string]>(
        `SELECT b.item_count,
         SUM(CASE WHEN i.state = 'ingested' THEN 1 ELSE 0 END) ingested
         FROM connection_change_batches b JOIN connection_change_items i ON i.batch_id = b.change_batch_id
         WHERE b.connection_id = ? GROUP BY b.change_batch_id ORDER BY b.created_at`,
      )
      .all(connectionId);
    return (
      batches.length === 2 &&
      batches.every((batch) => batch.item_count <= 500 && batch.ingested === batch.item_count) &&
      batches.reduce((sum, batch) => sum + batch.item_count, 0) === 505
    );
  });
}

async function withDatabase<T>(
  root: string,
  query: (database: ReturnType<typeof openSqlite>) => T,
): Promise<T> {
  const assets = await locateWorkspaceAssets(root);
  const database = openSqlite(resolve(root, "data/self.sqlite3"), assets, { readonly: true });
  try {
    return query(database);
  } finally {
    database.close();
  }
}

async function run(
  argv: string[],
  expected = 0,
  extraEnvironment: Record<string, string> = {},
): Promise<CommandRecord> {
  const started = performance.now();
  const child = Bun.spawn(argv, {
    cwd: repository,
    env: { ...isolatedEnvironment(), ...extraEnvironment },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const record = {
    argv,
    exit_code: exitCode,
    duration_ms: Math.round((performance.now() - started) * 100) / 100,
    stdout,
    stderr,
  };
  records.push(record);
  if (exitCode !== expected)
    throw new Error(
      `${argv.join(" ")} exited ${exitCode}, expected ${expected}: ${stdout}${stderr}`,
    );
  return record;
}

function expectOk<T = Record<string, unknown>>(record: CommandRecord): T {
  const envelope = JSON.parse(record.stdout);
  assert(envelope.ok === true, `Expected success envelope: ${record.stdout}`);
  return envelope.data as T;
}

function expectError(record: CommandRecord, code: string) {
  const envelope = JSON.parse(record.stdout);
  assert(
    envelope.ok === false && envelope.error?.code === code,
    `Expected ${code}: ${record.stdout}`,
  );
}

function isolatedEnvironment(): Record<string, string> {
  return {
    HOME: resolve(runRoot, "home"),
    TMPDIR: resolve(runRoot, "tmp"),
    XDG_CACHE_HOME: resolve(runRoot, "cache/xdg"),
    XDG_CONFIG_HOME: resolve(runRoot, "home/.config"),
    XDG_DATA_HOME: resolve(runRoot, "home/.local/share"),
    PATH: process.env.PATH ?? "",
    SELF_ENABLE_TEST_PROVIDERS: "1",
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function requireString(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected string");
  return value;
}

function assertTestPath(path: string) {
  if (!path.startsWith(resolve("data/test-runs"))) throw new Error(`Unsafe test path: ${path}`);
}
