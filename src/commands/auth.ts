import { AuthError, buildClientHeaders, DEFAULT_BASE_URL } from '../api/client.js';
import { parseEnvelope } from '../api/envelope.js';
import {
  ENV_API_KEY,
  maskApiKey,
  removeApiKey,
  resolveApiKey,
  writeApiKey,
  type KeySource,
} from '../core/config.js';
import { errorMessage, EXIT, makeReporter, reportFailure, type CommandDeps } from './gen.js';

const SOURCE_LABEL: Record<KeySource, string> = {
  flag: '--api-key flag',
  env: `${ENV_API_KEY} environment variable`,
  config: 'config file',
};

export interface AuthLoginOptions {
  apiKey?: string;
  json?: boolean;
}

export interface AuthStatusOptions {
  json?: boolean;
  reveal?: boolean;
  apiKey?: string;
}

export interface AuthLogoutOptions {
  json?: boolean;
}

export async function runAuthLogin(
  opts: AuthLoginOptions,
  deps: CommandDeps = {},
): Promise<number> {
  const reporter = makeReporter(opts.json, deps);
  const apiKey = opts.apiKey?.trim();
  if (!apiKey) return reportFailure(reporter, '--api-key must not be empty', EXIT.USAGE);

  try {
    await validateApiKey(apiKey, deps);
    const p = writeApiKey(apiKey, deps.homeDir);
    if (reporter.mode === 'json') {
      reporter.emitJson({ ok: true, api_key: maskApiKey(apiKey), masked: true, path: p });
    } else {
      reporter.success(`API key verified and saved to ${p} (mode 0600)`);
      reporter.info(`Masked key: ${maskApiKey(apiKey)}`);
    }
    return EXIT.OK;
  } catch (err) {
    const code = err instanceof AuthError ? EXIT.AUTH : EXIT.FAILED;
    return reportFailure(reporter, errorMessage(err), code);
  }
}

export function runAuthStatus(
  opts: AuthStatusOptions = {},
  deps: CommandDeps = {},
): number {
  const reporter = makeReporter(opts.json, deps);
  let info;
  try {
    info = resolveApiKey({ flag: opts.apiKey, env: deps.env ?? process.env, homeDir: deps.homeDir });
  } catch (err) {
    return reportFailure(reporter, errorMessage(err), EXIT.FAILED);
  }

  if (!info) {
    if (reporter.mode === 'json') {
      reporter.emitJson({ ok: true, configured: false, api_key: null, masked: true, source: null });
    } else {
      reporter.info('No API key configured. Run: lkm auth login --api-key <key>');
    }
    return EXIT.OK;
  }

  const reveal = opts.reveal ?? false;
  const shown = reveal ? info.key : maskApiKey(info.key);
  if (reporter.mode === 'json') {
    reporter.emitJson({
      ok: true,
      configured: true,
      api_key: shown,
      masked: !reveal,
      source: info.source,
    });
  } else {
    reporter.out(shown);
    reporter.info(`Source: ${SOURCE_LABEL[info.source]}`);
    if (!reveal) reporter.info('Masked for safety; run with --reveal to print the full key.');
  }
  return EXIT.OK;
}

export function runAuthLogout(opts: AuthLogoutOptions = {}, deps: CommandDeps = {}): number {
  const reporter = makeReporter(opts.json, deps);
  try {
    const p = removeApiKey(deps.homeDir);
    if (reporter.mode === 'json') reporter.emitJson({ ok: true, path: p });
    else reporter.success(`API key removed from ${p}`);
    return EXIT.OK;
  } catch (err) {
    return reportFailure(reporter, errorMessage(err), EXIT.FAILED);
  }
}

export async function validateApiKey(apiKey: string, deps: CommandDeps): Promise<void> {
  const env = deps.env ?? process.env;
  const baseUrl = (env.LINKMODEL_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const url = `${baseUrl}/query/image-generation?task_id=__linkmodel_cli_auth_check__`;
  let res: Response;
  let text: string;
  try {
    res = await (deps.fetchImpl ?? fetch)(url, {
      method: 'GET',
      headers: buildClientHeaders(apiKey),
      signal: AbortSignal.timeout(30_000),
    });
    text = await res.text();
  } catch (err) {
    throw new Error(`Could not verify API key: ${err instanceof Error ? err.message : String(err)}`);
  }

  let code: number | undefined;
  let message = text;
  let requestId: string | undefined;
  try {
    const envelope = parseEnvelope<unknown>(JSON.parse(text));
    code = envelope.code;
    message = envelope.message || message;
    requestId = envelope.requestId;
  } catch {
    // Some proxies may return plain error bodies. Fall back to HTTP status.
  }

  if (res.status === 401 || code === 401) {
    throw new AuthError(`Authentication failed: ${message}`, requestId);
  }
  if (res.status >= 500) {
    throw new Error(`Could not verify API key (HTTP ${res.status}): ${message}`);
  }
}
