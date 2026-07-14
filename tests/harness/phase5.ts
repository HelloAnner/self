import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { openSqlite } from "../../src/infrastructure/db/connection.ts";
import { locateWorkspaceAssets } from "../../src/infrastructure/runtime/assets.ts";
import { VERSION } from "../../src/shared/version.ts";

type Record = {
  argv: string[];
  exit_code: number;
  duration_ms: number;
  stdout: string;
  stderr: string;
};
const repository = resolve(".");
const runRoot = resolve("data/test-runs/phase-5-real-cli");
const fixture = resolve(runRoot, "fixture");
const instance = resolve(runRoot, "instance");
const records: Record[] = [];
if (!runRoot.startsWith(resolve("data/test-runs"))) throw new Error("unsafe run path");
await rm(runRoot, { recursive: true, force: true });
await prepare();
await run(["bun", "run", "build"]);
const binary = resolve(
  "dist/local",
  `self-${process.platform}-${process.arch}`,
  process.platform === "win32" ? "self.exe" : "self",
);
ok(await run([binary, "init", instance, "--offline", "--json"]));
const source = ok(
  await run([
    binary,
    "--root",
    instance,
    "source",
    "add",
    fixture,
    "--kind",
    "directory",
    "--recursive",
    "--json",
  ]),
);
const sourceId = str(source.source_id);
const chat = ok(
  await run([
    binary,
    "--root",
    instance,
    "model",
    "add",
    "--provider",
    "fixture",
    "--capability",
    "chat",
    "--model",
    "fixture-graph-v1",
    "--revision",
    "fixed-v1",
    "--json",
  ]),
);
const chatId = str(chat.model_id);
const first = ok(
  await run([binary, "--root", instance, "graph", "build", "--model", chatId, "--json"]),
);
const generationA = str(first.generation_id);
assert(first.activated === true, "first graph did not activate");
const status = ok(await run([binary, "--root", instance, "graph", "status", "--json"]));
assert(status.active_generation_id === generationA, "wrong active graph");
const counts = status.counts as {
  nodes: number;
  relations: number;
  claims: number;
  unresolved: number;
};
assert(
  counts.nodes >= 15 && counts.relations >= 20 && counts.claims === 2 && counts.unresolved >= 1,
  "graph counts are incomplete",
);
ok(await run([binary, "--root", instance, "graph", "verify", "--deep", "--json"]));

