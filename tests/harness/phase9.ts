import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { openSqlite } from "../../src/infrastructure/db/connection.ts";
import { locateWorkspaceAssets } from "../../src/infrastructure/runtime/assets.ts";
import { VERSION } from "../../src/shared/version.ts";

type RecordRow = {
  argv: string[];
  exit_code: number;
  duration_ms: number;
  stdout: string;
  stderr: string;
};

const repository = resolve(".");
const runRoot = resolve("data/test-runs/phase-9-real-cli");
const instance = resolve("data/test-runs/phase-8-real-cli/moved-instance");
const records: RecordRow[] = [];
await rm(runRoot, { recursive: true, force: true });
await mkdir(runRoot, { recursive: true });
await Promise.all(
  ["home", "tmp", "cache"].map((directory) =>
    mkdir(resolve(runRoot, directory), { recursive: true }),
  ),
);
await run(["bun", "run", "tests/harness/phase8.ts"]);
const binary = resolve(
  "dist/local",
  `self-${process.platform}-${process.arch}`,
  process.platform === "win32" ? "self.exe" : "self",
);

const schema = await read(instance, (db) =>
  db.query<{ user_version: number }, []>("PRAGMA user_version").get(),
);
assert(
  schema?.user_version === VERSION.databaseSchema,
  "Phase 9 prerequisite schema is not current",
);

const migrationRoot = resolve(runRoot, "schema-9-instance");
await cp(instance, migrationRoot, { recursive: true });
await run(["bun", "run", "tests/helpers/downgrade-to-schema9-fixture.ts", migrationRoot]);
const migrationPlan = ok(await cli(binary, migrationRoot, ["migration", "plan", "--json"]));
ok(await apply(binary, migrationRoot, id(migrationPlan, "plan_id")));
const migrated = await read(migrationRoot, (db) => ({
  version: db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
  plans: db
    .query<{ count: number }, []>(
      "SELECT COUNT(*) count FROM sqlite_master WHERE type = 'table' AND name = 'automation_plans'",
    )
    .get()?.count,
}));
assert(
  migrated.version === VERSION.databaseSchema && migrated.plans === 1,
  "Schema 9 migration failed",
);

await stalePlanScenario(binary, instance);
await sourceLifecycleScenario(binary, instance);
await connectionScenario(binary, instance);
await noteScenario(binary, instance);
await graphScenario(binary, instance);
await topicArtifactScenario(binary, instance);
await purgeScenario(binary, instance);

const planList = ok<unknown[]>(await cli(binary, instance, ["plan", "list", "--json"]));
const operationList = ok<unknown[]>(await cli(binary, instance, ["operation", "list", "--json"]));
const history = ok<unknown[]>(await cli(binary, instance, ["history", "list", "--json"]));
assert(planList.length >= 10, "Plan registry did not retain Phase 9 Plans");
assert(operationList.length >= 10, "Operation registry is incomplete");
assert(history.length >= 10, "AuditEvent history is incomplete");
await assertAuditImmutable(instance);

