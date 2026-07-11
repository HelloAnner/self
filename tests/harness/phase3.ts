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
const runRoot = resolve("data/test-runs/phase-3-real-cli");
const inputRoot = resolve(runRoot, "input");
const vault = resolve(inputRoot, "vault");
const connected = resolve(inputRoot, "connected");
const instance = resolve(runRoot, "instance");
const rebuiltInstance = resolve(runRoot, "rebuilt-instance");
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
await configureChunker(binary, instance);

const added = expectOk(
  await run([
    binary,
    "--root",
    instance,
    "source",
    "add",
    vault,
    "--kind",
    "directory",
    "--recursive",
    "--json",
  ]),
);
const sourceId = requireString(added.source_id);
assert(added.ingestion_status === "ready", "Default Source Add did not complete Ingestion");
assert(added.entry_count === 6, "Directory archive did not include the expected evidence files");
assert(
  added.documents_published === 5,
  "Supported Markdown/text/HTML/JSONL/PDF documents were not published",
);
assert(
  !records.at(-1)?.stderr.includes("@napi-rs/canvas"),
  "PDF parser leaked an optional rendering warning",
);

const status = expectOk<Record<string, unknown>[]>(
  await run([binary, "--root", instance, "knowledge", "status", "--source", sourceId, "--json"]),
);
assert(
  status[0]?.ingestion_run_state === "ready" && status[0]?.files_skipped === 1,
  "Ingestion status did not record the skipped attachment",
);
const initialDocuments = expectOk<Record<string, unknown>[]>(
  await run([
    binary,
    "--root",
    instance,
    "knowledge",
    "document",
    "list",
    "--source",
    sourceId,
    "--json",
  ]),
);
assert(initialDocuments.length === 5, "Knowledge Document count is incorrect");
const htmlDocument = initialDocuments.find((item) => item.logical_path === "page.html");
const pdfDocument = initialDocuments.find((item) => item.logical_path === "paper.pdf");
assert(htmlDocument && pdfDocument, "HTML or PDF Document is missing");
const shownHtml = expectOk(
  await run([
    binary,
    "--root",
    instance,
    "knowledge",
    "document",
    "show",
    requireString(htmlDocument.document_id),
    "--json",
  ]),
);
assert(
  String(shownHtml.content_text).includes("Safe local HTML") &&
    !String(shownHtml.content_text).includes("steal"),
  "HTML normalization retained executable content",
);
const shownPdf = expectOk(
  await run([
    binary,
    "--root",
    instance,
    "knowledge",
    "document",
    "show",
    requireString(pdfDocument.document_id),
    "--json",
  ]),
);
assert(
  String(shownPdf.content_text).includes("Hello PDF Evidence"),
  "PDF text was not extracted by the packaged CLI",
);

const beforeRepeat = await immutableCounts(instance);
const repeated = expectOk(
  await run([
    binary,
    "--root",
    instance,
    "source",
    "add",
    vault,
    "--kind",
    "directory",
    "--recursive",
    "--json",
  ]),
);
assert(
  repeated.reused_snapshot === true && repeated.reused_run === true,
  "Unchanged Source did not reuse Snapshot and IngestionRun",
);
assert(
  equal(beforeRepeat, await immutableCounts(instance)),
  "Unchanged Source created knowledge objects",
);