const dbState = await withDb(instance, (db) => ({
  conflicts: numberValue(db, "SELECT COUNT(*) count FROM graph_conflict_sets"),
  claims: db
    .query<{ claim_id: string; status: string; confidence_json: string }, []>(
      "SELECT claim_id, status, confidence_json FROM graph_claims ORDER BY claim_id",
    )
    .all(),
  evidence: numberValue(db, "SELECT COUNT(*) count FROM graph_claim_evidence"),
  claim: db
    .query<{ claim_id: string }, []>("SELECT claim_id FROM graph_claims ORDER BY claim_id LIMIT 1")
    .get()?.claim_id,
  conflict: db
    .query<{ conflict_id: string }, []>("SELECT conflict_id FROM graph_conflict_sets LIMIT 1")
    .get()?.conflict_id,
  reference: db
    .query<{ reference_id: string }, []>(
      "SELECT reference_id FROM graph_unresolved_references LIMIT 1",
    )
    .get()?.reference_id,
  self: db
    .query<{ entity_id: string }, []>(
      "SELECT entity_id FROM graph_entities WHERE identity_key = 'project:self'",
    )
    .get()?.entity_id,
  sqlite: db
    .query<{ entity_id: string }, []>(
      "SELECT entity_id FROM graph_entities WHERE identity_key = 'technology:sqlite'",
    )
    .get()?.entity_id,
  chunk: db
    .query<{ chunk_id: string }, []>(
      "SELECT chunk_id FROM knowledge_chunks WHERE content_text LIKE '%SQLite%' LIMIT 1",
    )
    .get()?.chunk_id,
}));
assert(
  dbState.conflicts === 1 && dbState.evidence === 3,
  "claim evidence/conflict alignment failed",
);
assert(
  dbState.claims.every((claim) => claim.status === "disputed"),
  "conflicting claims were overwritten",
);
const sqliteConfidence = JSON.parse(
  dbState.claims.find((claim) => claim.claim_id === dbState.claim)?.confidence_json ?? "{}",
);
assert(
  sqliteConfidence.independent_source_count === 1,
  "duplicate Blob lineage inflated corroboration",
);
const claimId = str(dbState.claim);
const conflictId = str(dbState.conflict);
const selfId = str(dbState.self);
const sqliteId = str(dbState.sqlite);
const chunkId = str(dbState.chunk);
const referenceId = str(dbState.reference);
ok(
  await run([
    binary,
    "--root",
    instance,
    "graph",
    "subgraph",
    "--seed",
    selfId,
    "--nodes",
    "50",
    "--edges",
    "100",
    "--json",
  ]),
);
ok(await run([binary, "--root", instance, "graph", "predicate", "list", "--json"]));
ok(await run([binary, "--root", instance, "graph", "predicate", "show", "depends_on", "--json"]));
ok(await run([binary, "--root", instance, "graph", "unresolved", "show", referenceId, "--json"]));
ok(await run([binary, "--root", instance, "entity", "list", "--type", "project", "--json"]));
ok(await run([binary, "--root", instance, "entity", "aliases", selfId, "--json"]));
ok(await run([binary, "--root", instance, "entity", "mentions", selfId, "--json"]));
ok(await run([binary, "--root", instance, "entity", "candidates", "--name", "Self", "--json"]));
ok(await run([binary, "--root", instance, "claim", "show", claimId, "--json"]));
const evidence = ok<unknown[]>(
  await run([binary, "--root", instance, "claim", "evidence", claimId, "--json"]),
);
assert(
  evidence.length === 2 && evidence.every((item) => hasEvidence(item)),
  "Claim evidence chain is incomplete",
);
ok(await run([binary, "--root", instance, "claim", "relations", claimId, "--json"]));
ok(await run([binary, "--root", instance, "claim", "conflicts", claimId, "--json"]));
const conflict = ok(
  await run([binary, "--root", instance, "conflict", "show", conflictId, "--json"]),
);
assert((conflict.members as unknown[]).length === 2, "Conflict did not preserve both positions");
const confirmed = ok(
  await run([binary, "--root", instance, "claim", "confirm", claimId, "--json"]),
);
assert(confirmed.status === "user_confirmed", "Claim confirmation failed");
const confidence = JSON.parse(
  String(
    await withDb(
      instance,
      (db) =>
        db
          .query<{ confidence_json: string }, [string]>(
            "SELECT confidence_json FROM graph_claims WHERE claim_id = ?",
          )
          .get(claimId)?.confidence_json,
    ),
  ),
);
assert(
  confidence.dimensions.user_verification === 1 && confidence.level === "disputed",
  "confirmation hid conflict or missed dimension",
);

const neighbors = ok(
  await run([
    binary,
    "--root",
    instance,
    "graph",
    "neighbors",
    selfId,
    "--depth",
    "2",
    "--nodes",
    "50",
    "--edges",
    "100",
    "--json",
  ]),
);
assert(
  (neighbors.nodes as unknown[]).length > 2 && neighbors.truncated === false,
  "bounded neighbor query failed",
);
ok(
  await run([
    binary,
    "--root",
    instance,
    "graph",
    "path",
    selfId,
    sqliteId,
    "--max-depth",
    "4",
    "--json",
  ]),
);
ok(
  await run([
    binary,
    "--root",
    instance,
    "graph",
    "backlinks",
    str((source.documents as Array<{ document_id: string }>)[1]?.document_id),
    "--json",
  ]),
);
error(
  await run(
    [binary, "--root", instance, "graph", "neighbors", selfId, "--depth", "5", "--json"],
    2,
  ),
  "graph_traversal_limit",
);
ok(
  await run([
    binary,
    "--root",
    instance,
    "graph",
    "links",
    str((source.documents as Array<{ document_id: string }>)[0]?.document_id),
    "--json",
  ]),
);
ok(
  await run([
    binary,
    "--root",
    instance,
    "graph",
    "unresolved",
    "list",
    "--status",
    "missing",
    "--json",
  ]),
);

