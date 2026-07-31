import { parseEnvelope, withRequestId, type Envelope } from './envelope.js';
import { isTaskStatus, type CreateTaskData, type TaskStatusData } from './types.js';
import { PACKAGE_NAME, VERSION } from '../generated/version.js';

export const DEFAULT_BASE_URL = 'https://api.linkmodel.ai/api/v1';
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Retry up to 3 times after the initial request. */
export const DEFAULT_MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;
export const CLIENT_SOURCE = 'cli';

/** Known business codes that indicate authentication failure even with HTTP 200. */
const BUSINESS_AUTH_CODES: ReadonlySet<number> = new Set([401]);

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 401 authentication failure maps to exit code 3 and is never retried. */
export class AuthError extends ApiError {
  constructor(message: string, requestId?: string) {
    super(message, 401, requestId);
    this.name = 'AuthError';
  }
}

/** Network-layer errors, including per-request timeout, are retryable. */
export class NetworkError extends Error {
  constructor(
    url: string,
    readonly cause: unknown,
  ) {
    super(`Network error (${url}): ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'NetworkError';
  }
}

export interface LinkmodelClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Backoff sleep function; tests can inject a fake implementation. */
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  requestTimeoutMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function buildClientHeaders(apiKey: string, body?: unknown): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    'User-Agent': `${PACKAGE_NAME}/${VERSION}`,
    'X-LinkModel-Client': CLIENT_SOURCE,
    'X-LinkModel-Client-Version': VERSION,
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
  };
}

export class LinkmodelClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly requestTimeoutMs: number;

  constructor(options: LinkmodelClientOptions) {
    if (!options.apiKey) throw new Error('apiKey is required');
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /**
   * Create a task. Endpoint path and body come from ModalitySpec; the client is modality-agnostic.
   */
  createTask<TData = CreateTaskData>(path: string, body: unknown): Promise<Envelope<TData>> {
    return this.requestWithRetry(() => this.request('POST', path, body));
  }

  /**
   * Query task status. Status values are shared across modalities, so validation lives here.
   * Artifact field parsing is modality-specific and belongs to ModalitySpec.
   */
  async queryTask<TData extends TaskStatusData>(
    path: string,
    taskId: string,
  ): Promise<Envelope<TData>> {
    const env = await this.requestWithRetry(() =>
      this.request<TData>('GET', `${path}?task_id=${encodeURIComponent(taskId)}`),
    );
    // Do not silently downgrade: unknown task status throws with request_id.
    if (!isTaskStatus(env.data?.status)) {
      throw new ApiError(
        withRequestId(`Unknown task status: ${JSON.stringify(env.data?.status)}`, env.requestId),
        200,
        env.requestId,
      );
    }
    return env;
  }

  /**
   * Retry policy:
   * - Only 5xx and network errors use exponential backoff (500ms -> 1s -> 2s), up to 3 retries.
   * - 4xx and business errors (HTTP 200 with non-zero code) are never retried.
   */
  private async requestWithRetry<T>(fn: () => Promise<Envelope<T>>): Promise<Envelope<T>> {
    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        const retryable =
          err instanceof NetworkError || (err instanceof ApiError && err.status >= 500);
        if (!retryable || attempt >= this.maxRetries) throw err;
        await this.sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
        attempt++;
      }
    }
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<Envelope<T>> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    let text: string;
    // Request and body read must be inside the same try; AbortSignal still applies after response headers arrive.
    // Body read timeouts must be wrapped as NetworkError so retry logic can handle them.
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: buildClientHeaders(this.apiKey, body),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      text = await res.text();
    } catch (err) {
      throw new NetworkError(url, err);
    }

    let envelope: Envelope<T> | null = null;
    try {
      envelope = parseEnvelope<T>(JSON.parse(text));
    } catch {
      envelope = null;
    }

    if (res.ok) {
      if (!envelope) {
        throw new ApiError(
          `Invalid envelope response (HTTP ${res.status}): ${truncate(text)}`,
          res.status,
        );
      }
      // HTTP 200 does not mean success: non-zero or missing business code is treated as an error.
      // For example, insufficient balance may return HTTP 200 with code 500.
      if (envelope.code !== 0) throw businessError(envelope);
      return envelope;
    }

    const message = envelope?.message || `HTTP ${res.status}: ${truncate(text)}`;
    if (res.status === 401) {
      throw new AuthError(withRequestId(`Authentication failed: ${message}`, envelope?.requestId), envelope?.requestId);
    }
    throw new ApiError(withRequestId(message, envelope?.requestId), res.status, envelope?.requestId);
  }
}

function truncate(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** HTTP 200 with non-zero or missing business code is a business error; auth business codes map to AuthError. */
function businessError<T>(envelope: Envelope<T>): ApiError {
  // Combine the reason with the server message; even a message like success must not hide the real failure.
  const reason =
    envelope.code === undefined
      ? 'Response missing code field'
      : `Server returned error code ${envelope.code}`;
  const detail = envelope.message ? `${reason} (server message: ${envelope.message})` : reason;
  const message = withRequestId(detail, envelope.requestId);
  if (envelope.code !== undefined && BUSINESS_AUTH_CODES.has(envelope.code)) {
    return new AuthError(`Authentication failed: ${message}`, envelope.requestId);
  }
  // Use status 200 for business errors so they do not trigger transport retry logic.
  return new ApiError(message, 200, envelope.requestId);
}
