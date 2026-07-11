import { mkdir, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { openSqlite } from "../../src/infrastructure/db/connection.ts";
import { sha256File } from "../../src/infrastructure/filesystem/hash.ts";
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
const runRoot = resolve("data/test-runs/phase-2-5-real-cli");
const inputRoot = resolve(runRoot, "input");
const project = resolve(inputRoot, "project");
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

expectError(
  await run(
    [
      binary,
      "--root",
      instance,
      "connection",
      "add",
      instance,
      "--kind",
      "directory",
      "--recursive",
      "--no-daemon",
      "--json",
    ],
    2,
  ),
  "connection_self_reference",
);

const managedPath = resolve(instance, "content/notes/local");
await mkdir(managedPath, { recursive: true });
await Bun.write(resolve(managedPath, "managed.md"), "# Managed\n");
const managed = expectOk(
  await run([
    binary,
    "--root",
    instance,
    "connection",
    "add",
    managedPath,
    "--kind",
    "directory",
    "--scope",
    "managed-content",
    "--recursive",
    "--settle",
    "0ms",
    "--no-daemon",
    "--json",
  ]),
);
assert(typeof managed.connection_id === "string", "Managed content Connection was not created");

const created = expectOk(
  await run([
    binary,
    "--root",
    instance,
    "connection",
    "add",
    project,
    "--kind",
    "project",
    "--recursive",
    "--interval",
    "50ms",
    "--settle",
    "0ms",
    "--delete-grace",
    "40ms",
    "--no-daemon",
    "--json",
  ]),
);
const connectionId = requireString(created.connection_id);
assert(created.state === "active", "Initial Connection did not become active");
const initialScan = await scanResult(instance, requireString(created.scan_run_id));
assert(initialScan.changes_created === 2, "Initial scan did not classify two accepted files");

const repeated = expectOk(
  await run([
    binary,
    "--root",
    instance,
    "connection",
    "add",
    project,
    "--kind",
    "project",
    "--recursive",
    "--interval",
    "50ms",
    "--settle",
    "0ms",
    "--delete-grace",
    "40ms",
    "--no-daemon",
    "--json",
  ]),
);
assert(
  repeated.reused === true && repeated.connection_id === connectionId,
  "Duplicate add was not idempotent",
);
expectError(
  await run(
    [
      binary,
      "--root",
      instance,
      "connection",
      "add",
      resolve(project, "docs"),
      "--kind",
      "directory",
      "--recursive",
      "--no-daemon",
      "--json",
    ],
    4,
  ),
  "connection_target_overlap",
);

const status = expectOk<{ health: { level: string }; metrics: { known_files: number } }>(
  await run([binary, "--root", instance, "connection", "status", connectionId, "--json"]),
);
assert(
  status.health?.level === "healthy" && status.metrics?.known_files === 2,
  "Connection health is incorrect",
);

await Bun.write(resolve(project, "docs/a.md"), "# A\n\nmodified\n");
const modified = expectOk(
  await run([binary, "--root", instance, "connection", "scan", connectionId, "--json"]),
);
assert(modified.modified === 1, "Content change was not classified as modified");

await rename(resolve(project, "docs/b.md"), resolve(project, "docs/renamed.md"));
const renamed = expectOk(
  await run([binary, "--root", instance, "connection", "scan", connectionId, "--json"]),
);
assert(renamed.renamed === 1, "Rename was not classified by identity or hash");

await rm(resolve(project, "docs/renamed.md"));
const missing = expectOk(
  await run([binary, "--root", instance, "connection", "scan", connectionId, "--json"]),
);
assert(missing.deleted === 0, "Delete grace emitted a deletion immediately");
await Bun.sleep(50);
const deleted = expectOk(
  await run([binary, "--root", instance, "connection", "scan", connectionId, "--json"]),
);
assert(deleted.deleted === 1, "Delete grace did not eventually emit deletion");
await Bun.write(resolve(project, "docs/renamed.md"), "# B\n");
const restored = expectOk(
  await run([binary, "--root", instance, "connection", "scan", connectionId, "--json"]),
);
assert(restored.restored === 1, "Reappearing deleted path was not classified as restored");

await Bun.write(resolve(project, "docs/dry.md"), "# Dry run\n");
const eventsBeforeDryRun = await eventCount(instance, connectionId);
const dryRun = expectOk(
  await run([
    binary,
    "--root",
    instance,
    "connection",
    "scan",
    connectionId,
    "--dry-run",
    "--json",
  ]),
);
assert(dryRun.dry_run === true && dryRun.created === 1, "Dry run did not preview changes");
assert(
  (await eventCount(instance, connectionId)) === eventsBeforeDryRun,
  "Dry run persisted a ChangeItem",
);
expectOk(await run([binary, "--root", instance, "connection", "scan", connectionId, "--json"]));

const unavailablePath = resolve(inputRoot, "project-unavailable");
const snapshotBeforeUnavailable = await currentSnapshot(instance, requireString(created.source_id));
const eventsBeforeUnavailable = await eventCount(instance, connectionId);
await rename(project, unavailablePath);
expectError(
  await run([binary, "--root", instance, "connection", "scan", connectionId, "--json"], 6),
  "connection_target_unavailable",
);
const degraded = expectOk(
  await run([binary, "--root", instance, "connection", "status", connectionId, "--json"]),
);
assert(degraded.state === "degraded", "Unavailable Target did not degrade the Connection");
assert(
  (await currentSnapshot(instance, requireString(created.source_id))) === snapshotBeforeUnavailable,
  "Unavailable Target changed evidence",
);
assert(
  (await eventCount(instance, connectionId)) === eventsBeforeUnavailable,
  "Unavailable Target emitted false deletions",
);
await rename(unavailablePath, project);
expectOk(await run([binary, "--root", instance, "connection", "retry", connectionId, "--json"]));

await Bun.write(resolve(project, "docs/a.md"), "# A\n\ncrash checkpoint\n");
const beforeCrashItems = await eventCount(instance, connectionId);
await run(
  ["bun", "run", "tests/helpers/crash-connection-after-batch.ts", instance, connectionId],
  99,
);
assert(
  await interruptedScanExists(instance, connectionId),
  "Crash did not leave an interrupted Scan",
);
expectOk(await run([binary, "--root", instance, "daemon", "run", "--once", "--json"]));
assert(
  !(await interruptedScanExists(instance, connectionId)),
  "Daemon did not recover the interrupted Scan",
);
assert(
  (await eventCount(instance, connectionId)) === beforeCrashItems + 1,
  "Recovered batch duplicated ChangeItems",
);

const daemon = expectOk(await run([binary, "--root", instance, "daemon", "start", "--json"]));
assert(daemon.state === "running", "Daemon did not start");
const duplicateDaemon = expectOk(
  await run([binary, "--root", instance, "daemon", "start", "--json"]),
);
assert(duplicateDaemon.reused === true, "Repeated daemon start created a second leader");
const restartedDaemon = expectOk(
  await run([binary, "--root", instance, "daemon", "restart", "--json"]),
);
assert(restartedDaemon.state === "running", "Daemon did not restart");
expectError(
  await run([binary, "--root", instance, "daemon", "run", "--once", "--json"], 4),
  "connection_daemon_conflict",
);

await Bun.write(resolve(project, "docs/watched.md"), "# Watched\n");
assert(
  await waitForEvent(binary, "docs/watched.md"),
  "Native watcher did not trigger automatic archival",
);
expectOk(await run([binary, "--root", instance, "daemon", "stop", "--json"]));

await Bun.write(resolve(project, "docs/a.md"), "# A\n\nwatcher loss reconciliation\n");
await Bun.sleep(60);
const beforeReconcile = await eventCount(instance, connectionId);
expectOk(await run([binary, "--root", instance, "daemon", "run", "--once", "--json"]));
assert(
  (await eventCount(instance, connectionId)) === beforeReconcile + 1,
  "Polling reconciliation did not recover a lost watcher event",
);

const crashDaemon = expectOk(await run([binary, "--root", instance, "daemon", "start", "--json"]));
const crashedPid = requireNumber(crashDaemon.pid);
process.kill(crashedPid, "SIGKILL");
await waitForPidExit(crashedPid);
await Bun.sleep(15_100);
const takeover = expectOk(await run([binary, "--root", instance, "daemon", "start", "--json"]));
assert(
  takeover.state === "running" && takeover.pid !== crashedPid,
  "Expired Lease was not taken over",
);
expectOk(await run([binary, "--root", instance, "daemon", "stop", "--json"]));

const movedProject = resolve(inputRoot, "project-moved");
await rename(project, movedProject);
const rebindPlan = expectOk(
  await run([
    binary,
    "--root",
    instance,
    "connection",
    "rebind",
    connectionId,
    movedProject,
    "--plan",
    "--json",
  ]),
);
const rebound = expectOk(
  await run([binary, "--root", instance, "apply", requireString(rebindPlan.plan_id), "--json"]),
);
assert(rebound.state === "active", "Connection Rebind Plan did not apply");
assert(
  (await sourceLocator(instance, requireString(created.source_id))) === movedProject,
  "Rebind did not atomically update the bound Source",
);
await Bun.write(resolve(movedProject, "docs/a.md"), "# A\n\nbound source sync\n");
const boundSync = expectOk(
  await run([
    binary,
    "--root",
    instance,
    "source",
    "sync",
    requireString(created.source_id),
    "--json",
  ]),
);
assert(boundSync.modified === 1, "Bound source sync did not delegate to Connection reconciliation");

expectOk(await run([binary, "--root", instance, "connection", "pause", connectionId, "--json"]));
const resumed = expectOk(
  await run([binary, "--root", instance, "connection", "resume", connectionId, "--json"]),
);
assert(resumed.state === "active", "Connection did not resume with a full scan");

const watchedSourcePath = resolve(inputRoot, "source-watch");
await mkdir(watchedSourcePath, { recursive: true });
await Bun.write(resolve(watchedSourcePath, "note.md"), "# Source watch\n");
const watchedSource = expectOk(
  await run([
    binary,
    "--root",
    instance,
    "source",
    "add",
    watchedSourcePath,
    "--kind",
    "directory",
    "--watch",
    "--recursive",
    "--settle",
    "0ms",
    "--no-daemon",
    "--no-build",
    "--json",
  ]),
);
assert(
  typeof watchedSource.connection_id === "string",
  "source add --watch did not create a Connection",
);

expectOk(await run([binary, "--root", instance, "connection", "list", "--json"]));
expectOk(await run([binary, "--root", instance, "connection", "show", connectionId, "--json"]));
expectOk(await run([binary, "--root", instance, "connection", "events", "--all", "--json"]));
expectOk(await run([binary, "--root", instance, "connection", "changes", connectionId, "--json"]));
await run([binary, "--root", instance, "connection", "watch", connectionId, "--once", "--jsonl"]);
expectOk(await run([binary, "--root", instance, "connection", "scan", "--due", "--json"]));
expectOk(await run([binary, "--root", instance, "daemon", "logs", "--json"]));

await verifyDatabase(instance);
await verifyMigration(binary);
await Bun.write(
  resolve(runRoot, "commands.jsonl"),
  `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
);
await Bun.write(
  resolve(runRoot, "result.json"),
  `${JSON.stringify({ status: "passed", commands: records.length, connection_id: connectionId }, null, 2)}\n`,
);
process.stdout.write(`Phase 2.5 real CLI E2E passed: ${runRoot}\n`);

async function prepareFixtures(): Promise<void> {
  await mkdir(resolve(project, "docs"), { recursive: true });
  await mkdir(resolve(project, "node_modules"), { recursive: true });
  await Bun.write(resolve(project, "docs/a.md"), "# A\n");
  await Bun.write(resolve(project, "docs/b.md"), "# B\n");
  await Bun.write(resolve(project, "node_modules/ignored.md"), "ignored\n");
  await Bun.write(resolve(project, ".env"), "SECRET=not-archived\n");
}

async function waitForEvent(binaryPath: string, path: string): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await Bun.sleep(100);
    const events = expectOk(
      await run([binaryPath, "--root", instance, "connection", "events", connectionId, "--json"]),
    );
    if (Array.isArray(events) && events.some((event) => event.relative_path === path)) return true;
  }
  return false;
}

async function verifyMigration(binaryPath: string): Promise<void> {
  const legacy = resolve(runRoot, "schema-2-instance");
  expectOk(await run([binaryPath, "init", legacy, "--offline", "--json"]));
  await run(["bun", "run", "tests/helpers/downgrade-to-schema2-fixture.ts", legacy]);
  const status = expectOk(await run([binaryPath, "--root", legacy, "status", "--json"]));
  assert(status.state === "needs_migration", "Schema 2 fixture did not require migration");
  const plan = expectOk(await run([binaryPath, "--root", legacy, "migration", "plan", "--json"]));
  const applied = expectOk(
    await run([binaryPath, "--root", legacy, "apply", requireString(plan.plan_id), "--json"]),
  );
  assert(
    applied.to_version === VERSION.databaseSchema,
    "Schema 2 migration did not reach schema 3",
  );
  assert(
    await Bun.file(resolve(legacy, requireString(applied.backup_relative_path))).exists(),
    "Schema 2 migration backup is missing",
  );
}

async function verifyDatabase(root: string): Promise<void> {
  const assets = await locateWorkspaceAssets(root);
  const database = openSqlite(resolve(root, "data/self.sqlite3"), assets, { readonly: true });
  try {
    assert(
      database.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()
        ?.integrity_check === "ok",
      "Connection database integrity failed",
    );
    const orphan =
      database
        .query<{ count: number }, []>(
          `SELECT COUNT(*) count FROM connection_change_items i LEFT JOIN connection_change_batches b ON b.change_batch_id = i.batch_id WHERE b.change_batch_id IS NULL`,
        )
        .get()?.count ?? 0;
    assert(orphan === 0, "Orphan ChangeItems exist");
    const sensitive =
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) count FROM connection_observations WHERE relative_path LIKE '%.env%'",
        )
        .get()?.count ?? 0;
    assert(sensitive === 0, "Sensitive file entered Connection observations");
    const blobs = database
      .query<{ sha256: string; relative_path: string }, []>(
        "SELECT sha256, relative_path FROM source_blobs",
      )
      .all();
    for (const blob of blobs)
      assert(
        (await sha256File(resolve(root, blob.relative_path))) === blob.sha256,
        `Blob hash mismatch: ${blob.sha256}`,
      );
  } finally {
    database.close();
  }
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

async function scanResult(root: string, scanId: string) {
  return withDatabase(
    root,
    (database) =>
      database
        .query<{ changes_created: number }, [string]>(
          "SELECT changes_created FROM connection_scan_runs WHERE scan_run_id = ?",
        )
        .get(scanId) ?? { changes_created: 0 },
  );
}

async function eventCount(root: string, connectionIdValue: string): Promise<number> {
  return withDatabase(
    root,
    (database) =>
      database
        .query<{ count: number }, [string]>(
          `SELECT COUNT(*) count FROM connection_change_items i JOIN connection_change_batches b ON b.change_batch_id = i.batch_id WHERE b.connection_id = ?`,
        )
        .get(connectionIdValue)?.count ?? 0,
  );
}

async function interruptedScanExists(root: string, connectionIdValue: string): Promise<boolean> {
  return withDatabase(
    root,
    (database) =>
      (database
        .query<{ count: number }, [string]>(
          `SELECT COUNT(*) count FROM connection_scan_runs WHERE connection_id = ? AND state IN ('queued','enumerating','comparing','hashing','batching')`,
        )
        .get(connectionIdValue)?.count ?? 0) > 0,
  );
}

async function currentSnapshot(root: string, sourceId: string): Promise<string | null> {
  return withDatabase(
    root,
    (database) =>
      database
        .query<{ current_snapshot_id: string | null }, [string]>(
          "SELECT current_snapshot_id FROM sources WHERE source_id = ?",
        )
        .get(sourceId)?.current_snapshot_id ?? null,
  );
}

async function sourceLocator(root: string, sourceId: string): Promise<string | null> {
  return withDatabase(root, (database) => {
    const value = database
      .query<{ spec_json: string }, [string]>("SELECT spec_json FROM sources WHERE source_id = ?")
      .get(sourceId);
    return value ? (JSON.parse(value.spec_json).locator ?? null) : null;
  });
}

async function waitForPidExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await Bun.sleep(50);
  }
  throw new Error(`PID ${pid} did not exit`);
}

async function run(argv: string[], expected = 0): Promise<CommandRecord> {
  const started = performance.now();
  const child = Bun.spawn(argv, {
    cwd: repository,
    env: isolatedEnvironment(),
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

function expectError(record: CommandRecord, code: string): void {
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
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function requireString(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected string in CLI envelope");
  return value;
}

function requireNumber(value: unknown): number {
  if (typeof value !== "number") throw new Error("Expected number in CLI envelope");
  return value;
}

function assertTestPath(path: string): void {
  if (!path.startsWith(resolve("data/test-runs"))) throw new Error(`Unsafe test path: ${path}`);
}
