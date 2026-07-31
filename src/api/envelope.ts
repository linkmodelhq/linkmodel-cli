/**
 * Envelope parsing.
 *
 * Compatibility detail: create endpoints use msg,
 * while query endpoints use message. Normalize both to { code, data, message, requestId },
 * using msg ?? message.
 */

export class EnvelopeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeParseError';
  }
}

export interface Envelope<T = unknown> {
  /** Business code; 0 means success. Missing or invalid fields become undefined and are never treated as success by default. */
  code?: number;
  data: T;
  /** Normalized message field from msg ?? message. */
  message: string;
  requestId?: string;
}

export function parseEnvelope<T = unknown>(raw: unknown): Envelope<T> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new EnvelopeParseError(`Invalid envelope response: ${summarize(raw)}`);
  }
  const obj = raw as Record<string, unknown>;
  // Do not default missing code. The caller must strictly check code === 0 for success.
  // A missing code field must propagate and eventually be treated as invalid, not successful.
  const code = typeof obj.code === 'number' ? obj.code : undefined;
  const msgField = obj.msg ?? obj.message;
  const message = typeof msgField === 'string' ? msgField : '';
  const requestId =
    typeof obj.request_id === 'string'
      ? obj.request_id
      : typeof obj.requestId === 'string'
        ? obj.requestId
        : undefined;
  return { code, data: obj.data as T, message, requestId };
}

/** Append request_id to errors so support can investigate directly. */
export function withRequestId(message: string, requestId?: string): string {
  return requestId ? `${message} (request_id: ${requestId})` : message;
}

function summarize(raw: unknown): string {
  try {
    const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
    return s.length > 120 ? `${s.slice(0, 120)}…` : s;
  } catch {
    return String(raw);
  }
}
