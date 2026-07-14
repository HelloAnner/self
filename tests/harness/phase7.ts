import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { openSqlite } from "../../src/infrastructure/db/connection.ts";
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
const runRoot = resolve("data/test-runs/phase-7-real-cli");
const fixture = resolve(runRoot, "fixture");
const instance = resolve(runRoot, "instance");
const records: RunRecord[] = [];
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
const sourceIds: string[] = [];
for (const name of [
  "a.md",
  "b.md",
  "repost.md",
  "opinion.md",
  "inference.md",
  "single.md",
  "conflict-a.md",
  "conflict-b.md",
  "excluded.md",
])
  sourceIds.push(
    str(
      ok(
        await run([
          binary,
          "--root",
          instance,
          "source",
          "add",
          resolve(fixture, name),
          "--kind",
          "markdown",
          "--json",
        ]),
      ).source_id,
    ),
  );
const modelId = str(
  ok(
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
      "fixture-topic-v1",
      "--revision",
      "fixed-v1",
      "--json",
    ]),
  ).model_id,
);
ok(await run([binary, "--root", instance, "graph", "build", "--model", modelId, "--json"]));
const topic = ok(
  await run([
    binary,
    "--root",
    instance,
    "topic",
    "create",
    "Self Agent knowledge",
    "--scope",
    "Self Agent knowledge storage reports inference conflict",
    "--exclude",
    "ordinary game Agent",
    "--alias",
    "trusted synthesis",
    "--json",
  ]),
);
const topicId = str(topic.topic_id);
assert((topic.aliases as string[]).includes("trusted synthesis"), "Topic alias was not saved");
const listed = ok<unknown[]>(await run([binary, "--root", instance, "topic", "list", "--json"]));
assert(
  listed.some((row) => (row as Record<string, unknown>).topic_id === topicId),
  "Topic list missed the Topic",
);

const first = ok(
  await run([binary, "--root", instance, "topic", "build", topicId, "--mode", "text", "--json"]),
);
const firstReport = first.report as Record<string, unknown>;
const snapshot = firstReport.snapshot as Record<string, unknown>;
const report = firstReport.report as Record<string, unknown>;
const sections = report.sections as Array<Record<string, unknown>>;
const types = sections.map((section) => String(section.section_kind));
for (const required of [
  "consensus",
  "single_source",
  "user_opinion",
  "inference",
  "conflict",
  "unknown",
])
  assert(types.includes(required), `Topic report missed ${required}`);
assert(
  snapshot.health_status === "needs_review",
  "unresolved conflict did not affect report health",
);
const claims = (firstReport.knowledge_snapshot as Record<string, unknown>).claims as Array<
  Record<string, unknown>
>;
const consensus = claims.find((claim) => claim.conclusion_type === "consensus");
assert(
  consensus?.independent_source_count === 2 && consensus.evidence_count === 3,
  "original sources and same-blob repost were counted incorrectly",
);
assert(
  !claims.some((claim) => String(claim.normalized_statement).includes("ordinary game agent")),
  "Topic exclusion condition was ignored",
);
const supported = sections
  .flatMap((section) => section.conclusions as Array<Record<string, unknown>>)
  .filter((conclusion) => conclusion.support_status === "supported");
assert(
  supported.length >= 6 &&
    supported.every((conclusion) => (conclusion.citations as unknown[]).length > 0),
  "a supported Topic conclusion has no evidence Citation",
);
const conflictSection = sections.find((section) => section.section_kind === "conflict");
const sectionId = str(conflictSection?.section_id);
const trace = ok(await run([binary, "--root", instance, "trace", sectionId, "--json"]));
assert(
  (trace.conclusions as Array<Record<string, unknown>>).every((conclusion) =>
    (conclusion.citations as Array<Record<string, unknown>>).every(
      (citation) => citation.excerpt_hash_matches === true,
    ),
  ),
  "Report Section evidence cannot be replayed",
);
assert(
  (trace.evidence_chains as Array<Record<string, unknown>>).every(
    (chain) =>
      chain.claim_id && chain.chunk_id && chain.revision_id && chain.snapshot_id && chain.source_id,
  ),
  "Report Section trace does not reach Source Snapshot",
);

