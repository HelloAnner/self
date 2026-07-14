export const JOB_STATES = [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
] as const;

export type JobState = (typeof JOB_STATES)[number];

export type JobKind =
  | "backup.create"
  | "verify.deep"
  | "graph.build"
  | "vector-space.build"
  | "topic.build"
  | "topic.refresh";

export type JobRecord = {
  job_id: string;
  request_id: string;
  operation_id: string | null;
  kind: JobKind;
  state: JobState;
  input: Record<string, unknown>;
  checkpoint: Record<string, unknown>;
  progress: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  attempt: number;
  max_attempts: number;
  cancel_requested_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  worker_pid: number | null;
  created_at: string;
  started_at: string | null;
  updated_at: string;
  finished_at: string | null;
};
