export type ProfexorErrorCode =
  | "CONFIG_INVALID"
  | "COMMAND_FAILED"
  | "LOCKED"
  | "PROJECT_INVALID"
  | "RUN_INVALID"
  | "DIRTY_WORKTREE"
  | "STALE_RUN"
  | "VALIDATION_FAILED"
  | "PROMOTION_REJECTED"
  | "ADVISOR_INVALID"
  | "SECURITY_POLICY";

export class ProfexorError extends Error {
  readonly code: ProfexorErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: ProfexorErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "ProfexorError";
    this.code = code;
    this.details = details;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function isProfexorError(error: unknown): error is ProfexorError {
  return error instanceof ProfexorError;
}
