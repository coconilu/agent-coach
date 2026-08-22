export type CoachErrorCode =
  | "UNAUTHORIZED"
  | "CSRF_REJECTED"
  | "TURN_NOT_FOUND"
  | "INVALID_STATE"
  | "IDEMPOTENCY_CONFLICT"
  | "PACKET_STALE"
  | "TICKET_INVALID"
  | "TICKET_REDEEMED"
  | "EPOCH_STALE"
  | "ACTION_REQUIRES_COACHING"
  | "PROVIDER_UNAVAILABLE"
  | "PROVENANCE_INVALID"
  | "REVISION_CONFLICT"
  | "UNSUPPORTED_HOST_VERSION"
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "CONFLICT";

const HTTP_STATUS: Record<CoachErrorCode, number> = {
  UNAUTHORIZED: 401,
  CSRF_REJECTED: 403,
  TURN_NOT_FOUND: 404,
  INVALID_STATE: 409,
  IDEMPOTENCY_CONFLICT: 409,
  PACKET_STALE: 409,
  TICKET_INVALID: 409,
  TICKET_REDEEMED: 409,
  EPOCH_STALE: 409,
  ACTION_REQUIRES_COACHING: 409,
  PROVIDER_UNAVAILABLE: 503,
  PROVENANCE_INVALID: 422,
  REVISION_CONFLICT: 409,
  UNSUPPORTED_HOST_VERSION: 422,
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
};

export class CoachError extends Error {
  readonly code: CoachErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: CoachErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CoachError";
    this.code = code;
    this.status = HTTP_STATUS[code];
    this.details = details;
  }
}

export function asCoachError(error: unknown): CoachError {
  if (error instanceof CoachError) return error;
  if (error instanceof Error) {
    return new CoachError("VALIDATION_ERROR", error.message);
  }
  return new CoachError("VALIDATION_ERROR", "Unknown error");
}

export function publicError(error: unknown): {
  error: { code: CoachErrorCode; message: string; details?: Record<string, unknown> };
} {
  const safe = asCoachError(error);
  return {
    error: {
      code: safe.code,
      message: safe.message,
      ...(safe.details ? { details: safe.details } : {}),
    },
  };
}
