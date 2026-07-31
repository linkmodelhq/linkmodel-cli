import { confirm, password, select } from '@inquirer/prompts';

import { AuthError } from '../api/client.js';
import {
  configPath,
  maskApiKey,
  resolveApiKey,
  resolveDefaultModel,
  writeApiKey,
  writeDefaultModel,
} from '../core/config.js';
import {
  GENERATED_IMAGE_MODEL_SCHEMA,
  GENERATED_VIDEO_MODEL_SCHEMA,
} from '../generated/model-schemas.js';
import { validateApiKey } from './auth.js';
import { errorMessage, EXIT, makeReporter, reportFailure, type CommandDeps } from './gen.js';

const EXIT_INTERRUPT = 130;
type SetupTarget = 'all' | 'api-key' | 'models';

export interface SetupOptions {
  json?: boolean;
}

export async function runSetup(
  opts: SetupOptions = {},
  deps: CommandDeps = {},
): Promise<number> {
  const reporter = makeReporter(opts.json, deps);
  const isTTY = deps.stdoutIsTTY ?? process.stdout.isTTY ?? false;

  if (reporter.mode === 'json' || !isTTY) {
    return reportFailure(
      reporter,
      'Interactive setup requires a TTY. Use lkm auth login --api-key <key> and lkm config set instead.',
      EXIT.USAGE,
    );
  }

  try {
    reporter.info('LinkModel CLI setup');
    reporter.info('Press Ctrl-C at any time to cancel.');
    reporter.info('');
    printCurrentStatus(reporter, deps);
    reporter.info('');

    const target = await select<SetupTarget>({
      message: 'What would you like to configure?',
      choices: [
        { name: 'API key and default models', value: 'all' },
        { name: 'API key only', value: 'api-key' },
        { name: 'Default models only', value: 'models' },
      ],
    });

    let savedApiKey = false;
    let configFile: string | null = null;
    if (target === 'all' || target === 'api-key') {
      const apiKey = await password({
        message: 'LinkModel API key',
        mask: '*',
        validate: (value) => value.trim().length > 0 || 'API key must not be empty',
      });

      reporter.spinnerStart('Verifying API key...');
      try {
        await validateApiKey(apiKey.trim(), deps);
      } finally {
        reporter.spinnerStop();
      }
      reporter.success('API key verified.');

      const shouldSave = await confirm({
        message: `Save API key to ${configPath(deps.homeDir)}?`,
        default: true,
      });
      if (shouldSave) {
        configFile = writeApiKey(apiKey.trim(), deps.homeDir);
        savedApiKey = true;
        reporter.success(`API key saved to ${configFile} (mode 0600)`);
      } else {
        reporter.info('API key was not saved.');
      }
    }

    let imageModel = currentDefaultModel('default-image-model', deps);
    let videoModel = currentDefaultModel('default-video-model', deps);
    if (target === 'all' || target === 'models') {
      imageModel = await select({
        message: 'Default image model',
        default: imageModel ?? GENERATED_IMAGE_MODEL_SCHEMA.defaultModel,
        choices: modelChoices(GENERATED_IMAGE_MODEL_SCHEMA.defaultModel, Object.keys(GENERATED_IMAGE_MODEL_SCHEMA.models)),
      });
      writeDefaultModel('default-image-model', imageModel, deps.homeDir);

      videoModel = await select({
        message: 'Default video model',
        default: videoModel ?? GENERATED_VIDEO_MODEL_SCHEMA.defaultModel,
        choices: modelChoices(GENERATED_VIDEO_MODEL_SCHEMA.defaultModel, Object.keys(GENERATED_VIDEO_MODEL_SCHEMA.models)),
      });
      writeDefaultModel('default-video-model', videoModel, deps.homeDir);
      configFile ??= configPath(deps.homeDir);
      reporter.success('Default models saved.');
    }

    reporter.info('');
    reporter.success('Setup complete.');
    reporter.info('');
    reporter.info('Saved:');
    reporter.info(`  API key: ${savedApiKey ? configFile : target === 'models' ? 'unchanged' : 'not saved'}`);
    reporter.info(`  Image default: ${imageModel ?? `${GENERATED_IMAGE_MODEL_SCHEMA.defaultModel} (built-in)`}`);
    reporter.info(`  Video default: ${videoModel ?? `${GENERATED_VIDEO_MODEL_SCHEMA.defaultModel} (built-in)`}`);
    reporter.info('');
    reporter.info('Try:');
    reporter.info('  lkm image "a red panda"');
    reporter.info('  lkm video "Empty cinematic establishing shot of a misty city street after rain"');
    reporter.info('  lkm models list');

    return EXIT.OK;
  } catch (err) {
    if (isPromptExitError(err)) {
      reporter.spinnerStop();
      reporter.info('Setup cancelled.');
      return EXIT_INTERRUPT;
    }
    const code = err instanceof AuthError ? EXIT.AUTH : EXIT.FAILED;
    return reportFailure(reporter, errorMessage(err), code);
  }
}

function printCurrentStatus(reporter: ReturnType<typeof makeReporter>, deps: CommandDeps): void {
  let keyLabel = '(not configured)';
  try {
    const key = resolveApiKey({ env: deps.env ?? process.env, homeDir: deps.homeDir });
    if (key) keyLabel = `${maskApiKey(key.key)} (${key.source})`;
  } catch (err) {
    keyLabel = `config error: ${errorMessage(err)}`;
  }

  reporter.info('Current configuration:');
  reporter.info(`  API key: ${keyLabel}`);
  reporter.info(`  Image default: ${currentDefaultModel('default-image-model', deps) ?? `${GENERATED_IMAGE_MODEL_SCHEMA.defaultModel} (built-in)`}`);
  reporter.info(`  Video default: ${currentDefaultModel('default-video-model', deps) ?? `${GENERATED_VIDEO_MODEL_SCHEMA.defaultModel} (built-in)`}`);
  reporter.info(`  Config path: ${configPath(deps.homeDir)}`);
}

function currentDefaultModel(key: 'default-image-model' | 'default-video-model', deps: CommandDeps): string | null {
  try {
    return resolveDefaultModel(key, deps.homeDir);
  } catch {
    return null;
  }
}

export function isPromptExitError(err: unknown): boolean {
  return err instanceof Error && err.name === 'ExitPromptError';
}

function modelChoices(defaultModel: string, models: string[]) {
  return models.sort().map((model) => ({
    name: model === defaultModel ? `${model} (built-in default)` : model,
    value: model,
  }));
}