const second = ok(
  await run([binary, "--root", instance, "topic", "build", topicId, "--mode", "text", "--json"]),
);
assert(second.sequence === 2, "second Topic build did not create an immutable version");
assert(second.snapshot_hash === first.snapshot_hash, "unchanged rebuild did not converge");
const secondSections = (
  (second.report as Record<string, unknown>).report as Record<string, unknown>
).sections as Array<Record<string, unknown>>;
assert(
  secondSections.every(
    (section) => section.change_kind === "unchanged" && section.parent_section_id,
  ),
  "unchanged Section lineage was not preserved",
);
const history = ok<unknown[]>(
  await run([binary, "--root", instance, "topic", "history", topicId, "--json"]),
);
assert(history.length === 2, "Topic history did not preserve both snapshots");
const oldReport = ok(
  await run([
    binary,
    "--root",
    instance,
    "topic",
    "report",
    topicId,
    "--snapshot",
    str(first.topic_snapshot_id),
    "--json",
  ]),
);
assert(
  (oldReport.snapshot as Record<string, unknown>).snapshot_hash === first.snapshot_hash,
  "historical Topic snapshot was overwritten",
);
await assertImmutable(instance, str(first.topic_snapshot_id));

ok(
  await run([
    binary,
    "--root",
    instance,
    "topic",
    "update",
    topicId,
    "--add-alias",
    "PKOS",
    "--if-version",
    "1",
    "--json",
  ]),
);
let shown = ok(await run([binary, "--root", instance, "topic", "show", topicId, "--json"]));
assert(
  shown.status === "stale" && shown.stale_reason === "topic_scope_changed",
  "scope change did not mark Topic stale",
);
ok(await run([binary, "--root", instance, "topic", "build", topicId, "--json"]));
await Bun.write(
  resolve(fixture, "inference.md"),
  `${await Bun.file(resolve(fixture, "inference.md")).text()}\nNew source material arrived.\n`,
);
ok(await run([binary, "--root", instance, "source", "sync", sourceIds[4] ?? "", "--json"]));
shown = ok(await run([binary, "--root", instance, "topic", "show", topicId, "--json"]));
assert(shown.status === "stale", "knowledge change did not mark Topic stale");
const affectedClaim = str(
  await withDb(
    instance,
    (db) =>
      db
        .query<{ claim_id: string }, [string]>(
          `SELECT claim_id FROM topic_snapshot_claims WHERE topic_snapshot_id =
         (SELECT latest_snapshot_id FROM topics WHERE topic_id = ?) LIMIT 1`,
        )
        .get(topicId)?.claim_id,
  ),
);
ok(
  await run([
    binary,
    "--root",
    instance,
    "claim",
    "reject",
    affectedClaim,
    "--reason",
    "fixture review",
    "--json",
  ]),
);
shown = ok(await run([binary, "--root", instance, "topic", "show", topicId, "--json"]));
assert(
  shown.status === "needs_review",
  "Claim moderation did not mark affected Topic needs_review",
);

const migrationRoot = resolve(runRoot, "migration-instance");
ok(await run([binary, "init", migrationRoot, "--offline", "--json"]));
await run(["bun", "run", "tests/helpers/downgrade-to-schema7-fixture.ts", migrationRoot]);
const migrationPlan = ok(
  await run([binary, "--root", migrationRoot, "migration", "plan", "--json"]),
);
ok(await run([binary, "--root", migrationRoot, "apply", str(migrationPlan.plan_id), "--json"]));
assert(
  (await schemaVersion(migrationRoot)) === VERSION.databaseSchema,
  "Schema 7 to current migration failed",
);
ok(await run([binary, "--root", migrationRoot, "topic", "create", "Migrated", "--json"]));

