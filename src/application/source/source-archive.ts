import { isAbsolute, join, relative } from "node:path";
import {
  type ArchivedEntry,
  compareSnapshotEntries,
  type InputEntry,
  type SnapshotChange,
  sourceAddInputSchema,
} from "../../domains/source/index.ts";
import { atomicWrite } from "../../infrastructure/filesystem/atomic-write.ts";
import { sha256Text } from "../../infrastructure/filesystem/hash.ts";
import { copyEntriesToManaged, persistEntries } from "../../infrastructure/source/blob-store.ts";
import { prepareSourceInput, readSourceSpec } from "../../infrastructure/source/input-reader.ts";
import {
  findSourceByIdentity,
  getSnapshotEntries,
  getSource,
  getSourceBatchReceipt,
  getSourceSnapshotSummary,
} from "../../infrastructure/source/source-reader.ts";
import {
  finishUnchanged,
  markSourceArchiving,
  markSourceFailed,
  publishSnapshot,
  recordSourceBatchReceipt,
  registerSource,
} from "../../infrastructure/source/source-store.ts";
import { failure, SelfFailure } from "../../shared/errors/self-error.ts";
import { createResourceId } from "../../shared/ids/id.ts";

export async function addSource(root: string, raw: unknown, requestId: string) {
  const parsed = sourceAddInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw failure(
      "source_input_invalid",
      "Source input did not match the command schema",
      "usage",
      {
        details: {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path,
            message: issue.message,
          })),
        },
      },
    );
  }
  const input = parsed.data;
  const prepared = await prepareSourceInput({
    input: input.input,
    kind: input.kind,
    mode: input.mode,
    ...(input.name ? { name: input.name } : {}),
    recursive: input.recursive,
    include: input.include,
    exclude: input.exclude,
    ...(input.stdinBytes ? { stdinBytes: input.stdinBytes } : {}),
  });
  if (prepared.spec.mode === "import" && prepared.spec.locator_type !== "external_path") {
    throw failure("source_input_invalid", "Import mode currently requires a local path", "usage");
  }
  assertAuthorizedPath(root, prepared.spec.locator_type, prepared.spec.locator);
  const identityKey = identity(prepared.spec, prepared.name, prepared.entries);
  const existing = await findSourceByIdentity(root, identityKey);
  if (existing?.state === "deleted")
    throw failure("source_deleted", "Source is deleted; restore it first", "state");
  if (existing) {
    const archived =
      existing.mode === "import"
        ? await archiveSourceFromSpec(root, existing.source_id, requestId)
        : await archiveEntries(root, existing.source_id, prepared.entries, requestId);
    return finalizeArchive(root, archived, input.noBuild, "source_add", requestId);
  }

  const sourceId = createResourceId("source");
  const now = new Date().toISOString();
  let entries = prepared.entries;
  let spec = prepared.spec;
  if (prepared.spec.mode === "import") {
    const managed = await copyEntriesToManaged(root, sourceId, entries);
    spec = {
      ...prepared.spec,
      locator_type: "managed_path" as const,
      locator: managed.relativeRoot,
    };
    entries = managed.entries;
  }
  const registered = await registerSource(root, {
    sourceId,
    identityKey,
    kind: spec.kind,
    mode: spec.mode,
    name: prepared.name,
    spec,
    now,
  });
  const archived = await archiveEntries(root, registered.source.source_id, entries, requestId);
  return finalizeArchive(root, archived, input.noBuild, "source_add", requestId);
}

export async function syncSource(root: string, sourceId: string, requestId: string) {
  const archived = await archiveSourceFromSpec(root, sourceId, requestId);
  return finalizeArchive(root, archived, false, "source_sync", requestId);
}

async function archiveSourceFromSpec(root: string, sourceId: string, requestId: string) {
  const source = await getSource(root, sourceId);
  if (source.state === "deleted")
    throw failure("source_deleted", "Deleted Source cannot sync", "state");
  try {
    const entries = await readSourceSpec(root, source.spec);
    return archiveEntries(root, sourceId, entries, requestId);
  } catch (cause) {
    const error = asSourceFailure(cause);
    await markSourceFailed(root, sourceId, error.selfError.code, error.selfError.message);
    throw error;
  }
}

export async function retrySource(root: string, sourceId: string, requestId: string) {
  const source = await getSource(root, sourceId);
  if (source.state !== "failed")
    throw failure("source_retry_invalid", "Only failed Sources can retry", "state");
  return syncSource(root, sourceId, requestId);
}

export async function acceptSourceChangeBatch(
  root: string,
  sourceId: string,
  changeBatchId: string,
  requestId: string,
) {
  const receipt = await getSourceBatchReceipt(root, changeBatchId);
  if (receipt) {
    if (receipt.source_id !== sourceId) {
      throw failure(
        "source_batch_conflict",
        "ChangeBatch already belongs to another Source",
        "conflict",
      );
    }
    const ingestion = await ingestArchived(
      root,
      sourceId,
      receipt.snapshot_id,
      "recovery",
      requestId,
    );
    return {
      ...ingestion,
      reused_batch: true as const,
    };
  }
  const archived = await archiveSourceFromSpec(root, sourceId, requestId);
  const ingestion = await ingestArchived(
    root,
    sourceId,
    archived.snapshot_id,
    "connection",
    requestId,
  );
  await recordSourceBatchReceipt(root, changeBatchId, sourceId, archived.snapshot_id);
  return { ...archived, ...ingestion, reused_batch: false as const };
}