const articleBefore = await documentState(instance, sourceId, "article.md");
const stableBefore = await documentState(instance, sourceId, "stable.txt");
await Bun.write(
  resolve(vault, "article.md"),
  articleVersion("changed claim with stronger evidence"),
);
const modified = expectOk(
  await run([binary, "--root", instance, "source", "sync", sourceId, "--json"]),
);
assert(
  modified.modified === 1 && modified.ingestion_status === "ready",
  "Modified Source did not reach ready",
);
const articleAfter = await documentState(instance, sourceId, "article.md");
const stableAfter = await documentState(instance, sourceId, "stable.txt");
assert(
  articleAfter.revision_id !== articleBefore.revision_id,
  "Changed Document reused its Revision",
);
assert(
  stableAfter.revision_id === stableBefore.revision_id,
  "Unchanged Document created a Revision",
);
const reusedChunks = articleAfter.chunk_ids.filter((id) => articleBefore.chunk_ids.includes(id));
assert(reusedChunks.length > 0, "Small edit did not reuse unchanged Chunk IDs");
assert(
  articleAfter.chunk_ids.some((id) => !articleBefore.chunk_ids.includes(id)),
  "Changed Chunk was not replaced",
);
assert((await lineageCount(instance)) > 0, "Changed Chunk lineage was not recorded");

const stableRevision = stableAfter.revision_id;
const stableChunks = stableAfter.chunk_ids;
await Bun.write(
  resolve(vault, "stable.txt"),
  "Stable plain text evidence.   \n\nSecond paragraph.\n",
);
expectOk(await run([binary, "--root", instance, "source", "sync", sourceId, "--json"]));
const formatted = await documentState(instance, sourceId, "stable.txt");
assert(formatted.revision_id !== stableRevision, "Changed raw evidence did not create a Revision");
assert(equal(formatted.chunk_ids, stableChunks), "Formatting-only change replaced semantic Chunks");

await rm(resolve(vault, "events.jsonl"));
expectOk(await run([binary, "--root", instance, "source", "sync", sourceId, "--json"]));
const deleted = await rawDocumentState(instance, sourceId, "events.jsonl");
assert(deleted.state === "deleted", "Deleted source entry did not tombstone its Document");
assert(
  (await activeChunkCount(instance, requireString(deleted.document_id))) === 0,
  "Deleted Document retained active Chunks",
);

const brokenPath = resolve(inputRoot, "broken.jsonl");
expectError(
  await run(
    [binary, "--root", instance, "source", "add", brokenPath, "--kind", "jsonl", "--json"],
    5,
  ),
  "ingestion_parse_failed",
);
const sources = expectOk<Record<string, unknown>[]>(
  await run([binary, "--root", instance, "source", "list", "--json"]),
);
const brokenSource = sources.find((item) => item.name === "broken.jsonl");
assert(
  brokenSource?.ingestion_status === "failed",
  "Parse failure was not visible on Source status",
);
const brokenSourceId = requireString(brokenSource?.source_id);
assert(
  (await documentCount(instance, brokenSourceId)) === 0,
  "Parse failure published a partial Document",
);
await Bun.write(brokenPath, '{"fixed":true}\n');
const fixed = expectOk(
  await run([binary, "--root", instance, "source", "sync", brokenSourceId, "--json"]),
);
assert(fixed.ingestion_status === "ready", "Corrected JSONL did not recover");

const crashPath = resolve(inputRoot, "crash.md");
const archivedOnly = expectOk(
  await run([
    binary,
    "--root",
    instance,
    "source",
    "add",
    crashPath,
    "--kind",
    "markdown",
    "--no-build",
    "--json",
  ]),
);
assert(archivedOnly.ingestion_status === "not_started", "--no-build started Ingestion");
await run(
  [
    "bun",
    "run",
    "tests/helpers/crash-ingestion-after-publish.ts",
    instance,
    requireString(archivedOnly.source_id),
    requireString(archivedOnly.snapshot_id),
  ],
  99,
);
const interrupted = await latestRun(instance, requireString(archivedOnly.source_id));
assert(interrupted.state === "publishing", "Crash checkpoint did not leave a publishing Run");
const beforeRecovery = await immutableCounts(instance);
const recovered = expectOk(
  await run([
    binary,
    "--root",
    instance,
    "ingestion",
    "retry",
    requireString(interrupted.ingestion_run_id),
    "--json",
  ]),
);
assert(recovered.ingestion_status === "ready", "Interrupted Ingestion did not recover");
assert(
  equal(beforeRecovery, await immutableCounts(instance)),
  "Recovery duplicated published knowledge",
);