await Bun.write(
  resolve(runRoot, "commands.jsonl"),
  `${records
    .map((record) =>
      JSON.stringify({
        argv: record.argv,
        exit_code: record.exit_code,
        duration_ms: record.duration_ms,
      }),
    )
    .join("\n")}\n`,
);
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    phase: 7,
    schema: VERSION.databaseSchema,
    commands: records.length,
    topic_id: topicId,
    snapshots: history.length,
    conclusion_types: types,
  })}\n`,
);

async function prepare() {
  await mkdir(fixture, { recursive: true });
  const consensus =
    "# Self trusted knowledge\n\nSelf Agent knowledge synthesis uses a trusted store.\n\n@entity self|project|Self||project:self\n@entity sqlite|technology|SQLite||technology:sqlite\n@claim self|uses|sqlite|Self uses SQLite as its trusted knowledge store.|fact|direct\n";
  await Bun.write(resolve(fixture, "a.md"), consensus);
  await Bun.write(resolve(fixture, "repost.md"), consensus);
  await Bun.write(
    resolve(fixture, "b.md"),
    `# Independent Self source\n\n${consensus.slice(consensus.indexOf("Self Agent"))}`,
  );
  await Bun.write(
    resolve(fixture, "opinion.md"),
    "# Self report preference\n\n@entity owner|person|Owner||person:owner\n@entity reports|work|Evidence Reports||work:evidence-reports\n@claim owner|uses|reports|I prefer concise evidence reports.|user_opinion|direct\n",
  );
  await Bun.write(
    resolve(fixture, "inference.md"),
    "# Self Topic inference\n\n@entity topic|project|Self Topic||project:self-topic\n@entity graph|technology|Knowledge Graph||technology:knowledge-graph\n@claim topic|implements|graph|Self Topic likely benefits from graph alignment.|inference|inferred\n",
  );
  await Bun.write(
    resolve(fixture, "single.md"),
    "# Self community source\n\n@entity self|project|Self||project:self\n@entity community|organization|Self Community||organization:self-community\n@claim self|created_by|community|Self was created by its community.|fact|direct\n",
  );
  await Bun.write(
    resolve(fixture, "conflict-a.md"),
    "# Self Agent conflict local\n\n@entity agent|project|Self Agent||project:self-agent\n@entity local|technology|Local Model||technology:local-model\n@claim agent|depends_on|local|Self Agent depends on a local model.|fact|direct|primary-model\n",
  );
  await Bun.write(
    resolve(fixture, "conflict-b.md"),
    "# Self Agent conflict hosted\n\n@entity agent|project|Self Agent||project:self-agent\n@entity hosted|technology|Hosted Model||technology:hosted-model\n@claim agent|depends_on|hosted|Self Agent depends on a hosted model.|fact|direct|primary-model\n",
  );
  await Bun.write(
    resolve(fixture, "excluded.md"),
    "# Ordinary game Agent\n\n@entity game|project|Ordinary game Agent||project:game-agent\n@entity play|method|Normal Play||method:normal-play\n@claim game|uses|play|ordinary game agent uses normal play.|fact|direct\n",
  );
}

async function assertImmutable(root: string, snapshotId: string) {
  const assets = await locateWorkspaceAssets(root);
  const db = openSqlite(resolve(root, "data/self.sqlite3"), assets);
  try {
    let blocked = false;
    try {
      db.prepare("UPDATE topic_snapshots SET snapshot_hash = ? WHERE topic_snapshot_id = ?").run(
        "0".repeat(64),
        snapshotId,
      );
    } catch (cause) {
      blocked = String(cause).includes("topic_snapshot_immutable");
    }
    assert(blocked, "Topic Snapshot UPDATE was not blocked");
  } finally {
    db.close();
  }
}

async function withDb<T>(root: string, action: (db: ReturnType<typeof openSqlite>) => T) {
  const db = openSqlite(resolve(root, "data/self.sqlite3"), await locateWorkspaceAssets(root), {
    readonly: true,
  });
  try {
    return action(db);
  } finally {
    db.close();
  }
}

async function schemaVersion(root: string) {
  return withDb(
    root,
    (db) => db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0,
  );
}

function ok<T = Record<string, unknown>>(record: RunRecord): T {
  const value = JSON.parse(record.stdout);
  assert(value.ok === true, record.stdout);
  return value.data as T;
}

function str(value: unknown): string {
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
