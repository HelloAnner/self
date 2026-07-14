import type { Database } from "bun:sqlite";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { openSqlite } from "../../src/infrastructure/db/connection.ts";
import { sha256File, sha256Text } from "../../src/infrastructure/filesystem/hash.ts";
import { ensureVectorTable } from "../../src/infrastructure/knowledge/vector-index.ts";
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
const runRoot = resolve("data/test-runs/phase-10-real-cli");
const prerequisite = resolve("data/test-runs/phase-8-real-cli/moved-instance");
const instance = resolve(runRoot, "instance");
const records: RecordRow[] = [];
await rm(runRoot, { recursive: true, force: true });
await mkdir(runRoot, { recursive: true });
await run(["bun", "run", "tests/harness/phase9.ts"]);
await cp(prerequisite, instance, { recursive: true });
const binary = resolve(
  "dist/local",
  `self-${process.platform}-${process.arch}`,
  process.platform === "win32" ? "self.exe" : "self",
);

await migrationRollbackScenario(binary);
await durableJobScenario(binary);
const backup = await backupRestoreScenario(binary);
await gcScenario(binary);
await deepVerificationFaultScenario(binary);
await maintenanceRecoveryScenario(binary);

const finalVerify = ok(await cli(binary, instance, ["verify", "--deep", "--wait", "--json"]));
assert(finalVerify.state === "succeeded", "Final deep verification did not pass");
const jobs = ok<unknown[]>(await cli(binary, instance, ["job", "list", "--json"]));
const backups = ok<unknown[]>(await cli(binary, instance, ["backup", "list", "--json"]));
const operations = ok<unknown[]>(await cli(binary, instance, ["operation", "list", "--json"]));
await Bun.write(
  resolve(runRoot, "commands.jsonl"),
  `${records
    .map(safeRecord)
    .map((record) => JSON.stringify(record))
    .join("\n")}\n`,
);
await Bun.write(
  resolve(runRoot, "result.json"),
  `${JSON.stringify(
    {
      phase: 10,
      status: "passed",
      schema_version: VERSION.databaseSchema,
      cli_version: VERSION.cli,
      jobs: jobs.length,
      backups: backups.length,
      operations: operations.length,
      restored_root: backup.restored,
      assertions: {
        schema_10_to_11_rollback_and_retry: true,
        detached_job_and_immutable_events: true,
        queued_cancellation_and_retry: true,
        crashed_worker_lease_recovery: true,
        model_timeout_retry: true,
        wal_consistent_backup: true,
        checksum_verified_restore_to_new_root: true,
        existing_target_never_overwritten: true,
        deep_verify_detects_blob_vector_evidence_artifact_faults: true,
        reference_proven_gc: true,
        stale_lock_and_wal_recovery: true,
      },
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(`Phase 10 real CLI E2E passed: ${runRoot}\n`);

async function migrationRollbackScenario(binary: string) {
  const root = resolve(runRoot, "schema-10-instance");
  await cp(instance, root, { recursive: true });
  await run(["bun", "run", "tests/helpers/downgrade-to-schema10-fixture.ts", root]);
  const before = await sha256File(resolve(root, "data/self.sqlite3"));
  const plan = ok(await cli(binary, root, ["migration", "plan", "--json"]));
  failed(
    await apply(binary, root, id(plan, "plan_id"), 20, {
      SELF_TEST_FAIL_MIGRATION_BEFORE_SWAP: "1",
    }),
    "migration_fault_injected",
  );
  const after = await sha256File(resolve(root, "data/self.sqlite3"));
  assert(before === after, "Failed migration changed the source database");
  ok(await apply(binary, root, id(plan, "plan_id")));
  const schema = await read(root, (database) =>
    database.query<{ user_version: number }, []>("PRAGMA user_version").get(),
  );
  assert(schema?.user_version === VERSION.databaseSchema, "Schema 10 migration did not reach 11");
}

async function durableJobScenario(binary: string) {
  const queued = ok(
    await cli(
      binary,
      instance,
      ["backup", "create", "--idempotency-key", "phase10-cancel", "--json"],
      0,
      { SELF_TEST_DISABLE_JOB_SPAWN: "1" },
    ),
  );
  const queuedId = id(queued, "job_id");
  const cancelled = ok(await cli(binary, instance, ["job", "cancel", queuedId, "--json"]));
  assert(cancelled.state === "cancelled", "Queued Job cancellation failed");
  const retried = ok(await cli(binary, instance, ["job", "retry", queuedId, "--wait", "--json"]));
  assert(retried.state === "succeeded", "Cancelled Job retry failed");

  const crashed = ok(
    await cli(
      binary,
      instance,
      ["backup", "create", "--idempotency-key", "phase10-crash", "--json"],
      0,
      { SELF_TEST_CRASH_JOB_AFTER_CLAIM: "1" },
    ),
  );
  const crashedId = id(crashed, "job_id");
  const interrupted = await waitForJob(binary, instance, crashedId, ["waiting"]);
  assert(interrupted.state === "waiting", "Crashed Job was not recovered from its dead worker");
  const resumed = ok(await cli(binary, instance, ["job", "retry", crashedId, "--wait", "--json"]));
  assert(resumed.state === "succeeded" && resumed.attempt === 2, "Crashed Job did not resume");

  const timedOut = ok(
    await cli(binary, instance, ["verify", "--deep", "--detach", "--json"], 0, {
      SELF_TEST_JOB_MODEL_TIMEOUT: "1",
    }),
  );
  const timeoutId = id(timedOut, "job_id");
  const failedJob = await waitForJob(binary, instance, timeoutId, ["failed"]);
  assert(
    (failedJob.error as Record<string, unknown>).code === "model_timeout",
    "Retryable model timeout was not retained",
  );
  const recovered = ok(
    await cli(binary, instance, ["job", "retry", timeoutId, "--wait", "--json"]),
  );
  assert(recovered.state === "succeeded", "Model timeout Job did not recover on retry");
  const logs = ok<unknown[]>(await cli(binary, instance, ["job", "logs", crashedId, "--json"]));
  assert(logs.length >= 6, "Durable Job event log is incomplete");
  ok(await cli(binary, instance, ["job", "show", crashedId, "--json"]));
  ok(await cli(binary, instance, ["job", "watch", crashedId, "--timeout", "5", "--json"]));
}

async function backupRestoreScenario(binary: string) {
  const input = resolve(runRoot, "backup-sentinel.md");
  await Bun.write(input, "# Phase Ten Sentinel\n\nphase ten recovery sentinel 714\n");
  ok(await cli(binary, instance, ["source", "add", input, "--kind", "markdown", "--json"]));

  const assets = await locateWorkspaceAssets(instance);
  const writer = openSqlite(resolve(instance, "data/self.sqlite3"), assets);
  writer.exec("BEGIN IMMEDIATE");
  writer.prepare("UPDATE workspace SET updated_at = updated_at").run();
  const pending = cli(binary, instance, ["backup", "create", "--wait", "--json"]);
  await Bun.sleep(250);
  writer.exec("COMMIT");
  writer.close();
  const backupJob = ok(await pending);
  assert(backupJob.state === "succeeded", "WAL-active Backup failed");
  const backupResult = backupJob.result as Record<string, unknown>;
  const backupId = id(backupResult, "backup_id");
  const verified = ok(await cli(binary, instance, ["backup", "verify", backupId, "--json"]));
  assert(verified.status === "pass", "Backup checksums failed");
  ok(await cli(binary, instance, ["backup", "show", backupId, "--json"]));
  ok(await cli(binary, instance, ["backup", "list", "--json"]));

  const restored = resolve(runRoot, "restored-instance");
  const plan = ok(
    await cli(binary, instance, [
      "backup",
      "restore",
      backupId,
      "--to",
      restored,
      "--plan",
      "--json",
    ]),
  );
  ok(await apply(binary, instance, id(plan, "plan_id")));
  const search = ok(
    await cli(binary, restored, [
      "search",
      "phase ten recovery sentinel 714",
      "--mode",
      "text",
      "--json",
    ]),
  );
  assert(
    Array.isArray(search.results) && search.results.length > 0,
    "Restored search evidence is missing",
  );
  const deep = ok(await cli(binary, restored, ["verify", "--deep", "--wait", "--json"]));
  assert(deep.state === "succeeded", "Restored Root failed deep verification");
  failed(
    await cli(
      binary,
      instance,
      ["backup", "restore", backupId, "--to", restored, "--plan", "--json"],
      4,
    ),
    "restore_target_exists",
  );
  return { backupId, restored };
}

async function gcScenario(binary: string) {
  const before = await read(instance, (database) => count(database, "source_blobs"));
  const content = "unreferenced phase ten garbage\n";
  const hash = sha256Text(content);
  const relativePath = `content/blobs/${hash.slice(0, 2)}/${hash}`;
  await mkdir(dirname(resolve(instance, relativePath)), { recursive: true });
  await Bun.write(resolve(instance, relativePath), content);
  await write(instance, (database) =>
    database
      .prepare(
        "INSERT INTO source_blobs(sha256, size_bytes, mime_type, relative_path, created_at) VALUES (?, ?, 'text/plain', ?, ?)",
      )
      .run(hash, Buffer.byteLength(content), relativePath, new Date().toISOString()),
  );
  const plan = ok(await cli(binary, instance, ["gc", "--plan", "--older-than", "24h", "--json"]));
  assert(
    (plan.changes as Array<Record<string, unknown>>).some(
      (candidate) => candidate.kind === "unreferenced_blob" && candidate.resource_id === hash,
    ),
    "GC Plan omitted the reference-free Blob proof",
  );
  ok(await apply(binary, instance, id(plan, "plan_id")));
  assert(
    !(await Bun.file(resolve(instance, relativePath)).exists()),
    "GC left the collected Blob file",
  );
  const after = await read(instance, (database) => count(database, "source_blobs"));
  assert(before === after, "GC removed referenced Blobs or retained the injected Blob");
}

async function deepVerificationFaultScenario(binary: string) {
  const root = resolve(runRoot, "fault-injected-instance");
  await cp(instance, root, { recursive: true });
  const fault = await write(root, (database) => {
    const blob = database
      .query<{ relative_path: string }, []>("SELECT relative_path FROM source_blobs LIMIT 1")
      .get();
    const claim = database
      .query<{ claim_id: string }, []>(
        `SELECT c.claim_id FROM graph_claims c JOIN graph_claim_evidence e
         ON e.claim_id = c.claim_id WHERE c.status IN ('accepted','user_confirmed','disputed')
         AND e.state = 'active' LIMIT 1`,
      )
      .get();
    const artifact = database
      .query<{ relative_directory: string; relative_path: string }, []>(
        `SELECT b.relative_directory, f.relative_path FROM artifact_builds b
         JOIN artifact_build_files f ON f.build_id = b.build_id WHERE b.state = 'ready' LIMIT 1`,
      )
      .get();
    const chunk = database
      .query<{ chunk_id: string; content_hash: string }, []>(
        "SELECT chunk_id, content_hash FROM knowledge_chunks WHERE state = 'active' LIMIT 1",
      )
      .get();
    if (!blob || !claim || !artifact || !chunk)
      throw new Error("Phase 10 fault fixture lacks Blob, Chunk, Claim, or Artifact evidence");
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO model_providers(provider_id, name, provider_type, protocol,
         endpoint_identity, state, created_at, updated_at)
         VALUES ('provider:phase10-fault', 'phase10-fault', 'test_deterministic',
         'fixture', 'fixture://phase10', 'active', ?, ?)`,
      )
      .run(now, now);
    database
      .prepare(
        `INSERT INTO models(model_id, provider_id, capability, provider_model_id,
         model_revision, revision_stability, dimensions_json, state, created_at, updated_at)
         VALUES ('model:phase10-fault', 'provider:phase10-fault', 'embedding',
         'phase10-fault', 'fixed-v1', 'fixed', '[4]', 'active', ?, ?)`,
      )
      .run(now, now);
    database
      .prepare(
        `INSERT INTO vector_spaces(vector_space_id, model_id, state, space_fingerprint,
         provider_type, provider_endpoint_identity, provider_model_id, model_revision,
         revision_stability, tokenizer_revision, dimensions, scalar_type, pooling,
         normalization, distance_metric, query_instruction_id, query_instruction_text,
         document_instruction_id, document_instruction_text, embedding_input_version,
         coverage_count, expected_chunk_count, created_at, updated_at, verified_at)
         VALUES ('vector-space:phase10-fault', 'model:phase10-fault', 'ready', ?,
         'test_deterministic', 'fixture://phase10', 'phase10-fault', 'fixed-v1', 'fixed',
         'chars-v1', 4, 'float32', 'mean', 'l2', 'cosine', 'query-v1', 'query: ',
         'document-v1', 'document: ', 'v1', 1, 1, ?, ?, ?)`,
      )
      .run("f".repeat(64), now, now, now);
    database
      .prepare(
        `INSERT INTO knowledge_embeddings(embedding_id, vector_space_id, chunk_id,
         chunk_content_hash, input_hash, vector_hash, state, created_at, updated_at)
         VALUES ('phase10-orphan-vector', 'vector-space:phase10-fault', ?, ?, ?, ?,
         'active', ?, ?)`,
      )
      .run(chunk.chunk_id, chunk.content_hash, "a".repeat(64), "b".repeat(64), now, now);
    const table = ensureVectorTable(database, 4);
    database
      .prepare(`INSERT INTO ${table}(embedding_id, vector_space_id, embedding) VALUES (?, ?, ?)`)
      .run("phase10-orphan-vector", "vector-space:phase10-fault", new Float32Array([1, 0, 0, 0]));
    database
      .prepare("DELETE FROM knowledge_embeddings WHERE embedding_id = 'phase10-orphan-vector'")
      .run();
    database.prepare("DELETE FROM graph_claim_evidence WHERE claim_id = ?").run(claim.claim_id);
    return { blob, artifact };
  });
  await rm(resolve(root, fault.blob.relative_path), { force: true });
  await rm(resolve(root, fault.artifact.relative_directory, fault.artifact.relative_path), {
    force: true,
  });
  const verification = ok(await cli(binary, root, ["verify", "--deep", "--wait", "--json"]));
  assert(verification.state === "failed", "Deep Verify accepted injected corruption");
  const codes = await read(root, (database) =>
    database
      .query<{ code: string }, []>(
        "SELECT DISTINCT code FROM operation_verification_issues ORDER BY code",
      )
      .all()
      .map((row) => row.code),
  );
  for (const expected of [
    "artifact_file_missing",
    "blob_missing",
    "claim_evidence_missing",
    "vector_row_orphaned",
  ]) {
    assert(codes.includes(expected), `Deep Verify did not report ${expected}`);
  }
}

