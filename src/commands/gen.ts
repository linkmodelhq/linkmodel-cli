import path from 'node:path';

import { AuthError, LinkmodelClient } from '../api/client.js';
import { withRequestId } from '../api/envelope.js';
import { isTerminalStatus, type CreateTaskData, type TaskStatusData } from '../api/types.js';
import { resolveApiKey, resolveDefaultModel, type KeySource } from '../core/config.js';
import { downloadArtifacts } from '../core/download.js';
import { createOpener, type OpenFiles } from '../core/open.js';
import {
  poll,
  PollTimeoutError,
  systemClock,
  type PollClock,
  type ScheduleSegment,
} from '../core/poller.js';
import { artifactNoun, type ModalitySpec } from '../modalities/spec.js';
import { createReporter, detectMode, type Reporter } from '../ui/reporter.js';

/** Exit code semantics. */
export const EXIT = {
  OK: 0,
  /** Task Failed/Cancelled, download failure, or other API/network error. */
  FAILED: 1,
  /** Usage error, including missing API key. */
  USAGE: 2,
  /** Authentication failure (401). */
  AUTH: 3,
  /** Polling timeout. */
  TIMEOUT: 4,
} as const;

/** Shared gen options for all modalities; modality-specific options are parsed by ModalitySpec. */
export interface SharedGenOptions {
  out: string;
  wait: boolean;
  download: boolean;
  json: boolean;
  timeout: string;
  apiKey?: string;
  /** Open artifacts with the system default app after successful download; ignored in --json mode. */
  open: boolean;
}

export interface WaitTaskOptions {
  taskId: string;
  timeoutMin: number;
  download: boolean;
  out: string;
  open: boolean;
  json?: boolean;
  apiKey?: string;
  statusHint?: string;
  skipSigintHandler?: boolean;
}

export interface CommandDeps {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  fetchImpl?: typeof fetch;
  clock?: PollClock;
  reporter?: Reporter;
  stdoutIsTTY?: boolean;
  /** Opener for --open; defaults to createOpener(), tests inject a fake implementation. */
  openFiles?: OpenFiles;
}

// ---------- Small shared helpers reused by status and config. ----------

/**
 * Artifact URLs are OSS-signed temporary links, observed with x-oss-expires=172800, about 48 hours.
 * When printing URLs, add a reminder on stderr only so script-friendly stdout stays clean.
 */
export const ARTIFACT_URL_EXPIRY_NOTE =
  'Note: these URLs are signed temporary links that expire in about 48 hours; download them soon.';

export function makeReporter(json: boolean | undefined, deps: CommandDeps): Reporter {
  return (
    deps.reporter ??
    createReporter({
      mode: detectMode({ json, isTTY: deps.stdoutIsTTY ?? process.stdout.isTTY ?? false }),
    })
  );
}

/** Print an error and return an exit code; JSON mode also emits one structured error line to stdout. */
export function reportFailure(
  reporter: Reporter,
  message: string,
  code: number,
  payload?: Record<string, unknown>,
): number {
  reporter.error(message);
  if (reporter.mode === 'json') reporter.emitJson({ ok: false, error: message, ...payload });
  return code;
}