const connection = expectOk(
  await run([
    binary,
    "--root",
    instance,
    "connection",
    "add",
    connected,
    "--kind",
    "directory",
    "--recursive",
    "--settle",
    "0ms",
    "--delete-grace",
    "0ms",
    "--no-daemon",
    "--json",
  ]),
);
const connectionId = requireString(connection.connection_id);
assert(
  (await ingestedChangeCount(instance, connectionId)) > 0,
  "Initial Connection batch stopped before Ingestion",
);
await Bun.write(resolve(connected, "connected.md"), "# Connected\n\nautomatic ingestion updated\n");
expectOk(await run([binary, "--root", instance, "connection", "scan", connectionId, "--json"]));
assert(
  (await ingestedChangeCount(instance, connectionId)) >= 2,
  "Connection change was not projected to an ingested ChangeItem",
);

const managedNotes = expectOk(
  await run([
    binary,
    "--root",
    instance,
    "connection",
    "add",
    resolve(instance, "content/notes"),
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
const managedNotesConnectionId = requireString(managedNotes.connection_id);
const note = expectOk(
  await run([
    binary,
    "--root",
    instance,
    "note",
    "create",
    "Versioned Note",
    "--content",
    "first body",
    "--json",
  ]),
);
const noteId = requireString(note.note_id);
const notePath = resolve(instance, requireString(note.relative_path));
expectOk(
  await run([binary, "--root", instance, "connection", "scan", managedNotesConnectionId, "--json"]),
);
assert(
  (await consumedWriteReceiptCount(instance, managedNotesConnectionId)) === 1,
  "Managed Note create receipt was not consumed by reconciliation",
);
const updatedNote = expectOk(
  await run([
    binary,
    "--root",
    instance,
    "note",
    "update",
    noteId,
    "--content",
    "second body",
    "--if-version",
    "1",
    "--json",
  ]),
);
assert(updatedNote.version === 2, "Note update did not advance the version");
expectOk(
  await run([binary, "--root", instance, "connection", "scan", managedNotesConnectionId, "--json"]),
);
assert(
  (await consumedWriteReceiptCount(instance, managedNotesConnectionId)) === 2,
  "Managed Note update receipt was not consumed by reconciliation",
);
expectError(
  await run(
    [
      binary,
      "--root",
      instance,
      "note",
      "update",
      noteId,
      "--content",
      "stale body",
      "--if-version",
      "1",
      "--json",
    ],
    4,
  ),
  "note_version_conflict",
);
assert(
  (await Bun.file(notePath).text()).includes("second body"),
  "Stale Note update changed the managed file",
);
expectOk(await run([binary, "--root", instance, "note", "show", noteId, "--json"]));
expectOk(await run([binary, "--root", instance, "note", "list", "--json"]));

expectOk(
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
const verification = expectOk(
  await run([binary, "--root", instance, "knowledge", "verify", "--deep", "--json"]),
);
assert(verification.status === "pass", "Knowledge evidence verification failed");

expectOk(await run([binary, "init", rebuiltInstance, "--offline", "--json"]));
await configureChunker(binary, rebuiltInstance);
const rebuilt = expectOk(
  await run([
    binary,
    "--root",
    rebuiltInstance,
    "source",
    "add",
    vault,
    "--kind",
    "directory",
    "--recursive",
    "--json",
  ]),
);
assert(
  equal(
    await knowledgeSignature(instance, sourceId),
    await knowledgeSignature(rebuiltInstance, requireString(rebuilt.source_id)),
  ),
  "Incremental Knowledge did not converge to a clean full build",
);

await exerciseReadCommands(binary, instance, sourceId);
await verifyMigration(binary);
await verifyDatabase(instance);
await Bun.write(
  resolve(runRoot, "commands.jsonl"),
  `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
);
await Bun.write(
  resolve(runRoot, "result.json"),
  `${JSON.stringify({ status: "passed", commands: records.length, source_id: sourceId }, null, 2)}\n`,
);
process.stdout.write(`Phase 3 real CLI E2E passed: ${runRoot}\n`);

async function prepareFixtures(): Promise<void> {
  await mkdir(vault, { recursive: true });
  await mkdir(connected, { recursive: true });
  await Bun.write(resolve(vault, "article.md"), articleVersion("initial claim with evidence"));
  await Bun.write(
    resolve(vault, "stable.txt"),
    "Stable plain text evidence.\n\nSecond paragraph.\n",
  );
  await Bun.write(
    resolve(vault, "page.html"),
    "<html><head><title>Local Page</title><script>steal()</script></head><body><h1>Page</h1><p>Safe local HTML evidence.</p><a href='/proof'>proof</a></body></html>",
  );
  await Bun.write(
    resolve(vault, "events.jsonl"),
    '{"kind":"created","value":1}\n{"value":2,"kind":"updated"}\n',
  );
  await Bun.write(resolve(vault, "pixel.png"), new Uint8Array([137, 80, 78, 71]));
  await Bun.write(resolve(vault, "paper.pdf"), createPdf("Hello PDF Evidence"));
  await Bun.write(resolve(inputRoot, "broken.jsonl"), "{broken}\n");
  await Bun.write(resolve(inputRoot, "crash.md"), "# Crash recovery\n\npublished exactly once\n");
  await Bun.write(resolve(connected, "connected.md"), "# Connected\n\nautomatic ingestion\n");
}

function articleVersion(changed: string): string {
  return `---\ntags: [phase3, evidence]\n---\n# Evidence System\n\nStable introduction paragraph about local-first knowledge and durable evidence.\n\n## Architecture\n\nThe Source Snapshot remains immutable and every Revision points back to it.\n\n## Claim\n\n${changed}.\n\n## Recovery\n\nA publishing crash can retry without duplicating stable Chunks.\n`;
}

async function configureChunker(binaryPath: string, root: string): Promise<void> {
  expectOk(
    await run([
      binaryPath,
      "--root",
      root,
      "config",
      "set",
      "ingestion.chunk_overlap_tokens",
      "3",
      "--json",
    ]),
  );
  expectOk(
    await run([
      binaryPath,
      "--root",
      root,
      "config",
      "set",
      "ingestion.max_chunk_tokens",
      "30",
      "--json",
    ]),
  );
}

async function exerciseReadCommands(binaryPath: string, root: string, sourceIdValue: string) {
  const built = expectOk<Record<string, unknown>[]>(
    await run([
      binaryPath,
      "--root",
      root,
      "knowledge",
      "build",
      "--source",
      sourceIdValue,
      "--json",
    ]),
  );
  assert(built[0]?.reused_run === true, "Explicit Knowledge build did not reuse the ready Run");
  const docs = expectOk<Record<string, unknown>[]>(
    await run([
      binaryPath,
      "--root",
      root,
      "knowledge",
      "document",
      "list",
      "--source",
      sourceIdValue,
      "--json",
    ]),
  );
  const chunks = expectOk<Record<string, unknown>[]>(
    await run([
      binaryPath,
      "--root",
      root,
      "knowledge",
      "chunk",
      "list",
      "--source",
      sourceIdValue,
      "--include-tombstoned",
      "--json",
    ]),
  );
  expectOk(
    await run([
      binaryPath,
      "--root",
      root,
      "knowledge",
      "document",
      "show",
      requireString(docs[0]?.document_id),
      "--json",
    ]),
  );
  expectOk(
    await run([
      binaryPath,
      "--root",
      root,
      "knowledge",
      "chunk",
      "show",
      requireString(chunks[0]?.chunk_id),
      "--json",
    ]),
  );
  expectOk(
    await run([
      binaryPath,
      "--root",
      root,
      "knowledge",
      "explain",
      requireString(chunks[0]?.chunk_id),
      "--json",
    ]),
  );
  expectOk(await run([binaryPath, "--root", root, "knowledge", "failures", "--json"]));
  const latest = await latestRun(root, sourceIdValue);
  expectOk(
    await run([
      binaryPath,
      "--root",
      root,
      "ingestion",
      "show",
      requireString(latest.ingestion_run_id),
      "--json",
    ]),
  );
}

async function verifyMigration(binaryPath: string): Promise<void> {
  const legacy = resolve(runRoot, "schema-3-instance");
  expectOk(await run([binaryPath, "init", legacy, "--offline", "--json"]));
  await run(["bun", "run", "tests/helpers/downgrade-to-schema3-fixture.ts", legacy]);
  const status = expectOk(await run([binaryPath, "--root", legacy, "status", "--json"]));
  assert(status.state === "needs_migration", "Schema 3 fixture did not require migration");
  const plan = expectOk(await run([binaryPath, "--root", legacy, "migration", "plan", "--json"]));
  const applied = expectOk(
    await run([binaryPath, "--root", legacy, "apply", requireString(plan.plan_id), "--json"]),
  );
  assert(
    applied.to_version === VERSION.databaseSchema,
    "Schema 3 migration did not reach Schema 4",
  );
  assert(
    await Bun.file(resolve(legacy, requireString(applied.backup_relative_path))).exists(),
    "Migration backup is missing",
  );
}

async function verifyDatabase(root: string): Promise<void> {
  await withDatabase(root, (database) => {
    assert(
      database.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()
        ?.integrity_check === "ok",
      "Database integrity failed",
    );
    const orphans =
      database
        .query<{ count: number }, []>(
          `SELECT COUNT(*) count FROM knowledge_revision_chunks rc LEFT JOIN knowledge_revisions r ON r.revision_id = rc.revision_id LEFT JOIN knowledge_chunks c ON c.chunk_id = rc.chunk_id WHERE r.revision_id IS NULL OR c.chunk_id IS NULL`,
        )
        .get()?.count ?? 0;
    assert(orphans === 0, "Knowledge contains orphan Revision/Chunk mappings");
    const half =
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) count FROM ingestion_runs WHERE state IN ('queued','parsing','normalized','chunked','publishing','retrying')",
        )
        .get()?.count ?? 0;
    assert(half === 0, "Non-terminal IngestionRun remained after recovery");
  });
}

async function immutableCounts(root: string) {
  return withDatabase(root, (database) => ({
    runs: count(database, "ingestion_runs"),
    revisions: count(database, "knowledge_revisions"),
    chunks: count(database, "knowledge_chunks"),
    mappings: count(database, "knowledge_revision_chunks"),
  }));
}

async function documentState(root: string, sourceIdValue: string, path: string) {
  return withDatabase(root, (database) => {
    const row = database
      .query<{ document_id: string; revision_id: string }, [string, string]>(
        `SELECT d.document_id, d.current_revision_id revision_id FROM knowledge_documents d WHERE d.source_id = ? AND d.logical_path = ?`,
      )
      .get(sourceIdValue, path);
    assert(row, `Document ${path} is missing`);
    const chunkIds = database
      .query<{ chunk_id: string }, [string]>(
        "SELECT chunk_id FROM knowledge_revision_chunks WHERE revision_id = ? ORDER BY ordinal",
      )
      .all(row.revision_id)
      .map((item) => item.chunk_id);
    return { ...row, chunk_ids: chunkIds };
  });
}

async function rawDocumentState(root: string, sourceIdValue: string, path: string) {
  return withDatabase(
    root,
    (database) =>
      database
        .query<Record<string, unknown>, [string, string]>(
          "SELECT * FROM knowledge_documents WHERE source_id = ? AND logical_path = ?",
        )
        .get(sourceIdValue, path) ?? {},
  );
}

async function latestRun(root: string, sourceIdValue: string) {
  return withDatabase(
    root,
    (database) =>
      database
        .query<Record<string, unknown>, [string]>(
          "SELECT * FROM ingestion_runs WHERE source_id = ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(sourceIdValue) ?? {},
  );
}

async function knowledgeSignature(root: string, sourceIdValue: string) {
  return withDatabase(root, (database) => {
    const documents = database
      .query<
        { logical_path: string; revision_id: string; normalized_content_hash: string },
        [string]
      >(
        `SELECT d.logical_path, r.revision_id, r.normalized_content_hash
         FROM knowledge_documents d JOIN knowledge_revisions r ON r.revision_id = d.current_revision_id
         WHERE d.source_id = ? AND d.state = 'active' ORDER BY d.logical_path`,
      )
      .all(sourceIdValue);
    return documents.map((document) => ({
      logical_path: document.logical_path,
      normalized_content_hash: document.normalized_content_hash,
      chunks: database
        .query<{ content_hash: string }, [string]>(
          `SELECT c.content_hash FROM knowledge_revision_chunks rc
           JOIN knowledge_chunks c ON c.chunk_id = rc.chunk_id
           WHERE rc.revision_id = ? ORDER BY rc.ordinal`,
        )
        .all(document.revision_id)
        .map((chunk) => chunk.content_hash),
    }));
  });
}

async function lineageCount(root: string) {
  return withDatabase(root, (database) => count(database, "knowledge_chunk_lineage"));
}
async function documentCount(root: string, sourceIdValue: string) {
  return withDatabase(
    root,
    (database) =>
      database
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) count FROM knowledge_documents WHERE source_id = ?",
        )
        .get(sourceIdValue)?.count ?? 0,
  );
}
async function activeChunkCount(root: string, documentId: string) {
  return withDatabase(
    root,
    (database) =>
      database
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) count FROM knowledge_chunks WHERE document_id = ? AND state = 'active'",
        )
        .get(documentId)?.count ?? 0,
  );
}
async function ingestedChangeCount(root: string, connectionIdValue: string) {
  return withDatabase(
    root,
    (database) =>
      database
        .query<{ count: number }, [string]>(
          `SELECT COUNT(*) count FROM connection_change_items i JOIN connection_change_batches b ON b.change_batch_id = i.batch_id WHERE b.connection_id = ? AND i.state = 'ingested'`,
        )
        .get(connectionIdValue)?.count ?? 0,
  );
}
async function consumedWriteReceiptCount(root: string, connectionIdValue: string) {
  return withDatabase(
    root,
    (database) =>
      database
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) count FROM connection_write_receipts WHERE connection_id = ? AND consumed_at IS NOT NULL",
        )
        .get(connectionIdValue)?.count ?? 0,
  );
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

function count(database: ReturnType<typeof openSqlite>, table: string): number {
  const allowed = new Set([
    "ingestion_runs",
    "knowledge_revisions",
    "knowledge_chunks",
    "knowledge_revision_chunks",
    "knowledge_chunk_lineage",
  ]);
  if (!allowed.has(table)) throw new Error(`Unsupported count table: ${table}`);
  return (
    database.query<{ count: number }, []>(`SELECT COUNT(*) count FROM ${table}`).get()?.count ?? 0
  );
}

function createPdf(text: string): string {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${text}) Tj\nET\n`;
  objects.push(`5 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}endstream\nendobj\n`);
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(new TextEncoder().encode(pdf).length);
    pdf += object;
  }
  const xref = new TextEncoder().encode(pdf).length;
  pdf += "xref\n0 6\n0000000000 65535 f \n";
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  return `${pdf}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
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

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function requireString(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected string");
  return value;
}
function assertTestPath(path: string): void {
  if (!path.startsWith(resolve("data/test-runs"))) throw new Error(`Unsafe test path: ${path}`);
}