const userA = await createEntity(binary, "User A");
const userB = await createEntity(binary, "User B");
const relationPlan = ok(
  await run([
    binary,
    "--root",
    instance,
    "relation",
    "create",
    userA,
    "depends_on",
    sqliteId,
    "--evidence",
    chunkId,
    "--plan",
    "--json",
  ]),
);
const relation = ok(
  await run([binary, "--root", instance, "apply", str(relationPlan.plan_id), "--json"]),
);
ok(
  await run([binary, "--root", instance, "relation", "show", str(relation.relation_id), "--json"]),
);
ok(
  await run([
    binary,
    "--root",
    instance,
    "relation",
    "evidence",
    str(relation.relation_id),
    "--json",
  ]),
);
ok(
  await run([
    binary,
    "--root",
    instance,
    "relation",
    "confirm",
    str(relation.relation_id),
    "--json",
  ]),
);
ok(
  await run([
    binary,
    "--root",
    instance,
    "relation",
    "reject",
    str(relation.relation_id),
    "--reason",
    "test moderation",
    "--json",
  ]),
);
error(
  await run(
    [
      binary,
      "--root",
      instance,
      "relation",
      "create",
      userA,
      "invented_predicate",
      sqliteId,
      "--evidence",
      chunkId,
      "--plan",
      "--json",
    ],
    5,
  ),
  "unknown_predicate",
);
const mergePlan = ok(
  await run([binary, "--root", instance, "entity", "merge", userB, userA, "--plan", "--json"]),
);
assert(Number((mergePlan.impact as { aliases: number }).aliases) >= 0, "merge Plan omitted impact");
ok(await run([binary, "--root", instance, "apply", str(mergePlan.plan_id), "--json"]));
const redirected = ok(await run([binary, "--root", instance, "entity", "show", userB, "--json"]));
assert(redirected.status === "redirected", "merge did not preserve redirected Entity");

for (const format of ["json", "jsonld", "graphml"]) {
  const output = resolve(runRoot, `exports/graph.${format}`);
  ok(
    await run([
      binary,
      "--root",
      instance,
      "graph",
      "export",
      "--format",
      format,
      "--output",
      output,
      "--json",
    ]),
  );
  assert((await Bun.file(output).text()).length > 100, `${format} export is empty`);
}
const shadow = ok(
  await run([
    binary,
    "--root",
    instance,
    "graph",
    "rebuild",
    "--layer",
    "all",
    "--model",
    chatId,
    "--json",
  ]),
);
const generationB = str(shadow.generation_id);
assert(
  shadow.activated === false && (await activeGraph(instance)) === generationA,
  "shadow rebuild displaced active graph",
);
const diff = ok(
  await run([binary, "--root", instance, "graph", "diff", generationA, generationB, "--json"]),
);
assert(
  (diff.nodes as { equivalent: boolean }).equivalent &&
    (diff.relations as { equivalent: boolean }).equivalent &&
    (diff.claims as { equivalent: boolean }).equivalent,
  "unchanged full rebuild is not equivalent",
);
await activateGraph(binary, generationB);
await activateGraph(binary, generationA);
await run([binary, "--root", instance, "graph", "build", "--json"], 96, {
  SELF_TEST_CRASH_GRAPH_BEFORE_ACTIVATE: "1",
});
assert((await activeGraph(instance)) === generationA, "crashed shadow moved active pointer");

