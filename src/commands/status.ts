import { LinkmodelClient } from '../api/client.js';
import type { TaskStatusData } from '../api/types.js';
import { artifactNoun, type ModalitySpec } from '../modalities/spec.js';
import {
  ARTIFACT_URL_EXPIRY_NOTE,
  errorMessage,
  EXIT,
  exitCodeForError,
  handleTerminalTask,
  makeReporter,
  reportFailure,
  requireApiKey,
  waitForTaskAndMaybeDownload,
  type CommandDeps,
} from './gen.js';

export interface StatusCommandOptions {
  json: boolean;
  apiKey?: string;
  wait?: boolean;
  timeout?: string;
  download?: boolean;
  out?: string;
  open?: boolean;
}

export async function runStatus(
  taskId: string,
  opts: StatusCommandOptions,
  spec: ModalitySpec,
  deps: CommandDeps = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const reporter = makeReporter(opts.json, deps);

  if (!taskId.trim()) return reportFailure(reporter, 'task_id must not be empty', EXIT.USAGE);
  const timeoutMin = Number(opts.timeout ?? '15');
  if (opts.wait && (!Number.isFinite(timeoutMin) || timeoutMin <= 0)) {
    return reportFailure(
      reporter,
      `--timeout must be a positive number of minutes (got "${opts.timeout}")`,
      EXIT.USAGE,
    );
  }
  if (opts.open && opts.download === false) {
    return reportFailure(
      reporter,
      '--open cannot be used with --no-download (no downloaded files to open)',
      EXIT.USAGE,
    );
  }

  const keyResult = requireApiKey(reporter, { flag: opts.apiKey, env, homeDir: deps.homeDir });
  if ('error' in keyResult) return keyResult.error;

  const client = new LinkmodelClient({
    apiKey: keyResult.key,
    baseUrl: env.LINKMODEL_BASE_URL ?? undefined,
    fetchImpl: deps.fetchImpl,
  });

  if (opts.wait) {
    return waitForTaskAndMaybeDownload(client, spec, {
      taskId,
      timeoutMin,
      timeoutMs: timeoutMin * 60_000,
      download: opts.download ?? true,
      out: opts.out ?? '.',
      open: opts.open ?? false,
      json: opts.json,
      statusHint: `lkm ${spec.name} status ${taskId} --wait`,
    }, deps);
  }

  let data: TaskStatusData;
  try {
    data = (await client.queryTask<TaskStatusData>(spec.queryPath, taskId)).data;
  } catch (err) {
    return reportFailure(reporter, errorMessage(err), exitCodeForError(err), { task_id: taskId });
  }

  const urls = spec.extractArtifactUrls(data);
  // JSON mode emits exactly one line per call; errors always include a non-empty error field.
  const basePayload = () => ({
    task_id: taskId,
    status: data.status,
    artifacts: urls,
    ...(data.msg ? { msg: data.msg } : {}),
  });

  switch (data.status) {
    case 'Success': {
      reporter.success(
        `Task ${taskId}: Success (${urls.length} ${artifactNoun(spec, urls.length)})`,
      );
      if (reporter.mode === 'json') {
        reporter.emitJson({ ok: true, ...basePayload() });
      } else {
        for (const url of urls) reporter.out(url);
      }
      reporter.info(ARTIFACT_URL_EXPIRY_NOTE);
      return EXIT.OK;
    }
    case 'Failed': {
      const message = `Task ${taskId} failed: ${data.msg?.trim() || '(no details from server)'}`;
      reporter.error(message);
      if (reporter.mode === 'json') {
        reporter.emitJson({ ok: false, ...basePayload(), error: message });
      }
      return EXIT.FAILED;
    }
    case 'Cancelled': {
      const message = `Task ${taskId} was cancelled`;
      reporter.error(message);
      if (reporter.mode === 'json') {
        reporter.emitJson({ ok: false, ...basePayload(), error: message });
      }
      return EXIT.FAILED;
    }
    default:
      // Pending / Processing means the query succeeded but the task is not done, so this is not an error.
      reporter.info(`Task ${taskId}: ${data.status} (still running; check again later)`);
      if (reporter.mode === 'json') reporter.emitJson({ ok: true, ...basePayload() });
      return EXIT.OK;
  }
}
