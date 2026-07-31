import {
  configPath,
  maskApiKey,
  readConfigObject,
  resolveApiKey,
  writeApiKey,
  writeDefaultModel,
  type DefaultModelKey,
  type KeySource,
} from '../core/config.js';
import { errorMessage, EXIT, makeReporter, reportFailure, type CommandDeps } from './gen.js';

const SOURCE_LABEL: Record<KeySource, string> = {
  flag: '--api-key flag',
  env: 'LINKMODEL_API_KEY environment variable',
  config: 'config file',
};

export function runConfigSetApiKey(key: string, deps: CommandDeps = {}): number {
  const reporter = makeReporter(false, deps);
  if (!key?.trim()) return reportFailure(reporter, 'api-key must not be empty', EXIT.USAGE);
  try {
    const p = writeApiKey(key.trim(), deps.homeDir);
    reporter.success(`API key saved to ${p} (mode 0600)`);
    return EXIT.OK;
  } catch (err) {
    return reportFailure(reporter, errorMessage(err), EXIT.FAILED);
  }
}

export function runConfigSetDefaultModel(
  name: DefaultModelKey,
  model: string,
  deps: CommandDeps = {},
): number {
  const reporter = makeReporter(false, deps);
  if (!model?.trim()) return reportFailure(reporter, `${name} must not be empty`, EXIT.USAGE);
  try {
    const p = writeDefaultModel(name, model.trim(), deps.homeDir);
    reporter.success(`${name} saved to ${p} (mode 0600)`);
    return EXIT.OK;
  } catch (err) {
    return reportFailure(reporter, errorMessage(err), EXIT.FAILED);
  }
}

export interface ConfigGetOptions {
  /** Explicitly print the full key. Defaults to masked output to avoid leaking keys into scrollback, logs, or screenshots. */
  reveal?: boolean;
  json?: boolean;
}

export function runConfigGet(opts: ConfigGetOptions = {}, deps: CommandDeps = {}): number {
  const reporter = makeReporter(opts.json, deps);
  let info;
  try {
    info = resolveApiKey({ env: deps.env ?? process.env, homeDir: deps.homeDir });
  } catch (err) {
    return reportFailure(reporter, errorMessage(err), EXIT.FAILED);
  }
  if (!info) {
    reporter.info('No API key configured. Run: lkm config set api-key <key>');
    if (reporter.mode === 'json') {
      reporter.emitJson({ api_key: null, masked: true, source: null });
    }
    return EXIT.OK;
  }
  const reveal = opts.reveal ?? false;
  const shown = reveal ? info.key : maskApiKey(info.key);
  if (reporter.mode === 'json') {
    reporter.emitJson({ api_key: shown, masked: !reveal, source: info.source });
  } else {
    reporter.out(shown);
  }
  reporter.info(`Source: ${SOURCE_LABEL[info.source]}`);
  if (!reveal) reporter.info('Masked for safety; run with --reveal to print the full key.');
  return EXIT.OK;
}

export function runConfigGetDefaultModels(opts: { json?: boolean } = {}, deps: CommandDeps = {}): number {
  const reporter = makeReporter(opts.json, deps);
  let config: Record<string, unknown> | null;
  try {
    config = readConfigObject(deps.homeDir);
  } catch (err) {
    return reportFailure(reporter, errorMessage(err), EXIT.FAILED);
  }
  const image = typeof config?.default_image_model === 'string' ? config.default_image_model : null;
  const video = typeof config?.default_video_model === 'string' ? config.default_video_model : null;
  if (reporter.mode === 'json') {
    reporter.emitJson({ default_image_model: image, default_video_model: video });
  } else {
    reporter.out(`default-image-model: ${image ?? '(not set)'}`);
    reporter.out(`default-video-model: ${video ?? '(not set)'}`);
  }
  return EXIT.OK;
}

export function runConfigList(opts: ConfigGetOptions = {}, deps: CommandDeps = {}): number {
  const reporter = makeReporter(opts.json, deps);
  let config: Record<string, unknown> | null;
  try {
    config = readConfigObject(deps.homeDir);
  } catch (err) {
    return reportFailure(reporter, errorMessage(err), EXIT.FAILED);
  }
  const apiKey = typeof config?.api_key === 'string' && config.api_key.trim()
    ? (opts.reveal ? config.api_key.trim() : maskApiKey(config.api_key.trim()))
    : null;
  const image = typeof config?.default_image_model === 'string' ? config.default_image_model : null;
  const video = typeof config?.default_video_model === 'string' ? config.default_video_model : null;
  if (reporter.mode === 'json') {
    reporter.emitJson({
      api_key: apiKey,
      masked: !opts.reveal,
      default_image_model: image,
      default_video_model: video,
    });
  } else {
    reporter.out(`api-key: ${apiKey ?? '(not set)'}`);
    reporter.out(`default-image-model: ${image ?? '(not set)'}`);
    reporter.out(`default-video-model: ${video ?? '(not set)'}`);
  }
  return EXIT.OK;
}

export function runConfigGetValue(
  name: 'api-key' | DefaultModelKey,
  opts: ConfigGetOptions = {},
  deps: CommandDeps = {},
): number {
  if (name === 'api-key') return runConfigGet(opts, deps);
  const reporter = makeReporter(opts.json, deps);
  let config: Record<string, unknown> | null;
  try {
    config = readConfigObject(deps.homeDir);
  } catch (err) {
    return reportFailure(reporter, errorMessage(err), EXIT.FAILED);
  }
  const field = name === 'default-image-model' ? 'default_image_model' : 'default_video_model';
  const value = typeof config?.[field] === 'string' ? config[field] : null;
  if (reporter.mode === 'json') reporter.emitJson({ [field]: value });
  else reporter.out(value ?? '(not set)');
  return EXIT.OK;
}

export function runConfigPath(deps: CommandDeps = {}): number {
  const reporter = makeReporter(false, deps);
  reporter.out(configPath(deps.homeDir));
  return EXIT.OK;
}