const embedding = ok(
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
    "fixture-embedding",
    "--revision",
    "fixed-v1",
    "--dimensions",
    "32",
    "--json",
  ]),
);
const spacePlan = ok(
  await run([
    binary,
    "--root",
    instance,
    "vector-space",
    "create",
    "--model",
    str(embedding.model_id),
    "--dimensions",
    "32",
    "--plan",
    "--json",
  ]),
);
const space = ok(
  await run([binary, "--root", instance, "apply", str(spacePlan.plan_id), "--json"]),
);
const spaceId = str(space.vector_space_id);
ok(await run([binary, "--root", instance, "vector-space", "build", spaceId, "--json"]));
ok(await run([binary, "--root", instance, "vector-space", "verify", spaceId, "--json"]));
const neighborGen = ok(
  await run([
    binary,
    "--root",
    instance,
    "graph",
    "rebuild",
    "--layer",
    "neighbors",
    "--vector-space",
    spaceId,
    "--json",
  ]),
);
assert(
  Number((neighborGen.neighbors as { neighbors: number }).neighbors) > 0,
  "SemanticNeighbor projection is empty",
);
assert((await maxNeighborRank(instance)) <= 8, "SemanticNeighbor exceeded Top-K");

await Bun.write(resolve(fixture, "c.md"), "# Gamma\n\nGamma now references [[a]].\n");
const sync = ok(await run([binary, "--root", instance, "source", "sync", sourceId, "--json"]));
assert(
  (sync.graph_projection as { graph_status: string }).graph_status === "ready",
  "Knowledge change did not refresh Graph",
);
assert(
  (await activeGraph(instance)) !== generationA,
  "incremental Graph did not switch generation",
);
ok(await run([binary, "--root", instance, "graph", "verify", "--json"]));
ok(await run([binary, "--root", instance, "entity", "confirm", selfId, "--json"]));
ok(
  await run([
    binary,
    "--root",
    instance,
    "entity",
    "reject",
    sqliteId,
    "--reason",
    "test moderation",
    "--json",
  ]),
);
ok(
  await run([
    binary,
    "--root",
    instance,
    "claim",
    "reject",
    str(dbState.claims.at(-1)?.claim_id),
    "--reason",
    "test moderation",
    "--json",
  ]),
);
ok(await run([binary, "--root", instance, "graph", "unresolved", "retry", "--all", "--json"]));

const migrationRoot = resolve(runRoot, "migration-instance");
ok(await run([binary, "init", migrationRoot, "--offline", "--json"]));
await run(["bun", "run", "tests/helpers/downgrade-to-schema5-fixture.ts", migrationRoot]);
const migrationPlan = ok(
  await run([binary, "--root", migrationRoot, "migration", "plan", "--json"]),
);
ok(await run([binary, "--root", migrationRoot, "apply", str(migrationPlan.plan_id), "--json"]));
assert(
  (await schemaVersion(migrationRoot)) === VERSION.databaseSchema,
  "Schema 5 to 6 migration failed",
);
ok(await run([binary, "--root", migrationRoot, "graph", "status", "--json"]));

await Bun.write(
  resolve(runRoot, "commands.jsonl"),
  `${records.map((record) => JSON.stringify({ argv: redact(record.argv), exit_code: record.exit_code, duration_ms: record.duration_ms })).join("\n")}\n`,
);
process.stdout.write(
  `${JSON.stringify({ ok: true, phase: 5, schema: VERSION.databaseSchema, commands: records.length, generation: await activeGraph(instance), conflicts: dbState.conflicts })}\n`,
);

