import type { Dirent } from "node:fs";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { AutomationPlanManifest } from "../../domains/automation/index.ts";
import { automationInputHash } from "../../domains/automation/index.ts";
import { writableAutomationDatabase } from "../../infrastructure/automation/automation-db.ts";
import {
  automationPlan,
  completeAutomationOperation,
  insertAutomationPlan,
} from "../../infrastructure/automation/automation-repository.ts";
import { atomicWrite } from "../../infrastructure/filesystem/atomic-write.ts";
import { sha256File } from "../../infrastructure/filesystem/hash.ts";
import { vectorTableName } from "../../infrastructure/knowledge/vector-index.ts";
import { acquireMaintenanceLock } from "../../infrastructure/operations/maintenance-lock.ts";
import { failure } from "../../shared/errors/self-error.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import { planRelativePath } from "../automation/plan-workflows.ts";

type GcCandidate =
  | {
      kind: "unreferenced_blob";
      resource_id: string;
      relative_path: string;
      content_hash: string;
      size_bytes: number;
      proof: { snapshot_entries: 0; revisions: 0; evidence_contexts: 0; topic_citations: 0 };
    }
  | {
      kind: "stale_embedding";
      resource_id: string;
      relative_path: null;
      content_hash: string;
      size_bytes: 0;
      proof: { vector_space_id: string; dimensions: number; space_state: "deprecated" | "deleted" };
    }
  | {
      kind: "expired_temporary";
      resource_id: null;
      relative_path: string;
      content_hash: string;
      size_bytes: number;
      proof: { modified_at: string; older_than_ms: number };
    };

export async function createGcPlan(root: string, olderThanMs: number, requestId: string) {
  await recoverGcStaging(root);
  const candidates = await collectCandidates(root, olderThanMs);
  const proofHash = automationInputHash(candidates);
  const now = new Date();
  const input = { older_than_ms: olderThanMs, proof_hash: proofHash };
  const plan: AutomationPlanManifest = {
    plan_id: createResourceId("plan"),
    kind: "operations.gc",
    action: "collect",
    state: "ready",
    request_id: requestId,
    operation_id: createResourceId("operation"),
    resource_id: null,
    idempotency_key: null,
    input_hash: automationInputHash(input),
    input,
    preconditions: { proof_hash: proofHash, candidate_count: candidates.length },
    impact: {
      candidate_count: candidates.length,
      reclaimable_bytes: candidates.reduce((sum, item) => sum + item.size_bytes, 0),
      candidates_by_kind: countsByKind(candidates),
    },
    changes: candidates,
    inverse: null,
    reversible: false,
    atomicity: "atomic",
    targets: candidates
      .filter((item) => item.resource_id)
      .map((item) => ({
        resourceId: String(item.resource_id),
        resourceKind: item.kind,
        role: "affected" as const,
      })),
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 15 * 60_000).toISOString(),
  };
  const relativePath = planRelativePath(plan.plan_id);
  await atomicWrite(join(root, relativePath), `${JSON.stringify(plan, null, 2)}\n`);
  const database = await writableAutomationDatabase(root);
  try {
    insertAutomationPlan(database, plan, relativePath);
  } finally {
    database.close();
  }
  return plan;
}

