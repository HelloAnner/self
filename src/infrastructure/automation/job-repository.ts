import type { Database } from "bun:sqlite";
import type { JobKind, JobRecord, JobState } from "../../domains/automation/index.ts";
import { failure } from "../../shared/errors/self-error.ts";

type Row = Record<string, unknown>;

export function insertJob(
  database: Database,
  input: {
    jobId: string;
    requestId: string;
    kind: JobKind;
    inputHash: string;
    input: Record<string, unknown>;
    idempotencyKey?: string;
    maxAttempts: number;
    createdAt: string;
  },
): JobRecord {
  if (input.idempotencyKey) {
    const existing = database
      .query<Row, [string]>("SELECT * FROM automation_jobs WHERE idempotency_key = ?")
      .get(input.idempotencyKey);
    if (existing) {
      if (existing.input_hash !== input.inputHash || existing.kind !== input.kind)
        throw failure(
          "job_idempotency_conflict",
          "Job idempotency key was used with different input",
          "conflict",
        );
      return jobFromRow(existing);
    }
  }
  database.transaction(() => {
    database
      .prepare(
        `INSERT INTO automation_jobs(job_id, request_id, kind, state, idempotency_key,
         input_hash, input_json, max_attempts, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.jobId,
        input.requestId,
        input.kind,
        input.idempotencyKey ?? null,
        input.inputHash,
        JSON.stringify(input.input),
        input.maxAttempts,
        input.createdAt,
        input.createdAt,
      );
    appendJobEvent(database, input.jobId, "queued", "queued", {}, "Job accepted", input.createdAt);
  })();
  return getJob(database, input.jobId);
}

export function getJob(database: Database, jobId: string): JobRecord {
  const row = database
    .query<Row, [string]>("SELECT * FROM automation_jobs WHERE job_id = ?")
    .get(jobId);
  if (!row) throw failure("job_not_found", "Job does not exist", "not_found");
  return jobFromRow(row);
}

export function listJobs(database: Database, state?: string, limit = 100): JobRecord[] {
  const rows = state
    ? database
        .query<Row, [string, number]>(
          "SELECT * FROM automation_jobs WHERE state = ? ORDER BY created_at DESC LIMIT ?",
        )
        .all(state, limit)
    : database
        .query<Row, [number]>("SELECT * FROM automation_jobs ORDER BY created_at DESC LIMIT ?")
        .all(limit);
  return rows.map(jobFromRow);
}

export function listJobEvents(database: Database, jobId: string, after = 0) {
  getJob(database, jobId);
  return database
    .query<Row, [string, number]>(
      `SELECT job_id, sequence, event_type, state, progress_json, message, created_at
       FROM automation_job_events WHERE job_id = ? AND sequence > ? ORDER BY sequence`,
    )
    .all(jobId, after)
    .map((row) => ({
      job_id: String(row.job_id),
      sequence: Number(row.sequence),
      event_type: String(row.event_type),
      state: String(row.state),
      progress: parseObject(row.progress_json),
      message: row.message === null ? null : String(row.message),
      created_at: String(row.created_at),
    }));
}

export function claimJob(database: Database, jobId: string, owner: string, pid: number): JobRecord {
  const current = getJob(database, jobId);
  if (current.state !== "queued" && current.state !== "waiting")
    throw failure("job_state_invalid", "Only queued or waiting Jobs can run", "state");
  const now = new Date();
  const leaseMs = Number(process.env.SELF_TEST_JOB_LEASE_MS ?? 60_000);
  const lease = new Date(now.getTime() + leaseMs).toISOString();
  database.transaction(() => {
    const update = database
      .prepare(
        `UPDATE automation_jobs SET state = 'running', attempt = attempt + 1,
         lease_owner = ?, lease_expires_at = ?, worker_pid = ?,
         started_at = COALESCE(started_at, ?), updated_at = ?, finished_at = NULL
         WHERE job_id = ? AND state IN ('queued','waiting')`,
      )
      .run(owner, lease, pid, now.toISOString(), now.toISOString(), jobId);
    if (Number(update.changes) !== 1)
      throw failure("job_claim_conflict", "Job was claimed by another worker", "conflict", {
        retryable: true,
      });
    appendJobEvent(
      database,
      jobId,
      "started",
      "running",
      current.progress,
      `Attempt ${current.attempt + 1} started`,
      now.toISOString(),
    );
  })();
  return getJob(database, jobId);
}

export function updateJobProgress(
  database: Database,
  jobId: string,
  input: {
    checkpoint?: Record<string, unknown>;
    progress: Record<string, unknown>;
    message?: string;
  },
): void {
  const now = new Date().toISOString();
  database.transaction(() => {
    database
      .prepare(
        `UPDATE automation_jobs SET checkpoint_json = COALESCE(?, checkpoint_json),
         progress_json = ?, lease_expires_at = ?, updated_at = ?
         WHERE job_id = ? AND state = 'running'`,
      )
      .run(
        input.checkpoint ? JSON.stringify(input.checkpoint) : null,
        JSON.stringify(input.progress),
        new Date(Date.now() + 60_000).toISOString(),
        now,
        jobId,
      );
    appendJobEvent(
      database,
      jobId,
      "progress",
      "running",
      input.progress,
      input.message ?? null,
      now,
    );
  })();
}

export function completeJob(
  database: Database,
  jobId: string,
  result: Record<string, unknown>,
): JobRecord {
  const now = new Date().toISOString();
  database.transaction(() => {
    database
      .prepare(
        `UPDATE automation_jobs SET state = 'succeeded', result_json = ?, error_json = NULL,
         progress_json = ?, lease_owner = NULL, lease_expires_at = NULL, worker_pid = NULL,
         updated_at = ?, finished_at = ? WHERE job_id = ? AND state = 'running'`,
      )
      .run(JSON.stringify(result), JSON.stringify({ completed: true }), now, now, jobId);
    appendJobEvent(
      database,
      jobId,
      "completed",
      "succeeded",
      { completed: true },
      "Job completed",
      now,
    );
  })();
  return getJob(database, jobId);
}

export function failJob(
  database: Database,
  jobId: string,
  error: Record<string, unknown>,
): JobRecord {
  const current = getJob(database, jobId);
  const now = new Date().toISOString();
  const state: JobState = current.cancel_requested_at ? "cancelled" : "failed";
  database.transaction(() => {
    database
      .prepare(
        `UPDATE automation_jobs SET state = ?, error_json = ?, lease_owner = NULL,
         lease_expires_at = NULL, worker_pid = NULL, updated_at = ?, finished_at = ?
         WHERE job_id = ?`,
      )
      .run(state, JSON.stringify(error), now, now, jobId);
    appendJobEvent(
      database,
      jobId,
      state,
      state,
      current.progress,
      String(error.code ?? state),
      now,
    );
  })();
  return getJob(database, jobId);
}

export function requestJobCancellation(database: Database, jobId: string): JobRecord {
  const job = getJob(database, jobId);
  if (["succeeded", "partial", "failed", "cancelled"].includes(job.state))
    throw failure("job_state_invalid", "Finished Job cannot be cancelled", "state");
  const now = new Date().toISOString();
  database.transaction(() => {
    if (job.state === "queued" || job.state === "waiting")
      database
        .prepare(
          `UPDATE automation_jobs SET state = 'cancelled', cancel_requested_at = ?,
           updated_at = ?, finished_at = ? WHERE job_id = ?`,
        )
        .run(now, now, now, jobId);
    else
      database
        .prepare(
          "UPDATE automation_jobs SET cancel_requested_at = ?, updated_at = ? WHERE job_id = ?",
        )
        .run(now, now, jobId);
    appendJobEvent(
      database,
      jobId,
      "cancel_requested",
      job.state === "running" ? "running" : "cancelled",
      job.progress,
      "Cancellation requested",
      now,
    );
  })();
  return getJob(database, jobId);
}

export function retryJob(database: Database, jobId: string): JobRecord {
  const job = getJob(database, jobId);
  if (!["failed", "cancelled", "waiting"].includes(job.state))
    throw failure(
      "job_state_invalid",
      "Only failed, cancelled, or interrupted Jobs can retry",
      "state",
    );
  if (job.attempt >= job.max_attempts)
    throw failure("job_attempts_exhausted", "Job has exhausted its retry budget", "state");
  const now = new Date().toISOString();
  database.transaction(() => {
    database
      .prepare(
        `UPDATE automation_jobs SET state = 'queued', cancel_requested_at = NULL,
         error_json = NULL, updated_at = ?, finished_at = NULL WHERE job_id = ?`,
      )
      .run(now, jobId);
    appendJobEvent(database, jobId, "retried", "queued", job.progress, "Job queued for retry", now);
  })();
  return getJob(database, jobId);
}

export function recoverAbandonedJobs(database: Database): number {
  const now = new Date().toISOString();
  const rows = database
    .query<
      {
        job_id: string;
        progress_json: string;
        worker_pid: number | null;
        lease_expires_at: string | null;
      },
      []
    >(
      `SELECT job_id, progress_json, worker_pid, lease_expires_at
       FROM automation_jobs WHERE state = 'running'`,
    )
    .all()
    .filter(
      (row) =>
        (row.lease_expires_at !== null && row.lease_expires_at < now) ||
        (row.worker_pid !== null && !pidAlive(row.worker_pid)),
    );
  database.transaction(() => {
    for (const row of rows) {
      database
        .prepare(
          `UPDATE automation_jobs SET state = 'waiting', lease_owner = NULL,
           lease_expires_at = NULL, worker_pid = NULL, updated_at = ? WHERE job_id = ?`,
        )
        .run(now, row.job_id);
      appendJobEvent(
        database,
        row.job_id,
        "lease_expired",
        "waiting",
        parseObject(row.progress_json),
        "Worker lease expired; Job can resume",
        now,
      );
    }
  })();
  return rows.length;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function cancellationRequested(database: Database, jobId: string): boolean {
  return getJob(database, jobId).cancel_requested_at !== null;
}

function appendJobEvent(
  database: Database,
  jobId: string,
  type: string,
  state: string,
  progress: Record<string, unknown>,
  message: string | null,
  createdAt: string,
): void {
  database
    .prepare(
      `INSERT INTO automation_job_events(job_id, sequence, event_type, state,
       progress_json, message, created_at)
       VALUES (?, COALESCE((SELECT MAX(sequence) + 1 FROM automation_job_events WHERE job_id = ?), 1),
       ?, ?, ?, ?, ?)`,
    )
    .run(jobId, jobId, type, state, JSON.stringify(progress), redactMessage(message), createdAt);
}

function jobFromRow(row: Row): JobRecord {
  return {
    job_id: String(row.job_id),
    request_id: String(row.request_id),
    operation_id: row.operation_id === null ? null : String(row.operation_id),
    kind: String(row.kind) as JobKind,
    state: String(row.state) as JobState,
    input: parseObject(row.input_json),
    checkpoint: parseObject(row.checkpoint_json),
    progress: parseObject(row.progress_json),
    result: row.result_json === null ? null : parseObject(row.result_json),
    error: row.error_json === null ? null : parseObject(row.error_json),
    attempt: Number(row.attempt),
    max_attempts: Number(row.max_attempts),
    cancel_requested_at: row.cancel_requested_at === null ? null : String(row.cancel_requested_at),
    lease_owner: row.lease_owner === null ? null : String(row.lease_owner),
    lease_expires_at: row.lease_expires_at === null ? null : String(row.lease_expires_at),
    worker_pid: row.worker_pid === null ? null : Number(row.worker_pid),
    created_at: String(row.created_at),
    started_at: row.started_at === null ? null : String(row.started_at),
    updated_at: String(row.updated_at),
    finished_at: row.finished_at === null ? null : String(row.finished_at),
  };
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  const parsed: unknown = JSON.parse(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function redactMessage(value: string | null): string | null {
  if (!value) return value;
  return value
    .replace(/sk-[A-Za-z0-9_-]{8,}/gu, "[REDACTED]")
    .replace(/Bearer\s+[^\s]+/giu, "Bearer [REDACTED]");
}
