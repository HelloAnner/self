import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { JobKind, JobRecord } from "../../domains/automation/index.ts";
import { automationInputHash } from "../../domains/automation/index.ts";
import type { SearchMode } from "../../domains/retrieval/index.ts";
import {
  readableAutomationDatabase,
  writableAutomationDatabase,
} from "../../infrastructure/automation/automation-db.ts";
import {
  cancellationRequested,
  claimJob,
  completeJob,
  failJob,
  getJob,
  insertJob,
  listJobEvents,
  listJobs,
  recoverAbandonedJobs,
  requestJobCancellation,
  retryJob,
  updateJobProgress,
} from "../../infrastructure/automation/job-repository.ts";
import { failure, SelfFailure } from "../../shared/errors/self-error.ts";
import { createResourceId } from "../../shared/ids/id.ts";
import type { GraphLayer } from "../graph/graph-build.ts";

const TERMINAL = new Set(["succeeded", "partial", "failed", "cancelled"]);

export async function enqueueJob(
  root: string,
  input: {
    kind: JobKind;
    values: Record<string, unknown>;
    requestId: string;
    idempotencyKey?: string;
    maxAttempts?: number;
    wait?: boolean;
  },
) {
  const inputHash = automationInputHash({ kind: input.kind, values: input.values });
  let database = await writableAutomationDatabase(root);
  let job: JobRecord;
  try {
    recoverAbandonedJobs(database);
    job = insertJob(database, {
      jobId: createResourceId("job"),
      requestId: input.requestId,
      kind: input.kind,
      inputHash,
      input: input.values,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      maxAttempts: input.maxAttempts ?? 3,
      createdAt: new Date().toISOString(),
    });
  } finally {
    database.close();
  }
  if (TERMINAL.has(job.state)) return job;
  if (input.wait) return executeJob(root, job.job_id);
  await spawnJobWorker(root, job.job_id);
  database = await readableAutomationDatabase(root);
  try {
    return getJob(database, job.job_id);
  } finally {
    database.close();
  }
}

export async function executeJob(root: string, jobId: string): Promise<JobRecord> {
  const owner = `worker:${process.pid}:${crypto.randomUUID()}`;
  let database = await writableAutomationDatabase(root);
  let job: JobRecord;
  try {
    recoverAbandonedJobs(database);
    job = claimJob(database, jobId, owner, process.pid);
    updateJobProgress(database, jobId, {
      checkpoint: job.checkpoint,
      progress: { stage: "dispatch", attempt: job.attempt },
      message: "Dispatching durable Job",
    });
    if (process.env.SELF_TEST_CRASH_JOB_AFTER_CLAIM === "1") process.exit(95);
  } finally {
    database.close();
  }
  try {
    if (process.env.SELF_TEST_JOB_MODEL_TIMEOUT === "1")
      throw failure("model_timeout", "Model provider timed out", "external", { retryable: true });
    const result = await executeJobKind(root, job);
    database = await writableAutomationDatabase(root);
    try {
      if (cancellationRequested(database, jobId))
        return failJob(database, jobId, { code: "job_cancelled", retryable: true });
      return completeJob(database, jobId, result);
    } finally {
      database.close();
    }
  } catch (cause) {
    database = await writableAutomationDatabase(root);
    try {
      const error = cause instanceof SelfFailure ? cause.selfError : internalError(cause);
      return failJob(database, jobId, error as unknown as Record<string, unknown>);
    } finally {
      database.close();
    }
  }
}

export async function showJob(root: string, jobId: string) {
  const database = await readableAutomationDatabase(root);
  try {
    return getJob(database, jobId);
  } finally {
    database.close();
  }
}

export async function showJobs(root: string, state?: string, limit = 100) {
  const database = await writableAutomationDatabase(root);
  try {
    recoverAbandonedJobs(database);
    return listJobs(database, state, limit);
  } finally {
    database.close();
  }
}

export async function showJobEvents(root: string, jobId: string, after = 0) {
  const database = await readableAutomationDatabase(root);
  try {
    return listJobEvents(database, jobId, after);
  } finally {
    database.close();
  }
}

export async function watchJob(root: string, jobId: string, timeoutMs = 300_000) {
  const started = Date.now();
  while (true) {
    const job = await showJob(root, jobId);
    if (TERMINAL.has(job.state)) {
      const events = await showJobEvents(root, jobId);
      return [...events, { event_type: "snapshot", job }];
    }
    if (Date.now() - started >= timeoutMs)
      throw failure("job_watch_timeout", "Timed out while waiting for Job", "external", {
        retryable: true,
      });
    await Bun.sleep(200);
  }
}

export async function cancelJob(root: string, jobId: string) {
  const database = await writableAutomationDatabase(root);
  try {
    return requestJobCancellation(database, jobId);
  } finally {
    database.close();
  }
}

