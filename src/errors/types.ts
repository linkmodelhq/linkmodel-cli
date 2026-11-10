/**
 * RFC 9457 Problem Details and Exit Code contract for linkmodel-cli.
 * Domain value objects and types for error normalization.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc9457
 */

export enum ExitCode {
  SUCCESS = 0,
  GENERAL_ERROR = 1,
  VALIDATION = 2,
  AUTH_FAILURE = 3,
  RATE_LIMIT = 4,
  CONTENT_POLICY = 5,
  NETWORK_ERROR = 6,
  UNKNOWN_MODEL = 8,
  INCOMPATIBLE_PARAMS = 9,
  INSUFFICIENT_BALANCE = 37,
  SIGINT = 130,
}

export type CoreReason =
  | 'VALIDATION'
  | 'UNKNOWN_MODEL'
  | 'INCOMPATIBLE_PARAMS'
  | 'AUTH_INVALID'
  | 'INSUFFICIENT_BALANCE'
  | 'RATE_LIMITED'
  | 'CONTENT_POLICY'
  | 'NETWORK'
  | 'SERVER'
  | 'CREATE_OUTCOME_UNKNOWN'
  | 'OUTPUT_EXPIRED'
  | 'POLL_TIMEOUT'
  | 'ABORTED';

export type ChargedState = 'yes' | 'no' | 'maybe';

export interface ProblemDetails {
  /** RFC 9457 URI identifying problem type */
  type: string;
  /** Short, human-readable summary */
  title: string;
  /** HTTP status code or normalized equivalent */
  status: number;
  /** Human-readable explanation specific to this occurrence */
  detail: string;
  /** Normalized machine-readable category code */
  reason: CoreReason;
  /** Whether re-issuing the exact same request is safe and may succeed */
  retryable: boolean;
  /** Did this failure consume user credits? */
  charged: ChargedState;
  /** Recommended automated or user action: 'retry', 'fix_input', 'check_quota', 'reconcile', 'none' */
  next_action: string;
  /** Semantic process exit code */
  exitCode: ExitCode;
  /** Raw upstream wire envelope for transparency and debugging */
  upstream?: {
    code?: number;
    msg?: string;
    requestId?: string;
    status?: number;
    taskId?: string;
  };
}
