import type { SelfError } from "../../shared/errors/self-error.ts";

export type EnvelopeMeta = {
  request_id: string;
  operation_id: string | null;
  root: string | null;
  warnings: string[];
  next_actions: string[];
};

export type Envelope<T> = {
  ok: boolean;
  data: T | null;
  meta: EnvelopeMeta;
  error: SelfError | null;
};

export function successEnvelope<T>(
  data: T,
  requestId: string,
  options: {
    root?: string;
    operationId?: string;
    warnings?: string[];
    nextActions?: string[];
  } = {},
): Envelope<T> {
  return {
    ok: true,
    data,
    meta: {
      request_id: requestId,
      operation_id: options.operationId ?? null,
      root: options.root ?? null,
      warnings: options.warnings ?? [],
      next_actions: options.nextActions ?? [],
    },
    error: null,
  };
}

export function failureEnvelope(
  error: SelfError,
  requestId: string,
  root: string | null,
): Envelope<never> {
  return {
    ok: false,
    data: null,
    meta: {
      request_id: requestId,
      operation_id: null,
      root,
      warnings: [],
      next_actions: error.suggestedActions ?? [],
    },
    error,
  };
}