export async function applyGcPlan(root: string, planId: string) {
  const lock = await acquireMaintenanceLock(root, "gc.apply");
  await recoverGcStaging(root);
  let database = await writableAutomationDatabase(root);
  let plan: AutomationPlanManifest;
  try {
    plan = automationPlan(database, planId);
  } finally {
    database.close();
  }
  if (plan.kind !== "operations.gc" || plan.action !== "collect")
    throw failure("plan_kind_unsupported", "Plan is not a GC Plan", "state");
  if (plan.state !== "ready" || Date.parse(plan.expires_at) < Date.now())
    throw failure("plan_expired", "GC Plan is no longer applicable", "conflict");
  const candidates = plan.changes as GcCandidate[];
  const olderThanMs = Number(plan.input.older_than_ms);
  const current = await collectCandidates(root, olderThanMs);
  if (automationInputHash(current) !== plan.preconditions.proof_hash)
    throw failure("plan_conflict", "GC candidates changed after Plan creation", "conflict");
  const staging = join(root, "runtime/tmp", `gc_${plan.operation_id.replace(":", "_")}`);
  const staged: Array<{ source: string; target: string }> = [];
  try {
    await mkdir(staging, { recursive: false });
    await atomicWrite(
      join(staging, "receipt.json"),
      `${JSON.stringify({ format: "self-gc-staging-v1", operation_id: plan.operation_id, files: candidates.filter((item) => item.relative_path).map((item) => item.relative_path) }, null, 2)}\n`,
    );
    for (const candidate of candidates) {
      if (!candidate.relative_path) continue;
      const source = safeRootPath(root, candidate.relative_path);
      const target = join(staging, "files", candidate.relative_path);
      await mkdir(dirname(target), { recursive: true });
      await rename(source, target);
      staged.push({ source, target });
    }
    const completedAt = new Date().toISOString();
    const reclaimedBytes = candidates.reduce((sum, item) => sum + item.size_bytes, 0);
    database = await writableAutomationDatabase(root);
    try {
      database.transaction(() => {
        for (const candidate of candidates) {
          if (candidate.kind === "unreferenced_blob")
            database
              .prepare("DELETE FROM source_blobs WHERE sha256 = ?")
              .run(candidate.resource_id);
          if (candidate.kind === "stale_embedding") {
            const table = vectorTableName(candidate.proof.dimensions);
            const exists = database
              .query<{ count: number }, [string]>(
                "SELECT COUNT(*) count FROM sqlite_master WHERE type = 'table' AND name = ?",
              )
              .get(table)?.count;
            if (exists)
              database
                .prepare(`DELETE FROM ${table} WHERE embedding_id = ?`)
                .run(candidate.resource_id);
            database
              .prepare("DELETE FROM knowledge_embeddings WHERE embedding_id = ?")
              .run(candidate.resource_id);
          }
        }
        completeAutomationOperation(database, {
          plan,
          operationId: plan.operation_id,
          requestId: plan.request_id,
          kind: "operations.gc",
          targetId: null,
          inputHash: plan.input_hash,
          result: { item_count: candidates.length, reclaimed_bytes: reclaimedBytes },
          changes: candidates.map((candidate) => ({
            resourceId: candidate.resource_id ?? candidate.relative_path ?? "temporary",
            resourceKind: candidate.kind,
            changeKind: "collected",
            before: { present: true, proof: candidate.proof },
            after: { present: false },
          })),
          reversible: false,
          atomicity: "atomic",
          createdAt: plan.created_at,
          completedAt,
        });
        database
          .prepare(
            `INSERT INTO operation_gc_receipts(operation_id, plan_id, item_count,
             reclaimed_bytes, proof_hash, completed_at) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            plan.operation_id,
            plan.plan_id,
            candidates.length,
            reclaimedBytes,
            String(plan.preconditions.proof_hash),
            completedAt,
          );
        const insert = database.prepare(
          `INSERT INTO operation_gc_items(operation_id, ordinal, candidate_kind,
           resource_id, relative_path, content_hash, size_bytes, proof_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        candidates.forEach((candidate, index) => {
          insert.run(
            plan.operation_id,
            index + 1,
            candidate.kind,
            candidate.resource_id,
            candidate.relative_path,
            candidate.content_hash,
            candidate.size_bytes,
            JSON.stringify(candidate.proof),
          );
        });
      })();
    } finally {
      database.close();
    }
    await rm(staging, { recursive: true, force: true });
    return {
      operation_id: plan.operation_id,
      plan_id: plan.plan_id,
      status: "succeeded",
      item_count: candidates.length,
      reclaimed_bytes: reclaimedBytes,
      proof_hash: plan.preconditions.proof_hash,
    };
  } catch (cause) {
    for (const file of staged.reverse()) {
      if (!(await exists(file.source)) && (await exists(file.target))) {
        await mkdir(dirname(file.source), { recursive: true });
        await rename(file.target, file.source);
      }
    }
    await rm(staging, { recursive: true, force: true });
    throw cause;
  } finally {
    await lock.release();
  }
}

export async function recoverGcStaging(root: string): Promise<number> {
  const temporary = join(root, "runtime/tmp");
  let names: string[];
  try {
    names = (await readdir(temporary)).filter((name) => name.startsWith("gc_operation_op_"));
  } catch {
    return 0;
  }
  let recovered = 0;
  for (const name of names) {
    const directory = join(temporary, name);
    try {
      const receipt = JSON.parse(await Bun.file(join(directory, "receipt.json")).text()) as {
        operation_id: string;
        files: string[];
      };
      const database = await writableAutomationDatabase(root);
      let committed = false;
      try {
        committed = Boolean(
          database
            .query<{ operation_id: string }, [string]>(
              "SELECT operation_id FROM operation_gc_receipts WHERE operation_id = ?",
            )
            .get(receipt.operation_id),
        );
      } finally {
        database.close();
      }
      if (!committed) {
        for (const path of receipt.files) {
          const staged = join(directory, "files", path);
          const original = safeRootPath(root, path);
          if ((await exists(staged)) && !(await exists(original))) {
            await mkdir(dirname(original), { recursive: true });
            await rename(staged, original);
          }
        }
      }
      await rm(directory, { recursive: true, force: true });
      recovered += 1;
    } catch {
      // Unknown staging content is retained for diagnostics; GC never guesses.
    }
  }
  return recovered;
}

async function collectCandidates(root: string, olderThanMs: number): Promise<GcCandidate[]> {
  const database = await writableAutomationDatabase(root);
  const candidates: GcCandidate[] = [];
  try {
    const blobs = database
      .query<
        {
          sha256: string;
          relative_path: string;
          size_bytes: number;
          snapshot_entries: number;
          revisions: number;
          evidence_contexts: number;
          topic_citations: number;
        },
        []
      >(
        `SELECT b.sha256, b.relative_path, b.size_bytes,
         (SELECT COUNT(*) FROM source_snapshot_entries e WHERE e.blob_sha256 = b.sha256) snapshot_entries,
         (SELECT COUNT(*) FROM knowledge_revisions r WHERE r.blob_sha256 = b.sha256) revisions,
         (SELECT COUNT(*) FROM evidence_context_items e WHERE e.blob_sha256 = b.sha256) evidence_contexts,
         (SELECT COUNT(*) FROM topic_report_citations c WHERE c.blob_sha256 = b.sha256) topic_citations
         FROM source_blobs b ORDER BY b.sha256`,
      )
      .all();
    for (const blob of blobs) {
      if (blob.snapshot_entries || blob.revisions || blob.evidence_contexts || blob.topic_citations)
        continue;
      if (!(await exists(safeRootPath(root, blob.relative_path)))) continue;
      candidates.push({
        kind: "unreferenced_blob",
        resource_id: blob.sha256,
        relative_path: blob.relative_path,
        content_hash: blob.sha256,
        size_bytes: blob.size_bytes,
        proof: { snapshot_entries: 0, revisions: 0, evidence_contexts: 0, topic_citations: 0 },
      });
    }
    const embeddings = database
      .query<
        {
          embedding_id: string;
          vector_hash: string;
          vector_space_id: string;
          dimensions: number;
          space_state: "deprecated" | "deleted";
        },
        []
      >(
        `SELECT e.embedding_id, e.vector_hash, e.vector_space_id, s.dimensions, s.state space_state
         FROM knowledge_embeddings e JOIN vector_spaces s ON s.vector_space_id = e.vector_space_id
         WHERE e.state = 'stale' AND s.state IN ('deprecated','deleted') ORDER BY e.embedding_id`,
      )
      .all();
    for (const embedding of embeddings)
      candidates.push({
        kind: "stale_embedding",
        resource_id: embedding.embedding_id,
        relative_path: null,
        content_hash: embedding.vector_hash,
        size_bytes: 0,
        proof: {
          vector_space_id: embedding.vector_space_id,
          dimensions: embedding.dimensions,
          space_state: embedding.space_state,
        },
      });
  } finally {
    database.close();
  }
  const threshold = Date.now() - olderThanMs;
  const temporary = join(root, "runtime/tmp");
  for (const file of await regularFiles(temporary)) {
    const relativePath = relative(root, file).split(sep).join("/");
    if (relativePath.startsWith("runtime/tmp/gc_")) continue;
    const metadata = await lstat(file);
    if (metadata.mtimeMs > threshold) continue;
    candidates.push({
      kind: "expired_temporary",
      resource_id: null,
      relative_path: relativePath,
      content_hash: await sha256File(file),
      size_bytes: metadata.size,
      proof: { modified_at: metadata.mtime.toISOString(), older_than_ms: olderThanMs },
    });
  }
  return candidates.sort((left, right) =>
    `${left.kind}:${left.resource_id ?? left.relative_path}`.localeCompare(
      `${right.kind}:${right.resource_id ?? right.relative_path}`,
    ),
  );
}

async function regularFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await regularFiles(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

function countsByKind(candidates: GcCandidate[]) {
  const counts: Record<string, number> = {};
  for (const candidate of candidates) counts[candidate.kind] = (counts[candidate.kind] ?? 0) + 1;
  return counts;
}

function safeRootPath(root: string, path: string): string {
  const base = resolve(root);
  const absolute = resolve(base, path);
  if (absolute !== base && !absolute.startsWith(`${base}${sep}`))
    throw failure("gc_path_invalid", "GC candidate path escapes Workspace Root", "state");
  return absolute;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