export async function retryExistingJob(root: string, jobId: string, wait = false) {
  const database = await writableAutomationDatabase(root);
  let job: JobRecord;
  try {
    job = retryJob(database, jobId);
  } finally {
    database.close();
  }
  if (wait) return executeJob(root, jobId);
  await spawnJobWorker(root, jobId);
  return job;
}

async function executeJobKind(root: string, job: JobRecord): Promise<Record<string, unknown>> {
  await report(root, job.job_id, "running", "Starting operation");
  if (job.kind === "backup.create") {
    const { createWorkspaceBackup } = await import("../operations/backup.ts");
    return createWorkspaceBackup(root, job.job_id, {
      includeModels: job.input.include_models === true,
    });
  }
  if (job.kind === "verify.deep") {
    const { verifyWorkspaceDeep } = await import("../operations/verify.ts");
    const result = await verifyWorkspaceDeep(root, job.job_id);
    if (result.status !== "pass")
      throw failure(
        "workspace_verification_failed",
        "Workspace deep verification failed",
        "state",
        {
          details: {
            verification_id: result.verification_id,
            issue_count: result.issue_count,
            error_count: result.error_count,
          },
        },
      );
    return result;
  }
  if (job.kind === "graph.build") {
    const { buildGraph } = await import("../graph/graph-build.ts");
    return buildGraph(root, graphInput(job.input));
  }
  if (job.kind === "vector-space.build") {
    const vectorSpaceId = requiredString(job.input.vector_space_id, "vector_space_id");
    const { buildVectorSpace } = await import("../knowledge/vector-space-workflows.ts");
    return buildVectorSpace(root, vectorSpaceId, {
      ...(typeof job.input.batch_size === "number" ? { batchSize: job.input.batch_size } : {}),
    });
  }
  if (job.kind === "topic.build" || job.kind === "topic.refresh") {
    const topicId = requiredString(job.input.topic_id, "topic_id");
    const topic = await import("../topic/topic-build.ts");
    const options = topicInput(job.input);
    return job.kind === "topic.build"
      ? topic.buildTopic(root, topicId, options)
      : topic.refreshTopic(root, topicId, options);
  }
  throw failure("job_kind_unsupported", `Unsupported Job kind: ${job.kind}`, "state");
}

async function report(root: string, jobId: string, stage: string, message: string): Promise<void> {
  const database = await writableAutomationDatabase(root);
  try {
    if (cancellationRequested(database, jobId))
      throw failure("job_cancelled", "Job cancellation was requested", "state", {
        retryable: true,
      });
    updateJobProgress(database, jobId, {
      checkpoint: { stage },
      progress: { stage },
      message,
    });
  } finally {
    database.close();
  }
}

async function spawnJobWorker(root: string, jobId: string): Promise<void> {
  if (process.env.SELF_TEST_DISABLE_JOB_SPAWN === "1") return;
  await mkdir(join(root, "runtime/jobs", jobId.replace(":", "_")), { recursive: true });
  const executable = process.execPath;
  const args = basename(executable).startsWith("bun")
    ? [executable, process.argv[1] ?? "src/cli/main.ts", "--root", root, "job", "execute", jobId]
    : [executable, "--root", root, "job", "execute", jobId];
  const child = spawn(args[0] ?? executable, args.slice(1), {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function graphInput(input: Record<string, unknown>): {
  kind?: "incremental" | "full";
  layer?: GraphLayer;
  modelId?: string;
  maxChunks?: number;
  vectorSpaceId?: string;
  activate?: boolean;
} {
  return {
    ...(input.kind === "incremental" || input.kind === "full"
      ? { kind: input.kind as "incremental" | "full" }
      : {}),
    ...(typeof input.layer === "string"
      ? {
          layer: input.layer as
            | "structure"
            | "links"
            | "mentions"
            | "relations"
            | "claims"
            | "neighbors"
            | "all",
        }
      : {}),
    ...(typeof input.model_id === "string" ? { modelId: input.model_id } : {}),
    ...(typeof input.max_chunks === "number" ? { maxChunks: input.max_chunks } : {}),
    ...(typeof input.vector_space_id === "string" ? { vectorSpaceId: input.vector_space_id } : {}),
    ...(typeof input.activate === "boolean" ? { activate: input.activate } : {}),
  };
}

function topicInput(input: Record<string, unknown>): {
  mode?: SearchMode;
  limit?: number;
  tokenBudget?: number;
  templateId?: string;
} {
  return {
    ...(input.mode === "text" || input.mode === "vector" || input.mode === "hybrid"
      ? { mode: input.mode as SearchMode }
      : {}),
    ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
    ...(typeof input.token_budget === "number" ? { tokenBudget: input.token_budget } : {}),
    ...(typeof input.template_id === "string" ? { templateId: input.template_id } : {}),
  };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value)
    throw failure("job_input_invalid", `Job input ${name} is required`, "usage");
  return value;
}

function internalError(cause: unknown) {
  return {
    code: "job_execution_failed",
    category: "internal",
    retryable: true,
    message: "Job execution failed",
    details: { reason: cause instanceof Error ? cause.message : String(cause) },
  };
}
