/**
 * Anti-Corruption Layer (ACL): Wire Normalizer
 * Translates upstream LinkModel API responses and network faults into RFC 9457 ProblemDetails.
 */

import { type ProblemDetails, type CoreReason, ExitCode, type ChargedState } from './types.js';

export interface WireContext {
  operation?: 'create' | 'query' | 'download' | 'auth' | 'quota';
  url?: string;
  taskId?: string;
  model?: string;
  upstreamStatus?: number;
}

export function normalizeError(
  err: unknown,
  context: WireContext = {},
): ProblemDetails {
  // If already normalized
  if (isProblemDetails(err)) {
    return err;
  }

  // Handle upstream envelope object directly or Error with properties
  const wireStatus = context.upstreamStatus ?? getStatusFromError(err);
  const envelope = extractEnvelope(err);
  const msg = envelope?.msg ?? envelope?.message ?? (err instanceof Error ? err.message : String(err));
  const rawCode = envelope?.code ?? (err as any)?.code;
  const code = rawCode !== undefined ? rawCode : extractCodeFromMessage(msg);
  const requestId = envelope?.request_id ?? envelope?.requestId ?? (err as any)?.requestId;

  // 1. Business Code: 100601 (Insufficient balance / Daily quota breached)
  if (code === 100601 || msg.includes('insufficient balance')) {
    return {
      type: 'https://api.linkmodel.ai/errors/insufficient-balance',
      title: 'Insufficient Balance or Quota Exceeded',
      status: 402,
      detail: msg || 'Account balance is insufficient or daily API key quota has been reached.',
      reason: 'INSUFFICIENT_BALANCE',
      retryable: false,
      charged: 'no',
      next_action: 'check_quota',
      exitCode: ExitCode.INSUFFICIENT_BALANCE,
      upstream: { code, msg, requestId, status: wireStatus },
    };
  }

  // 2. Business Code: 100300 (Validation / Parameter / Model constraint)
  if (code === 100300) {
    const isModelNotFound = /model.*(?:not found|invalid|unknown|unsupported)/i.test(msg);
    const isIncompatible = /resolution must be|aspect ratio|duration/i.test(msg);

    if (isModelNotFound) {
      return {
        type: 'https://api.linkmodel.ai/errors/unknown-model',
        title: 'Unknown or Unsupported Model',
        status: 400,
        detail: msg || `Model '${context.model ?? 'unknown'}' was not recognized by the upstream server.`,
        reason: 'UNKNOWN_MODEL',
        retryable: false,
        charged: 'no',
        next_action: 'fix_input',
        exitCode: ExitCode.UNKNOWN_MODEL,
        upstream: { code, msg, requestId, status: wireStatus },
      };
    }

    return {
      type: 'https://api.linkmodel.ai/errors/validation',
      title: 'Validation Error',
      status: 400,
      detail: msg || 'Upstream parameter validation failed.',
      reason: isIncompatible ? 'INCOMPATIBLE_PARAMS' : 'VALIDATION',
      retryable: false,
      charged: 'no',
      next_action: 'fix_input',
      exitCode: isIncompatible ? ExitCode.INCOMPATIBLE_PARAMS : ExitCode.VALIDATION,
      upstream: { code, msg, requestId, status: wireStatus },
    };
  }

  // 3. Authentication: 401 or business code 401
  if (wireStatus === 401 || code === 401 || /invalid api key|authentication failed/i.test(msg)) {
    return {
      type: 'https://api.linkmodel.ai/errors/unauthorized',
      title: 'Authentication Failed',
      status: 401,
      detail: msg || 'The API key provided is invalid, expired, or missing.',
      reason: 'AUTH_INVALID',
      retryable: false,
      charged: 'no',
      next_action: 'reauthenticate',
      exitCode: ExitCode.AUTH_FAILURE,
      upstream: { code: code ?? 401, msg, requestId, status: wireStatus },
    };
  }

  // 4. Rate Limiting: 429
  if (wireStatus === 429 || code === 429 || /rate limit/i.test(msg)) {
    return {
      type: 'https://api.linkmodel.ai/errors/rate-limited',
      title: 'Rate Limit Exceeded',
      status: 429,
      detail: msg || 'Too many requests were sent in a given time window.',
      reason: 'RATE_LIMITED',
      retryable: true,
      charged: 'no',
      next_action: 'retry_with_backoff',
      exitCode: ExitCode.RATE_LIMIT,
      upstream: { code: code ?? 429, msg, requestId, status: wireStatus },
    };
  }

  // 5. Content Moderation / Safety Filter
  if (/content policy|moderation|sensitive|nsfw|prohibited content/i.test(msg)) {
    return {
      type: 'https://api.linkmodel.ai/errors/content-policy',
      title: 'Content Policy Violation',
      status: 422,
      detail: msg || 'The request was rejected by upstream safety and content moderation systems.',
      reason: 'CONTENT_POLICY',
      retryable: false,
      charged: 'no',
      next_action: 'fix_input',
      exitCode: ExitCode.CONTENT_POLICY,
      upstream: { code, msg, requestId, status: wireStatus },
    };
  }

  // 6. Asset Expiration (403 on OSS download)
  if (context.operation === 'download' && (wireStatus === 403 || /403|accessdenied|expired/i.test(msg))) {
    return {
      type: 'https://api.linkmodel.ai/errors/output-expired',
      title: 'Generated Output Expired',
      status: 403,
      detail: `Generated asset is no longer available upstream (storage signature expired): ${msg}`,
      reason: 'OUTPUT_EXPIRED',
      retryable: false,
      charged: 'yes',
      next_action: 'regenerate',
      exitCode: ExitCode.GENERAL_ERROR,
      upstream: { code: code ?? 403, msg, requestId, status: wireStatus },
    };
  }

  // 7. Polling Timeout (evaluated before network faults to prevent PollTimeoutError misclassification)
  if (
    (err instanceof Error && err.name === 'PollTimeoutError') ||
    msg.includes('Timed out') ||
    msg.includes('Polling timed out')
  ) {
    return {
      type: 'https://api.linkmodel.ai/errors/timeout',
      title: 'Task Polling Timeout',
      status: 504,
      detail: msg,
      reason: 'POLL_TIMEOUT',
      retryable: true,
      charged: 'yes',
      next_action: 'check_status',
      exitCode: ExitCode.RATE_LIMIT, // Matches parity exit code 4 for timeout
      upstream: { taskId: context.taskId, msg },
    };
  }

  // 8. Network / Transport Faults
  if (isNetworkFault(err) || msg.includes('Network error') || msg.includes('fetch failed')) {
    const isCreate = context.operation === 'create';
    return {
      type: isCreate
        ? 'https://api.linkmodel.ai/errors/create-outcome-unknown'
        : 'https://api.linkmodel.ai/errors/network-error',
      title: isCreate ? 'Task Creation Outcome Unknown' : 'Network Communication Failure',
      status: 503,
      detail: isCreate
        ? `Network fault occurred during task submission (${msg}). The task may or may not have been created on the server.`
        : `Network connection failed during ${context.operation ?? 'request'}: ${msg}`,
      reason: isCreate ? 'CREATE_OUTCOME_UNKNOWN' : 'NETWORK',
      retryable: !isCreate,
      charged: isCreate ? 'maybe' : 'no',
      next_action: isCreate ? 'reconcile' : 'retry',
      exitCode: ExitCode.NETWORK_ERROR,
      upstream: { msg, status: wireStatus },
    };
  }

  // 9. Generic Server Error Fallback
  const status = wireStatus >= 400 && wireStatus <= 599 ? wireStatus : 500;
  return {
    type: 'https://api.linkmodel.ai/errors/internal-server-error',
    title: 'Upstream Server Error',
    status,
    detail: msg || 'An unexpected upstream server error occurred.',
    reason: 'SERVER',
    retryable: status >= 500 && context.operation !== 'create',
    charged: context.operation === 'create' ? 'maybe' : 'no',
    next_action: status >= 500 ? 'retry' : 'none',
    exitCode: ExitCode.GENERAL_ERROR,
    upstream: { code, msg, requestId, status: wireStatus },
  };
}

function isProblemDetails(val: unknown): val is ProblemDetails {
  return typeof val === 'object' && val !== null && 'reason' in val && 'exitCode' in val && 'charged' in val;
}

function getStatusFromError(err: unknown): number {
  if (typeof err === 'object' && err !== null && 'status' in err && typeof (err as any).status === 'number') {
    return (err as any).status;
  }
  return 0;
}

function extractEnvelope(err: unknown): any {
  if (typeof err === 'object' && err !== null) {
    if ('envelope' in err) return (err as any).envelope;
    if ('body' in err && typeof (err as any).body === 'object') return (err as any).body;
  }
  return null;
}

function isNetworkFault(err: unknown): boolean {
  if (err instanceof Error) {
    const name = err.name.toLowerCase();
    const message = err.message.toLowerCase();
    return (
      name.includes('network') ||
      name.includes('timeout') ||
      name.includes('abort') ||
      message.includes('fetch failed') ||
      message.includes('econnrefused') ||
      message.includes('enotfound')
    );
  }
  return false;
}

function extractCodeFromMessage(msg: string): number | undefined {
  const match = msg.match(/error code\s+(\d+)/i) || msg.match(/"code":\s*(\d+)/i);
  return match ? parseInt(match[1], 10) : undefined;
}