export function exitCodeForError(err: unknown): number {
  return err instanceof AuthError ? EXIT.AUTH : EXIT.FAILED;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Resolve API key. When missing, print guidance and return an error code. */
export function requireApiKey(
  reporter: Reporter,
  options: { flag?: string; env: NodeJS.ProcessEnv; homeDir?: string },
): { key: string; source: KeySource } | { error: number } {
  let info;
  try {
    info = resolveApiKey(options);
  } catch (err) {
    return { error: reportFailure(reporter, errorMessage(err), EXIT.USAGE) };
  }
  if (!info) {
    const message = 'No API key found. Run: lkm auth login --api-key <key>';
    reporter.error(message);
    reporter.error('Alternatively run: lkm config set api-key <key>');
    reporter.error('You can also set LINKMODEL_API_KEY or pass --api-key.');
    if (reporter.mode === 'json') reporter.emitJson({ ok: false, error: message });
    return { error: EXIT.USAGE };
  }
  return info;
}

// ---------- gen ----------

/**
 * gen orchestration shared by all modalities: validate -> create -> poll -> download.
 * All modality differences come from the spec; this function must not branch by modality.
 */
export async function runGen(
  prompt: string,
  rawOpts: SharedGenOptions & Record<string, unknown>,
  spec: ModalitySpec,
  deps: CommandDeps = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const reporter = makeReporter(rawOpts.json, deps);

  // ---- Local validation (exit 2), so obvious invalid requests never reach the API. ----
  // timeout is a shared option validated here; prompt and option sets are modality-specific and validated by the spec.
  const rawForModel = { ...rawOpts };
  if (
    rawForModel.model === undefined
    && spec.defaultModelConfigKey
  ) {
    try {
      const configured = resolveDefaultModel(spec.defaultModelConfigKey, deps.homeDir);
      if (configured) rawForModel.model = configured;
    } catch (err) {
      return reportFailure(reporter, errorMessage(err), EXIT.FAILED);
    }
  }
  const genOpts = spec.parseGenOptions(rawForModel);
  const errors = spec.validateGen(prompt, genOpts);
  const timeoutMin = Number(rawOpts.timeout);
  if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) {
    errors.push(`--timeout must be a positive number of minutes (got "${rawOpts.timeout}")`);
  }
  // --open and --no-download are mutually exclusive because there are no local files to open.
  if (rawOpts.open && !rawOpts.download) {
    errors.push('--open cannot be used with --no-download (no downloaded files to open)');
  }
  if (errors.length > 0) {
    for (const message of errors) reporter.error(message);
    if (reporter.mode === 'json') {
      // JSON contract: error is always present and non-empty; multiple validation errors are joined into one human-readable string.
      // The errors array is an optional enhancement for scripts that need individual messages.
      reporter.emitJson({ ok: false, error: errors.join('; '), errors });
    }
    return EXIT.USAGE;
  }
  const timeoutMs = timeoutMin * 60_000;

  // ---- API Key ----
  const keyResult = requireApiKey(reporter, { flag: rawOpts.apiKey, env, homeDir: deps.homeDir });
  if ('error' in keyResult) return keyResult.error;

  const client = new LinkmodelClient({
    apiKey: keyResult.key,
    baseUrl: env.LINKMODEL_BASE_URL ?? undefined, // Undocumented test hook.
    fetchImpl: deps.fetchImpl,
  });

  // ---- Create task. ----
  reporter.spinnerStart('Creating task…');
  let created;
  try {
    created = await client.createTask<CreateTaskData>(
      spec.createPath,
      spec.buildCreateRequest(prompt, genOpts),
    );
  } catch (err) {
    return reportFailure(reporter, errorMessage(err), exitCodeForError(err));
  } finally {
    reporter.spinnerStop();
  }

  const taskId = created.data?.task_id;
  if (typeof taskId !== 'string' || !taskId) {
    return reportFailure(
      reporter,
      withRequestId('Create response missing task_id', created.requestId),
      EXIT.FAILED,
    );
  }
  const price = created.data?.price;
  // Create response price may be 0 when billing is settled after completion; show it only when greater than 0.
  const showPrice = typeof price === 'number' && price > 0;
  if (!rawOpts.wait) {
    reporter.success(`Task created${showPrice ? ` ($${price})` : ''}: ${taskId}`);
    if (reporter.mode === 'json') {
      reporter.emitJson({ ok: true, task_id: taskId, price: price ?? null, status: 'Pending' });
    } else {
      reporter.out(taskId);
    }
    return EXIT.OK;
  }

  const statusHint = `lkm ${spec.name} status ${taskId}`;
  const onSigint = () => {
    reporter.spinnerStop();
    reporter.error(`Task ${taskId} is still running on the server; check it with: ${statusHint}`);
    process.exit(130);
  };
  process.once('SIGINT', onSigint);
  try {
    reporter.success(`Task created${showPrice ? ` ($${price})` : ''}: ${taskId}`);
    return await waitForTaskAndMaybeDownload(client, spec, {
      taskId,
      timeoutMin,
      timeoutMs,
      download: rawOpts.download,
      out: rawOpts.out,
      open: rawOpts.open,
      json: rawOpts.json,
      statusHint,
      skipSigintHandler: true,
    }, deps);
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

interface InternalWaitTaskOptions extends WaitTaskOptions {
  timeoutMs: number;
}

export async function waitForTaskAndMaybeDownload(
  client: LinkmodelClient,
  spec: ModalitySpec,
  opts: InternalWaitTaskOptions,
  deps: CommandDeps = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const reporter = makeReporter(opts.json, deps);
  const statusHint = opts.statusHint ?? `lkm ${spec.name} status ${opts.taskId}`;

  const onSigint = () => {
    reporter.spinnerStop();
    reporter.error(`Task ${opts.taskId} is still running on the server; check it with: ${statusHint}`);
    process.exit(130);
  };
  if (!opts.skipSigintHandler) process.once('SIGINT', onSigint);

  try {
    reporter.spinnerStart('Generating…');
    let data: TaskStatusData;
    try {
      data = await poll<TaskStatusData>({
        clock: deps.clock ?? systemClock,
        timeoutMs: opts.timeoutMs,
        schedule: scheduleFromEnv(env),
        query: async () => (await client.queryTask<TaskStatusData>(spec.queryPath, opts.taskId)).data,
        isTerminal: (d) => isTerminalStatus(d.status),
        onProgress: (elapsed) =>
          reporter.spinnerUpdate(`Generating… ${Math.floor(elapsed / 1000)}s elapsed`),
      });
    } catch (err) {
      if (err instanceof PollTimeoutError) {
        return reportFailure(
          reporter,
          `Timed out after ${opts.timeoutMin} minutes. Task ${opts.taskId} is still running on the server; check it with: ${statusHint}`,
          EXIT.TIMEOUT,
          { task_id: opts.taskId },
        );
      }
      return reportFailure(
        reporter,
        `${errorMessage(err)}. The task may still be running on the server; check it with: ${statusHint}`,
        exitCodeForError(err),
        { task_id: opts.taskId },
      );
    } finally {
      reporter.spinnerStop();
    }

    return handleTerminalTask(client, spec, opts.taskId, data, {
      download: opts.download,
      out: opts.out,
      open: opts.open,
      json: opts.json,
    }, deps);
  } finally {
    if (!opts.skipSigintHandler) process.removeListener('SIGINT', onSigint);
  }
}

export async function handleTerminalTask(
  _client: LinkmodelClient,
  spec: ModalitySpec,
  taskId: string,
  data: TaskStatusData,
  opts: Pick<WaitTaskOptions, 'download' | 'out' | 'open' | 'json'>,
  deps: CommandDeps = {},
): Promise<number> {
  const reporter = makeReporter(opts.json, deps);
  if (data.status === 'Failed') {
    return reportFailure(
      reporter,
      `Task failed: ${data.msg?.trim() || '(no details from server)'}`,
      EXIT.FAILED,
      { task_id: taskId },
    );
  }
  if (data.status === 'Cancelled') {
    return reportFailure(reporter, `Task cancelled: ${taskId}`, EXIT.FAILED, { task_id: taskId });
  }
  const urls = spec.extractArtifactUrls(data);
  if (urls.length === 0) {
    return reportFailure(
      reporter,
      `Task ${taskId} succeeded but the server returned no ${spec.artifactNoun.plural}`,
      EXIT.FAILED,
      { task_id: taskId },
    );
  }

  if (!opts.download) {
    if (reporter.mode === 'json') {
      reporter.emitJson({ ok: true, task_id: taskId, status: 'Success', artifacts: urls });
    } else {
      for (const url of urls) reporter.out(url);
    }
    reporter.info(ARTIFACT_URL_EXPIRY_NOTE);
    return EXIT.OK;
  }

  reporter.spinnerStart(`Downloading ${urls.length} ${artifactNoun(spec, urls.length)}…`);
  const result = await downloadArtifacts({
    urls,
    outDir: opts.out,
    taskId,
    resolveExtension: spec.resolveExtension,
    fetchImpl: deps.fetchImpl,
  });
  reporter.spinnerStop();

  for (const f of result.failed) reporter.error(`Download failed: ${f.url} — ${f.error}`);
  if (reporter.mode !== 'json') {
    for (const s of result.saved) reporter.out(s.file);
  }
  if (result.failed.length > 0) {
    const summary = `${result.failed.length} of ${urls.length} ${spec.artifactNoun.plural} failed to download`;
    reporter.error(summary);
    if (reporter.mode === 'json') {
      reporter.emitJson({
        ok: false,
        task_id: taskId,
        error: summary,
        downloaded: result.saved.map((s) => s.file),
        failed: result.failed,
      });
    }
    return EXIT.FAILED;
  }
  reporter.success(
    `Saved ${result.saved.length} ${artifactNoun(spec, result.saved.length)} to ${path.resolve(opts.out)}`,
  );

  if (opts.open && reporter.mode !== 'json' && result.saved.length > 0) {
    const openFiles = deps.openFiles ?? createOpener();
    const outcome = await openFiles(result.saved.map((s) => s.file));
    for (const f of outcome.failed) {
      reporter.info(`Could not auto-open (${f.error}); file is at ${f.file}`);
    }
  }

  if (reporter.mode === 'json') {
    reporter.emitJson({
      ok: true,
      task_id: taskId,
      status: 'Success',
      downloaded: result.saved.map((s) => s.file),
    });
  }
  return EXIT.OK;
}

/** Test hook: JSON overrides the polling schedule so integration tests do not wait through the real 10-second quiet period. */
export function scheduleFromEnv(env: NodeJS.ProcessEnv): readonly ScheduleSegment[] | undefined {
  const raw = env.LINKMODEL_POLL_SCHEDULE;
  if (!raw) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('LINKMODEL_POLL_SCHEDULE must be a non-empty JSON array');
  }
  return parsed as ScheduleSegment[];
}
