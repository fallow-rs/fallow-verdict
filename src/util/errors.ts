/**
 * Stable error codes. This list is an add-only public contract: codes appear in
 * run records, JSON output, and exit handling.
 */
export const ERROR_CODES = [
  "config_invalid",
  "config_not_found",
  "fallow_not_found",
  "fallow_failed",
  "fallow_output_invalid",
  "fallow_schema_unsupported",
  "state_locked",
  "state_corrupt",
  "source_unreadable",
  "engine_auth_failed",
  "engine_rejected",
  "engine_rate_limited",
  "engine_unavailable",
  "engine_timeout",
  "engine_response_invalid",
  "engine_circuit_open",
  "budget_exhausted",
  "interrupted",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type VerdictError = {
  code: ErrorCode;
  message: string;
  /** Actionable next step for the person reading the error. */
  hint?: string;
};

export const verdictError = (code: ErrorCode, message: string, hint?: string): VerdictError =>
  hint === undefined ? { code, message } : { code, message, hint };

export const EXIT = {
  ok: 0,
  findings: 1,
  error: 2,
  interrupted: 130,
} as const;