async function maintenanceRecoveryScenario(binary: string) {
  await Bun.write(
    resolve(instance, "runtime/locks/maintenance.lock"),
    `${JSON.stringify({ owner: "dead-worker", purpose: "fault", pid: 999999, token: "stale", acquired_at: "2000-01-01T00:00:00.000Z", expires_at: "2000-01-01T00:00:01.000Z" })}\n`,
  );
  const checkpoint = ok(await cli(binary, instance, ["maintenance", "checkpoint", "--json"]));
  assert(checkpoint.status === "succeeded", "Stale maintenance lock was not recovered");
  const status = ok(await cli(binary, instance, ["maintenance", "status", "--json"]));
  assert(
    (status.lock as Record<string, unknown>).exists === false,
    "Maintenance lock remained after checkpoint",
  );
}

async function waitForJob(binary: string, root: string, jobId: string, states: string[]) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = ok(await cli(binary, root, ["job", "show", jobId, "--json"]));
    if (states.includes(String(job.state))) return job;
    if (String(job.state) === "running") await cli(binary, root, ["job", "list", "--json"]);
    await Bun.sleep(50);
  }
  throw new Error(`Job ${jobId} did not reach ${states.join("/")}`);
}

async function read<T>(root: string, action: (database: Database) => T): Promise<T> {
  const assets = await locateWorkspaceAssets(root);
  const database = openSqlite(resolve(root, "data/self.sqlite3"), assets, { readonly: true });
  try {
    return action(database);
  } finally {
    database.close();
  }
}