async function prepare() {
  await mkdir(fixture, { recursive: true });
  const alpha =
    "---\ntitle: Alpha\ntags: [graph]\n---\n# Alpha\n\nAlpha links to [[b|Beta]] and [[missing-note]].\n\n@entity self|project|Self||project:self\n@entity db|technology|SQLite||technology:sqlite\n@claim self|depends_on|db|Self depends on SQLite.|fact|direct|primary-store\n";
  await Bun.write(resolve(fixture, "a.md"), alpha);
  await Bun.write(resolve(fixture, "a-copy.md"), alpha);
  await Bun.write(
    resolve(fixture, "b.md"),
    "# Beta\n\n[Gamma](c.md) and ![[c]].\n\n@entity self|project|Self||project:self\n@entity db|technology|PostgreSQL||technology:postgresql\n@claim self|depends_on|db|Self depends on PostgreSQL.|fact|direct|primary-store\n",
  );
  await Bun.write(resolve(fixture, "c.md"), "# Gamma\n\nContext.\n");
}

async function createEntity(binary: string, name: string) {
  const plan = ok(
    await run([
      binary,
      "--root",
      instance,
      "entity",
      "create",
      "--type",
      "project",
      "--name",
      name,
      "--user-asserted",
      "--plan",
      "--json",
    ]),
  );
  return str(
    ok(await run([binary, "--root", instance, "apply", str(plan.plan_id), "--json"])).entity_id,
  );
}

async function activateGraph(binary: string, generation: string) {
  const plan = ok(
    await run([binary, "--root", instance, "graph", "activate", generation, "--plan", "--json"]),
  );
  ok(await run([binary, "--root", instance, "apply", str(plan.plan_id), "--json"]));
}

async function withDb<T>(
  root: string,
  action: (db: ReturnType<typeof openSqlite>) => T,
): Promise<T> {
  const db = openSqlite(resolve(root, "data/self.sqlite3"), await locateWorkspaceAssets(root), {
    readonly: true,
  });
  try {
    return action(db);
  } finally {
    db.close();
  }
}

function numberValue(db: ReturnType<typeof openSqlite>, sql: string) {
  return db.query<{ count: number }, []>(sql).get()?.count ?? 0;
}
async function activeGraph(root: string) {
  return withDb(
    root,
    (db) =>
      db
        .query<{ id: string | null }, []>(
          "SELECT active_generation_id id FROM graph_active_generation",
        )
        .get()?.id ?? null,
  );
}
async function maxNeighborRank(root: string) {
  return withDb(
    root,
    (db) =>
      db
        .query<{ rank: number }, []>(
          "SELECT COALESCE(MAX(rank), 0) rank FROM graph_semantic_neighbors",
        )
        .get()?.rank ?? 0,
  );
}
async function schemaVersion(root: string) {
  return withDb(
    root,
    (db) => db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0,
  );
}
function hasEvidence(value: unknown) {
  const item = value as globalThis.Record<string, unknown>;
  return (
    typeof item.chunk_id === "string" &&
    typeof item.revision_id === "string" &&
    typeof item.excerpt_hash === "string" &&
    typeof item.document_id === "string" &&
    typeof item.snapshot_id === "string" &&
    typeof item.source_id === "string" &&
    typeof item.blob_sha256 === "string"
  );
}
function ok<T = globalThis.Record<string, unknown>>(record: Record): T {
  const value = JSON.parse(record.stdout);
  assert(value.ok === true, record.stdout);
  return value.data as T;
}
function error(record: Record, code: string) {
  const value = JSON.parse(record.stdout);
  assert(value.ok === false && value.error?.code === code, record.stdout);
}
function str(value: unknown): string {
  if (typeof value !== "string") throw new Error("expected string");
  return value;
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function redact(argv: string[]) {
  return argv.map((value) => (value.includes("sk-") ? "<redacted>" : value));
}

async function run(
  argv: string[],
  expected = 0,
  env: globalThis.Record<string, string> = {},
): Promise<Record> {
  const started = performance.now();
  const child = Bun.spawn(argv, {
    cwd: repository,
    env: {
      HOME: resolve(runRoot, "home"),
      TMPDIR: resolve(runRoot, "tmp"),
      XDG_CACHE_HOME: resolve(runRoot, "cache"),
      PATH: process.env.PATH ?? "",
      SELF_ENABLE_TEST_PROVIDERS: "1",
      ...env,
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
