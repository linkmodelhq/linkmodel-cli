import { confirm, password, select } from '@inquirer/prompts';

import { AuthError } from '../api/client.js';
import {
  writeApiKey,
  writeDefaultModel,
  type DefaultModelKey,
} from '../core/config.js';
import {
  GENERATED_IMAGE_MODEL_SCHEMA,
  GENERATED_VIDEO_MODEL_SCHEMA,
} from '../generated/model-schemas.js';
import { validateApiKey } from './auth.js';
import { errorMessage, EXIT, makeReporter, reportFailure, type CommandDeps } from './gen.js';

const EXIT_INTERRUPT = 130;

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
    const configFile = writeApiKey(apiKey.trim(), deps.homeDir);
    reporter.success(`API key verified and saved to ${configFile} (mode 0600)`);

    const configureDefaults = await confirm({
      message: 'Configure default models now?',
      default: true,
    });

    let imageModel: string | null = null;
    let videoModel: string | null = null;
    if (configureDefaults) {
      imageModel = await select({
        message: 'Default image model',
        default: GENERATED_IMAGE_MODEL_SCHEMA.defaultModel,
        choices: modelChoices(GENERATED_IMAGE_MODEL_SCHEMA.defaultModel, Object.keys(GENERATED_IMAGE_MODEL_SCHEMA.models)),
      });
      writeDefaultModel('default-image-model', imageModel, deps.homeDir);

      videoModel = await select({
        message: 'Default video model',
        default: GENERATED_VIDEO_MODEL_SCHEMA.defaultModel,
        choices: modelChoices(GENERATED_VIDEO_MODEL_SCHEMA.defaultModel, Object.keys(GENERATED_VIDEO_MODEL_SCHEMA.models)),
      });
      writeDefaultModel('default-video-model', videoModel, deps.homeDir);
      reporter.success(`Default models saved: image=${imageModel}, video=${videoModel}`);
    }

    reporter.info('');
    reporter.info('Next commands:');
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

export function isPromptExitError(err: unknown): boolean {
  return err instanceof Error && err.name === 'ExitPromptError';
}

function modelChoices(defaultModel: string, models: string[]) {
  return models.sort().map((model) => ({
    name: model === defaultModel ? `${model} (built-in default)` : model,
    value: model,
  }));
}
