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
const runRoot = resolve("data/test-runs/phase-6-real-cli");
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
const model = ok(
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
    "fixture-answer-v1",
    "--revision",
    "fixed-v1",
    "--json",
  ]),
);
const modelId = str(model.model_id);
ok(await run([binary, "--root", instance, "graph", "build", "--model", modelId, "--json"]));

const answer = ok(
  await run([
    binary,
    "--root",
    instance,
    "ask",
    "Self uses",
    "--mode",
    "text",
    "--model",
    modelId,
    "--json",
  ]),
);
const answerId = str(answer.answer_id);
assert(answer.result_kind === "conflicted", "conflicting Claims were hidden");
const statements = answer.statements as Array<Record<string, unknown>>;
assert(statements.length === 2, "conflict positions were not preserved");
assert(
  statements.every(
    (statement) =>
      statement.conclusion_type === "conflict" &&
      statement.confidence_level === "disputed" &&
      (statement.citations as unknown[]).length > 0,
  ),
  "factual statements are not cited and typed",
);
const traceA = ok(await run([binary, "--root", instance, "trace", answerId, "--json"]));
const contextA = traceA.context as Record<string, unknown>;
assert(
  (contextA.items as Array<Record<string, unknown>>).every(
    (item) => item.excerpt_hash_matches === true,
  ),
  "EvidenceContext cannot be replayed from immutable Chunks",
);
assert(
  (traceA.evidence_chains as Array<Record<string, unknown>>).every(
    (chain) =>
      typeof chain.chunk_id === "string" &&
      typeof chain.revision_id === "string" &&
      typeof chain.snapshot_id === "string" &&
      typeof chain.source_id === "string",
  ),
  "Answer trace does not reach Source Snapshot",
);
const traceB = ok(await run([binary, "--root", instance, "trace", answerId, "--json"]));
assert(
  (traceB.context as Record<string, unknown>).context_hash === contextA.context_hash,
  "same knowledge snapshot did not reproduce Context hash",
);

const ids = await withDb(instance, (db) => ({
  entity: db
    .query<{ entity_id: string }, []>(
      "SELECT entity_id FROM graph_entities WHERE identity_key = 'project:self'",
    )
    .get()?.entity_id,
  claim: db.query<{ claim_id: string }, []>("SELECT claim_id FROM graph_claims LIMIT 1").get()
    ?.claim_id,
}));
ok(await run([binary, "--root", instance, "related", str(ids.entity), "--depth", "2", "--json"]));
ok(await run([binary, "--root", instance, "trace", str(ids.claim), "--json"]));

const countBeforeInvalid = await answerCount(instance);
error(
  await run(
    [
      binary,
      "--root",
      instance,
      "ask",
      "Self FORCE_UNSUPPORTED_CITATION",
      "--mode",
      "text",
      "--model",
      modelId,
      "--json",
    ],
    6,
  ),
  "answer_citation_unsupported",
);
assert((await answerCount(instance)) === countBeforeInvalid, "unsupported Answer was published");

const cannot = ok(
  await run([
    binary,
    "--root",
    instance,
    "ask",
    "Self FORCE_CANNOT_DETERMINE",
    "--mode",
    "text",
    "--model",
    modelId,
    "--json",
  ]),
);
assert(
  cannot.result_kind === "cannot_determine" &&
    (cannot.statements as Array<Record<string, unknown>>)[0]?.conclusion_type === "unknown",
  "cannot_determine was not preserved as an unknown",
);

const insufficient = ok(
  await run([binary, "--root", instance, "ask", "zzzxxyyqqlmnop", "--mode", "text", "--json"]),
);
assert(
  insufficient.result_kind === "insufficient_evidence" &&
    (insufficient.statements as unknown[]).length === 0,
  "missing evidence produced a fabricated answer",
);
const external = ok(
  await run([
    binary,
    "--root",
    instance,
    "ask",
    "zzzxxyyqqlmnop",
    "--mode",
    "text",
    "--model",
    modelId,
    "--allow-model-knowledge",
    "--json",
  ]),
);
const externalStatement = (external.statements as Array<Record<string, unknown>>)[0];
assert(
  externalStatement?.conclusion_type === "model_knowledge" &&
    (externalStatement.citations as unknown[]).length === 0,
  "explicit external model knowledge was not isolated",
);

await Bun.write(
  resolve(fixture, "a.md"),
  "# Self storage updated\n\nSelf now documents SQLite with a newer revision.\n",
);
ok(await run([binary, "--root", instance, "source", "sync", sourceId, "--json"]));
const stale = await withDb(instance, (db) =>
  db
    .query<{ cache_state: string; context_state: string }, [string]>(
      `SELECT a.cache_state, c.state context_state FROM answer_runs a
       JOIN evidence_contexts c ON c.context_id = a.context_id WHERE a.answer_id = ?`,
    )
    .get(answerId),
);
assert(
  stale?.cache_state === "stale" && stale.context_state === "stale",
  "changed evidence did not invalidate Answer and EvidenceContext",
);

const migrationRoot = resolve(runRoot, "migration-instance");
ok(await run([binary, "init", migrationRoot, "--offline", "--json"]));
await run(["bun", "run", "tests/helpers/downgrade-to-schema6-fixture.ts", migrationRoot]);
const migrationPlan = ok(
  await run([binary, "--root", migrationRoot, "migration", "plan", "--json"]),
);
ok(await run([binary, "--root", migrationRoot, "apply", str(migrationPlan.plan_id), "--json"]));
assert(
  (await schemaVersion(migrationRoot)) === VERSION.databaseSchema,
  "Schema 6 to current migration failed",
);
ok(await run([binary, "--root", migrationRoot, "ask", "nothing", "--mode", "text", "--json"]));

await Bun.write(
  resolve(runRoot, "commands.jsonl"),
  `${records
    .map((record) =>
      JSON.stringify({
        argv: redact(record.argv),
        exit_code: record.exit_code,
        duration_ms: record.duration_ms,
      }),
    )
    .join("\n")}\n`,
);
process.stdout.write(
  `${JSON.stringify({ ok: true, phase: 6, schema: VERSION.databaseSchema, commands: records.length, answer_id: answerId })}\n`,
);

async function prepare() {
  await mkdir(fixture, { recursive: true });
  await Bun.write(
    resolve(fixture, "a.md"),
    "# Self storage\n\nSelf uses SQLite as its single structured database.\n\n@entity self|project|Self||project:self\n@entity sqlite|technology|SQLite||technology:sqlite\n@claim self|depends_on|sqlite|Self uses SQLite.|fact|direct|primary-store\n",
  );
  await Bun.write(
    resolve(fixture, "b.md"),
    "# Alternative\n\nA draft says Self uses PostgreSQL.\n\n@entity self|project|Self||project:self\n@entity pg|technology|PostgreSQL||technology:postgresql\n@claim self|depends_on|pg|Self uses PostgreSQL.|fact|direct|primary-store\n",
  );
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

async function answerCount(root: string) {
  return withDb(
    root,
    (db) =>
      db.query<{ count: number }, []>("SELECT COUNT(*) count FROM answer_runs").get()?.count ?? 0,
  );
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

function error(record: RunRecord, code: string) {
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
): Promise<RunRecord> {
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