async function archiveEntries(
  root: string,
  sourceId: string,
  entries: InputEntry[],
  requestId: string,
) {
  await markSourceArchiving(root, sourceId);
  try {
    const archived = await persistEntries(root, entries);
    const previous = await getSnapshotEntries(root, sourceId);
    const changes = compareSnapshotEntries(previous, archived);
    const summary = await getSourceSnapshotSummary(root, sourceId);
    const operation = operationInput(requestId, sourceId, archived);
    if (summary && changes.length === 0) {
      await finishUnchanged(root, sourceId, operation);
      return result(sourceId, summary.snapshot_id, archived, changes, operation.operationId, true);
    }
    const snapshotId = createResourceId("snapshot");
    const sequence = (summary?.sequence ?? 0) + 1;
    const manifest = createManifest(
      sourceId,
      snapshotId,
      sequence,
      summary?.snapshot_id ?? null,
      archived,
      changes,
    );
    const content = `${JSON.stringify(manifest, null, 2)}\n`;
    const relativePath = `content/sources/snapshots/${sourceId.replace(":", "_")}/${sequence}.json`;
    await atomicWrite(join(root, relativePath), content);
    await publishSnapshot(root, {
      sourceId,
      snapshotId,
      sequence,
      previousSnapshotId: summary?.snapshot_id ?? null,
      manifestSha256: sha256Text(content),
      manifestRelativePath: relativePath,
      entries: archived,
      changes,
      operation,
    });
    return result(sourceId, snapshotId, archived, changes, operation.operationId, false);
  } catch (cause) {
    const error = asSourceFailure(cause);
    await markSourceFailed(root, sourceId, error.selfError.code, error.selfError.message);
    throw error;
  }
}

function createManifest(
  sourceId: string,
  snapshotId: string,
  sequence: number,
  previousSnapshotId: string | null,
  entries: ArchivedEntry[],
  changes: SnapshotChange[],
) {
  return {
    manifest_version: 1,
    source_id: sourceId,
    snapshot_id: snapshotId,
    sequence,
    previous_snapshot_id: previousSnapshotId,
    created_at: new Date().toISOString(),
    entries: entries.map(({ blob_relative_path: _path, ...entry }) => entry),
    changes,
  };
}

function result(
  sourceId: string,
  snapshotId: string,
  entries: ArchivedEntry[],
  changes: SnapshotChange[],
  operationId: string,
  reused: boolean,
) {
  return {
    source_id: sourceId,
    snapshot_id: snapshotId,
    operation_id: operationId,
    archive_status: "published" as const,
    ingestion_status: "not_started" as const,
    entry_count: entries.length,
    total_bytes: entries.reduce((total, entry) => total + entry.size_bytes, 0),
    added: changes.filter((change) => change.change_kind === "added").length,
    modified: changes.filter((change) => change.change_kind === "modified").length,
    deleted: changes.filter((change) => change.change_kind === "deleted").length,
    reused_snapshot: reused,
  };
}

async function finalizeArchive(
  root: string,
  archived: ReturnType<typeof result>,
  noBuild: boolean,
  trigger: "source_add" | "source_sync",
  requestId: string,
) {
  if (noBuild) return archived;
  const ingestion = await ingestArchived(
    root,
    archived.source_id,
    archived.snapshot_id,
    trigger,
    requestId,
  );
  return { ...archived, ...ingestion };
}

async function ingestArchived(
  root: string,
  sourceId: string,
  snapshotId: string,
  trigger: "source_add" | "source_sync" | "connection" | "recovery",
  requestId: string,
) {
  const { ingestSnapshot } = await import("../ingestion/ingest-snapshot.ts");
  return ingestSnapshot(root, { sourceId, snapshotId, trigger }, requestId);
}

function identity(spec: object, name: string, entries: InputEntry[]): string {
  const stdinHash =
    entries[0]?.content.kind === "bytes" ? hashBytes(entries[0].content.bytes) : null;
  return sha256Text(JSON.stringify({ spec, name, stdin_hash: stdinHash }));
}

function operationInput(requestId: string, sourceId: string, entries: ArchivedEntry[]) {
  const now = new Date().toISOString();
  return {
    operationId: createResourceId("operation"),
    requestId,
    kind: "source.archive",
    inputHash: sha256Text(
      JSON.stringify({
        source_id: sourceId,
        entries: entries.map((entry) => [entry.logical_path, entry.blob_sha256]),
      }),
    ),
    now,
  };
}

function asSourceFailure(cause: unknown): SelfFailure {
  return cause instanceof SelfFailure
    ? cause
    : failure("source_archive_failed", "Source archive failed", "external", {
        retryable: true,
        details: { reason: cause instanceof Error ? cause.message : String(cause) },
      });
}

function hashBytes(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function assertAuthorizedPath(root: string, locatorType: string, locator: string | null): void {
  if (locatorType !== "external_path" || !locator) return;
  const fromRoot = relative(root, locator).split("\\").join("/");
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) return;
  const allowed = ["content/notes", "content/inbox"].some(
    (prefix) => fromRoot === prefix || fromRoot.startsWith(`${prefix}/`),
  );
  if (!allowed) {
    throw failure(
      "source_input_invalid",
      "Root-internal Sources must be under content/notes or content/inbox",
      "usage",
    );
  }
}
