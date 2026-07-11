export type ErrorCategory = "usage" | "not_found" | "conflict" | "state" | "external" | "internal";

export type SelfError = {
  code: string;
  message: string;
  category: ErrorCategory;
  retryable: boolean;
  details?: Record<string, unknown>;
  suggestedActions?: string[];
};

export const EXIT_CODES: Record<ErrorCategory | "partial" | "locked" | "plan_required", number> = {
  usage: 2,
  not_found: 3,
  conflict: 4,
  state: 5,
  external: 6,
  partial: 7,
  locked: 8,
  plan_required: 10,
  internal: 20,
};

export class SelfFailure extends Error {
  readonly selfError: SelfError;
  readonly exitCode: number;

  constructor(selfError: SelfError, exitCode = EXIT_CODES[selfError.category]) {
    super(selfError.message);
    this.name = "SelfFailure";
    this.selfError = selfError;
    this.exitCode = exitCode;
  }
}

export function failure(
  code: string,
  message: string,
  category: ErrorCategory,
  options: {
    retryable?: boolean;
    details?: Record<string, unknown>;
    suggestedActions?: string[];
    exitCode?: number;
  } = {},
): SelfFailure {
  const selfError: SelfError = {
    code,
    message,
    category,
    retryable: options.retryable ?? false,
    ...(options.details ? { details: options.details } : {}),
    ...(options.suggestedActions ? { suggestedActions: options.suggestedActions } : {}),
  };
  return new SelfFailure(selfError, options.exitCode ?? EXIT_CODES[category]);
}