async function write<T>(root: string, action: (database: Database) => T): Promise<T> {
  const assets = await locateWorkspaceAssets(root);
  const database = openSqlite(resolve(root, "data/self.sqlite3"), assets);
  try {
    return action(database);
  } finally {
    database.close();
  }
}

function count(database: Database, table: string): number {
  return (
    database.query<{ count: number }, []>(`SELECT COUNT(*) count FROM ${table}`).get()?.count ?? 0
  );
}

async function apply(
  binary: string,
  root: string,
  planId: string,
  expected = 0,
  env: Record<string, string> = {},
) {
  return cli(binary, root, ["apply", planId, "--json"], expected, env, true);
}

async function cli(
  binary: string,
  root: string,
  args: string[],
  expected = 0,
  env: Record<string, string> = {},
  rootAfterCommand = false,
) {
  const argv = rootAfterCommand
    ? [binary, ...args, "--root", root]
    : [binary, "--root", root, ...args];
  const record = await run(argv, env, expected);
  return record;
}

async function run(argv: string[], env: Record<string, string> = {}, expected = 0) {
  const started = performance.now();
  const child = Bun.spawn(argv, {
    cwd: repository,
    env: { ...process.env, SELF_NO_OPEN: "1", ...env },
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

function ok<T extends Record<string, unknown> | unknown[] = Record<string, unknown>>(
  record: RecordRow,
): T {
  const envelope = JSON.parse(record.stdout) as {
    ok: boolean;
    data: T;
    error: Record<string, unknown> | null;
  };
  if (!envelope.ok) throw new Error(record.stdout);
  return envelope.data;
}

function failed(record: RecordRow, code: string) {
  const envelope = JSON.parse(record.stdout) as {
    ok: boolean;
    error: { code: string } | null;
  };
  assert(!envelope.ok && envelope.error?.code === code, `Expected failure ${code}`);
}

function id(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== "string") throw new Error(`${key} is missing`);
  return result;
}

function safeRecord(record: RecordRow) {
  return {
    argv: record.argv.map((value) =>
      value.includes("phase ten recovery sentinel") ? "<redacted-query>" : value,
    ),
    exit_code: record.exit_code,
    duration_ms: record.duration_ms,
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