await Bun.write(
  resolve(runRoot, "commands.jsonl"),
  `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
);
await Bun.write(
  resolve(runRoot, "result.json"),
  `${JSON.stringify(
    {
      phase: 9,
      status: "passed",
      schema_version: VERSION.databaseSchema,
      plans: planList.length,
      operations: operationList.length,
      audit_events: history.length,
      assertions: {
        migration_9_to_10: true,
        stale_plan_rejected: true,
        exact_source_restore: true,
        note_file_undo: true,
        dependency_propagation: true,
        idempotency: true,
        irreversible_purge: true,
        audit_immutable: true,
      },
    },
    null,
    2,
  )}\n`,
);
console.log(`Phase 9 real CLI E2E passed: ${runRoot}`);

async function stalePlanScenario(binary: string, root: string) {
  const input = resolve(runRoot, "stale.md");
  await Bun.write(input, "# stale plan\nfirst\n");
  const source = ok(
    await cli(binary, root, ["source", "add", input, "--kind", "markdown", "--json"]),
  );
  const sourceId = id(source, "source_id");
  const first = ok(
    await cli(binary, root, [
      "source",
      "delete",
      sourceId,
      "--plan",
      "--idempotency-key",
      "phase9-stale-plan",
      "--json",
    ]),
  );
  const repeated = ok(
    await cli(binary, root, [
      "source",
      "delete",
      sourceId,
      "--plan",
      "--idempotency-key",
      "phase9-stale-plan",
      "--json",
    ]),
  );
  assert(id(first, "plan_id") === id(repeated, "plan_id"), "Plan idempotency created a duplicate");
  await Bun.write(input, "# stale plan\nsecond\n");
  ok(await cli(binary, root, ["source", "sync", sourceId, "--json"]));
  failed(await apply(binary, root, id(first, "plan_id"), 4), "plan_conflict");
  ok(await cli(binary, root, ["plan", "cancel", id(first, "plan_id"), "--json"]));
  failed(
    await cli(
      binary,
      root,
      ["source", "delete", sourceId, "--plan", "--idempotency-key", "phase9-stale-plan", "--json"],
      0,
    ),
    "plan_state_invalid",
    false,
  );
}

async function sourceLifecycleScenario(binary: string, root: string) {
  const before = await read(root, (db) => {
    const source = db
      .query<{ source_id: string }, []>("SELECT source_id FROM topic_report_citations LIMIT 1")
      .get();
    if (!source) throw new Error("Topic citation Source is missing");
    return sourceState(db, source.source_id);
  });
  const plan = ok(
    await cli(binary, root, [
      "source",
      "delete",
      before.sourceId,
      "--plan",
      "--idempotency-key",
      "phase9-source-delete",
      "--json",
    ]),
  );
  assert((plan.impact as { change_count: number }).change_count > 3, "Source impact is incomplete");
  assert(
    (await read(root, (db) => sourceState(db, before.sourceId))).sourceState === before.sourceState,
    "Plan mutated Source",
  );
  ok(await cli(binary, root, ["plan", "show", id(plan, "plan_id"), "--json"]));
  ok(await cli(binary, root, ["plan", "diff", id(plan, "plan_id"), "--json"]));
  const applied = ok(await apply(binary, root, id(plan, "plan_id")));
  assert(
    applied.atomicity === "atomic" &&
      Array.isArray(applied.items) &&
      applied.items.every(
        (item) =>
          item && typeof item === "object" && (item as { status?: string }).status === "succeeded",
      ),
    "Atomic per-item result is incomplete",
  );
  const repeated = ok(await apply(binary, root, id(plan, "plan_id")));
  assert(repeated.reused === true, "Repeated Apply was not idempotent");
  ok(await cli(binary, root, ["operation", "show", id(applied, "operation_id"), "--json"]));
  ok(await cli(binary, root, ["history", "show", id(applied, "operation_id"), "--json"]));
  ok(await cli(binary, root, ["history", "diff", id(applied, "operation_id"), "--json"]));
  const deleted = await read(root, (db) => sourceState(db, before.sourceId));
  assert(deleted.sourceState === "deleted", "Source was not soft-deleted");
  assert(
    deleted.documents.every((state) => state === "deleted"),
    "Documents were not tombstoned",
  );
  assert(
    deleted.chunks.every((state) => state === "tombstoned"),
    "Chunks were not tombstoned",
  );
  assert(
    deleted.topicStates.every((state) => state === "needs_review"),
    "Topics were not invalidated",
  );
  assert(
    deleted.artifactStates.every((state) => state === "stale"),
    "Artifacts were not invalidated",
  );
  assert(
    deleted.snapshots === before.snapshots && deleted.revisions === before.revisions,
    "Evidence history changed",
  );
  const blockedPurge = ok(
    await cli(binary, root, ["source", "purge", before.sourceId, "--plan", "--json"]),
  );
  assert(
    (blockedPurge.impact as { can_apply: boolean }).can_apply === false,
    "Purge blockers are missing",
  );
  failed(await apply(binary, root, id(blockedPurge, "plan_id"), 4), "source_purge_blocked");
  ok(await cli(binary, root, ["plan", "cancel", id(blockedPurge, "plan_id"), "--json"]));
  const restore = ok(
    await cli(binary, root, [
      "source",
      "restore",
      before.sourceId,
      "--idempotency-key",
      "phase9-source-restore",
      "--json",
    ]),
  );
  const restoreAgain = ok(
    await cli(binary, root, [
      "source",
      "restore",
      before.sourceId,
      "--idempotency-key",
      "phase9-source-restore",
      "--json",
    ]),
  );
  assert(restoreAgain.reused === true, "Restore idempotency failed");
  assert(
    id(restore, "undo_of_operation_id") === id(applied, "operation_id"),
    "Restore audit link is missing",
  );
  const restored = await read(root, (db) => sourceState(db, before.sourceId));
  assert(
    JSON.stringify(restored) ===
      JSON.stringify({ ...before, sourceVersion: before.sourceVersion + 2 }),
    "Source restore was not exact",
  );
}

async function connectionScenario(binary: string, root: string) {
  let selected = await read(root, (db) =>
    db
      .query<{ connection_id: string; source_id: string }, []>(
        "SELECT connection_id, source_id FROM data_connections WHERE state NOT IN ('detached','deleted') LIMIT 1",
      )
      .get(),
  );
  if (!selected) {
    const target = resolve(runRoot, "connection-target");
    await mkdir(target, { recursive: true });
    await Bun.write(resolve(target, "readme.md"), "# monitored\n");
    const created = ok(
      await cli(binary, root, [
        "connection",
        "add",
        target,
        "--kind",
        "directory",
        "--paused",
        "--no-initial-scan",
        "--no-daemon",
        "--json",
      ]),
    );
    selected = {
      connection_id: id(created, "connection_id"),
      source_id: id(created, "source_id"),
    };
  }
  const plan = ok(
    await cli(binary, root, ["connection", "detach", selected.connection_id, "--plan", "--json"]),
  );
  ok(await apply(binary, root, id(plan, "plan_id")));
  const state = await read(root, (db) => ({
    connection: db
      .query<{ state: string }, [string]>(
        "SELECT state FROM data_connections WHERE connection_id = ?",
      )
      .get(selected.connection_id)?.state,
    source: db
      .query<{ state: string }, [string]>("SELECT state FROM sources WHERE source_id = ?")
      .get(selected.source_id)?.state,
  }));
  assert(state.connection === "detached" && state.source === "active", "Detach removed its Source");
  ok(await cli(binary, root, ["connection", "restore", selected.connection_id, "--json"]));
}

async function noteScenario(binary: string, root: string) {
  const note = ok(
    await cli(binary, root, ["note", "create", "Phase 9 Note", "--content", "first", "--json"]),
  );
  const noteId = id(note, "note_id");
  const updated = ok(
    await cli(binary, root, [
      "note",
      "update",
      noteId,
      "--content",
      "second",
      "--if-version",
      String(note.version),
      "--idempotency-key",
      "phase9-note-update",
      "--json",
    ]),
  );
  const repeated = ok(
    await cli(binary, root, [
      "note",
      "update",
      noteId,
      "--content",
      "second",
      "--if-version",
      String(note.version),
      "--idempotency-key",
      "phase9-note-update",
      "--json",
    ]),
  );
  assert(repeated.reused === true, "Note update idempotency failed");
  failed(
    await cli(
      binary,
      root,
      [
        "note",
        "update",
        noteId,
        "--content",
        "stale",
        "--if-version",
        String(note.version),
        "--json",
      ],
      4,
    ),
    "note_version_conflict",
  );
  const originalPath = id(updated, "relative_path");
  const movePlan = ok(
    await cli(binary, root, ["note", "move", noteId, "--to", "phase9", "--plan", "--json"]),
  );
  const moved = ok(await apply(binary, root, id(movePlan, "plan_id")));
  const movedPath = id(
    ok(await cli(binary, root, ["note", "show", noteId, "--json"])),
    "relative_path",
  );
  assert(await Bun.file(resolve(root, movedPath)).exists(), "Note file did not move");
  const undoPlan = ok(
    await cli(binary, root, ["operation", "undo", id(moved, "operation_id"), "--plan", "--json"]),
  );
  ok(await apply(binary, root, id(undoPlan, "plan_id")));
  assert(
    await Bun.file(resolve(root, originalPath)).exists(),
    "Note Undo did not restore the file",
  );
  const deletePlan = ok(await cli(binary, root, ["note", "delete", noteId, "--plan", "--json"]));
  ok(await apply(binary, root, id(deletePlan, "plan_id")));
  ok(await cli(binary, root, ["note", "restore", noteId, "--json"]));
  const restored = ok(await cli(binary, root, ["note", "show", noteId, "--json"]));
  assert(
    restored.state === "active" && restored.note_id === noteId,
    "Note restore changed identity",
  );
}

async function graphScenario(binary: string, root: string) {
  const selected = await read(root, (db) => ({
    entity: db
      .query<{ id: string }, []>(
        "SELECT entity_id id FROM graph_entities WHERE status NOT IN ('deleted','redirected') LIMIT 1",
      )
      .get()?.id,
    relation: db
      .query<{ id: string }, []>(
        "SELECT relation_id id FROM graph_relations WHERE status NOT IN ('deleted','rejected','deprecated') LIMIT 1",
      )
      .get()?.id,
    claim: db
      .query<{ id: string; version: number }, []>(
        "SELECT claim_id id, version FROM graph_claims WHERE status NOT IN ('deleted','rejected','superseded') LIMIT 1",
      )
      .get(),
  }));
  if (!selected.entity || !selected.relation || !selected.claim)
    throw new Error("Graph lifecycle fixtures are missing");
  const moderated = ok(
    await cli(binary, root, [
      "claim",
      "confirm",
      selected.claim.id,
      "--if-version",
      String(selected.claim.version),
      "--idempotency-key",
      "phase9-claim-confirm",
      "--json",
    ]),
  );
  const moderationAgain = ok(
    await cli(binary, root, [
      "claim",
      "confirm",
      selected.claim.id,
      "--if-version",
      String(selected.claim.version),
      "--idempotency-key",
      "phase9-claim-confirm",
      "--json",
    ]),
  );
  assert(
    moderationAgain.reused === true && moderated.status === "user_confirmed",
    "Claim moderation failed",
  );
  await deleteAndRestore(binary, root, "entity", selected.entity);
  await deleteAndRestore(binary, root, "relation", selected.relation);
  await deleteAndRestore(binary, root, "claim", selected.claim.id);
}

async function topicArtifactScenario(binary: string, root: string) {
  const selected = await read(root, (db) =>
    db
      .query<{ topic_id: string; artifact_id: string }, []>(
        "SELECT t.topic_id, a.artifact_id FROM topics t JOIN artifacts a ON a.topic_id = t.topic_id WHERE t.status <> 'deleted' LIMIT 1",
      )
      .get(),
  );
  if (!selected) throw new Error("Topic Artifact fixture is missing");
  await deleteAndRestore(binary, root, "topic", selected.topic_id);
  const plan = ok(
    await cli(binary, root, ["artifact", "delete", selected.artifact_id, "--plan", "--json"]),
  );
  const applied = ok(await apply(binary, root, id(plan, "plan_id")));
  const undo = ok(
    await cli(binary, root, ["operation", "undo", id(applied, "operation_id"), "--plan", "--json"]),
  );
  ok(await apply(binary, root, id(undo, "plan_id")));
  const directRestorePlan = ok(
    await cli(binary, root, ["artifact", "delete", selected.artifact_id, "--plan", "--json"]),
  );
  ok(await apply(binary, root, id(directRestorePlan, "plan_id")));
  ok(await cli(binary, root, ["artifact", "restore", selected.artifact_id, "--json"]));
  const cancelled = ok(
    await cli(binary, root, ["artifact", "delete", selected.artifact_id, "--plan", "--json"]),
  );
  ok(await cli(binary, root, ["plan", "cancel", id(cancelled, "plan_id"), "--json"]));
  failed(await apply(binary, root, id(cancelled, "plan_id"), 5), "plan_state_invalid");
}

async function purgeScenario(binary: string, root: string) {
  const input = resolve(runRoot, "purge.md");
  await Bun.write(input, "# purge-only\nno derived knowledge\n");
  const source = ok(
    await cli(binary, root, ["source", "add", input, "--kind", "markdown", "--no-build", "--json"]),
  );
  const sourceId = id(source, "source_id");
  const remove = ok(await cli(binary, root, ["source", "delete", sourceId, "--plan", "--json"]));
  ok(await apply(binary, root, id(remove, "plan_id")));
  const purge = ok(await cli(binary, root, ["source", "purge", sourceId, "--plan", "--json"]));
  const files = (purge.impact as { files: string[] }).files;
  const applied = ok(await apply(binary, root, id(purge, "plan_id")));
  assert(
    !(await read(root, (db) =>
      db.query("SELECT 1 FROM sources WHERE source_id = ?").get(sourceId),
    )),
    "Purged Source row remains",
  );
  const removed = await Promise.all(
    files.map(async (file) => !(await Bun.file(resolve(root, file)).exists())),
  );
  assert(removed.every(Boolean), "Purged files remain");
  failed(
    await cli(
      binary,
      root,
      ["operation", "undo", id(applied, "operation_id"), "--plan", "--json"],
      5,
    ),
    "operation_not_undoable",
  );
}

async function deleteAndRestore(
  binary: string,
  root: string,
  kind: "entity" | "relation" | "claim" | "topic",
  resourceId: string,
) {
  const plan = ok(await cli(binary, root, [kind, "delete", resourceId, "--plan", "--json"]));
  ok(await apply(binary, root, id(plan, "plan_id")));
  ok(await cli(binary, root, [kind, "restore", resourceId, "--json"]));
}

function sourceState(db: ReturnType<typeof openSqlite>, sourceId: string) {
  const source = db
    .query<{ state: string; version: number }, [string]>(
      "SELECT state, version FROM sources WHERE source_id = ?",
    )
    .get(sourceId);
  if (!source) throw new Error("Source is missing");
  const topics = db
    .query<{ status: string }, [string]>(
      `SELECT DISTINCT t.status FROM topics t JOIN topic_snapshots s ON s.topic_snapshot_id = t.latest_snapshot_id
     JOIN topic_report_sections rs ON rs.topic_snapshot_id = s.topic_snapshot_id
     JOIN topic_report_conclusions rc ON rc.section_id = rs.section_id
     JOIN topic_report_citations c ON c.conclusion_id = rc.conclusion_id WHERE c.source_id = ? ORDER BY t.status`,
    )
    .all(sourceId);
  return {
    sourceId,
    sourceState: source.state,
    sourceVersion: source.version,
    documents: db
      .query<{ state: string }, [string]>(
        "SELECT state FROM knowledge_documents WHERE source_id = ? ORDER BY document_id",
      )
      .all(sourceId)
      .map((row) => row.state),
    chunks: db
      .query<{ state: string }, [string]>(
        "SELECT c.state FROM knowledge_chunks c JOIN knowledge_documents d ON d.document_id = c.document_id WHERE d.source_id = ? ORDER BY c.chunk_id",
      )
      .all(sourceId)
      .map((row) => row.state),
    topicStates: topics.map((row) => row.status),
    artifactStates: db
      .query<{ status: string }, [string]>(
        `SELECT a.status FROM artifacts a JOIN topics t ON t.topic_id = a.topic_id JOIN topic_snapshots s
       ON s.topic_snapshot_id = t.latest_snapshot_id JOIN topic_report_sections rs ON rs.topic_snapshot_id = s.topic_snapshot_id
       JOIN topic_report_conclusions rc ON rc.section_id = rs.section_id JOIN topic_report_citations c
       ON c.conclusion_id = rc.conclusion_id WHERE c.source_id = ? ORDER BY a.artifact_id`,
      )
      .all(sourceId)
      .map((row) => row.status),
    snapshots:
      db
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) count FROM source_snapshots WHERE source_id = ?",
        )
        .get(sourceId)?.count ?? 0,
    revisions:
      db
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) count FROM knowledge_revisions r JOIN knowledge_documents d ON d.document_id = r.document_id WHERE d.source_id = ?",
        )
        .get(sourceId)?.count ?? 0,
  };
}

async function assertAuditImmutable(root: string) {
  const assets = await locateWorkspaceAssets(root);
  const db = openSqlite(resolve(root, "data/self.sqlite3"), assets);
  try {
    const event = db
      .query<{ event_id: string }, []>("SELECT event_id FROM audit_events LIMIT 1")
      .get();
    if (!event) throw new Error("AuditEvent is missing");
    let rejected = false;
    try {
      db.prepare("UPDATE audit_events SET actor = 'tampered' WHERE event_id = ?").run(
        event.event_id,
      );
    } catch {
      rejected = true;
    }
    assert(rejected, "AuditEvent mutation was accepted");
  } finally {
    db.close();
  }
}

async function read<T>(root: string, action: (db: ReturnType<typeof openSqlite>) => T): Promise<T> {
  const db = openSqlite(resolve(root, "data/self.sqlite3"), await locateWorkspaceAssets(root), {
    readonly: true,
  });
  try {
    return action(db);
  } finally {
    db.close();
  }
}

function cli(binary: string, root: string, args: string[], expected = 0) {
  return run([binary, "--root", root, ...args], expected);
}

function apply(binary: string, root: string, planId: string, expected = 0) {
  return cli(binary, root, ["apply", planId, "--json"], expected);
}

function ok<T extends Record<string, unknown> | unknown[] = Record<string, unknown>>(
  record: RecordRow,
): T {
  const value = JSON.parse(record.stdout) as { ok: boolean; data: T };
  assert(value.ok === true, record.stdout);
  return value.data;
}

function failed(record: RecordRow, code: string, expectFailure = true) {
  const value = JSON.parse(record.stdout) as { ok: boolean; error?: { code?: string } };
  if (expectFailure) assert(value.ok === false && value.error?.code === code, record.stdout);
  else
    assert(
      value.ok === true && (value as { data?: { state?: string } }).data?.state === "cancelled",
      record.stdout,
    );
}

function id(value: Record<string, unknown>, key: string): string {
  const selected = value[key];
  if (typeof selected !== "string") throw new Error(`${key} is missing`);
  return selected;
}

async function run(argv: string[], expected = 0): Promise<RecordRow> {
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

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
