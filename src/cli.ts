#!/usr/bin/env node
/**
 * Commander entrypoint: registers modality command groups and maps errors to exit codes.
 *
 *   lkm image "<prompt>"             Generate an image (gen may be omitted)
 *   lkm image gen <prompt>            Generate an image: create task, poll, download
 *   lkm image status <task_id>        Query one task
 *   lkm config set api-key <key> / get / path
 *
 * Exit codes: 0 success / 1 task or download failure / 2 usage error / 3 authentication failure / 4 polling timeout
 */

import { Command, CommanderError } from 'commander';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  runAuthLogin,
  runAuthLogout,
  runAuthStatus,
} from './commands/auth.js';
import {
  runConfigGet,
  runConfigGetDefaultModels,
  runConfigGetValue,
  runConfigList,
  runConfigPath,
  runConfigSetApiKey,
  runConfigSetDefaultModel,
} from './commands/config.js';
import { EXIT, runGen, type SharedGenOptions } from './commands/gen.js';
import { runModelsList, runModelsShow } from './commands/models.js';
import { runSetup } from './commands/setup.js';
import { runStatus, type StatusCommandOptions } from './commands/status.js';
import { imageModality } from './modalities/image.js';
import type { ModalitySpec } from './modalities/spec.js';
import { videoModality } from './modalities/video.js';
import { resolveDefaultModel, type DefaultModelKey } from './core/config.js';
import { checkForUpdate } from './core/update.js';
import { PACKAGE_NAME, VERSION } from './generated/version.js';

/**
 * Registered modalities. To add a new modality, implement ModalitySpec and add it to this array.
 * The rest of this file and the shared layers should not need changes.
 */
const MODALITIES: ModalitySpec[] = [imageModality, videoModality];

const MODALITY_NAMES = new Set(MODALITIES.map((m) => m.name));
const GROUP_SUBCOMMANDS = new Set(['gen', 'status', 'help']);

/**
 * Implicit gen within a modality group:lkm image "a red panda" -q low ≡ lkm image gen "a red panda" -q low。
 *
 * Scope is limited to the modality group: when the first positional argument is not a known subcommand (gen/status/help)
 * and does not start with -, treat it as the gen prompt and insert gen.
 * There is deliberately no top-level default modality. lkm "prompt" does not run any modality.
 * This keeps image and video symmetric and avoids silently generating the wrong modality.
 *
 * Known tradeoff: prompts equal to gen/status/help require the explicit form, e.g. lkm image gen "status".
 */
export function withImplicitGen(argv: string[]): string[] {
  const modality = argv[2];
  if (modality === undefined || modality.startsWith('-') || !MODALITY_NAMES.has(modality)) {
    return argv;
  }
  const sub = argv[3];
  if (sub === undefined || sub.startsWith('-') || GROUP_SUBCOMMANDS.has(sub)) {
    return argv;
  }
  return [...argv.slice(0, 3), 'gen', ...argv.slice(3)];
}

function modelFromArgv(argv: string[], modality: string): string | undefined {
  const modalityIndex = argv.indexOf(modality);
  if (modalityIndex < 0) return undefined;
  for (let i = modalityIndex + 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') break;
    if (arg === '--model' || arg === '-m') return argv[i + 1];
    if (arg.startsWith('--model=')) return arg.slice('--model='.length);
    if (arg.startsWith('-m') && arg.length > 2) return arg.slice(2);
  }
  return undefined;
}

function configuredModelForSpec(spec: ModalitySpec): string | undefined {
  const key = spec.defaultModelConfigKey;
  if (!key) return undefined;
  try {
    return resolveDefaultModel(key) ?? undefined;
  } catch {
    return undefined;
  }
}

export async function run(argv: string[]): Promise<number> {
  let exitCode = 0;
  const effectiveArgv = withImplicitGen(argv);
  const shouldUpdateCheck = shouldCheckForUpdate(effectiveArgv);

  const program = new Command();
  program
    .name('lkm')
    .description('Command-line client for the linkmodel API')
    .version(VERSION)
    .exitOverride();

  for (const spec of MODALITIES) {
    const group = program.command(spec.name).description(spec.description);
    // Missing subcommand, such as lkm image: print group help instead of sending an empty prompt.
    group.action(() => {
      group.outputHelp();
    });

    const gen = group
      .command('gen')
      .description(spec.genDescription)
      .argument('<prompt>', 'prompt text')
      // Shared options are identical for every modality.
      .option('-o, --out <dir>', 'download directory', '.')
      .option('--no-wait', 'create the task, print task_id, and exit')
      .option('--no-download', 'poll to completion, print URLs without downloading')
      .option(
        '--open',
        `after download, open every ${spec.artifactNoun.singular} with the system default app (no-op with --json)`,
      )
      .option('--json', 'output a single-line JSON for scripts')
      .option('--timeout <min>', 'polling timeout in minutes', '15')
      .option('--api-key <key>', 'override the API key');
    // Modality-specific options come from the spec. With many models, register options only for the selected model.
    const selectedModel = modelFromArgv(effectiveArgv, spec.name) ?? configuredModelForSpec(spec);
    const genOptions =
      spec.genOptionsForModel ? spec.genOptionsForModel(selectedModel ?? '') : spec.genOptions;
    for (const opt of genOptions) gen.addOption(opt);
    gen.action(async (prompt: string, opts: Record<string, unknown>) => {
      exitCode = await runGen(
        prompt,
        opts as SharedGenOptions & Record<string, unknown>,
        spec,
      );
    });

    group
      .command('status')
      .description('Query the status of a single task')
      .argument('<task_id>', 'task ID')
      .option('--json', 'output a single-line JSON')
      .option('--api-key <key>', 'override the API key')
      .option('--wait', 'poll until the task reaches a terminal status')
      .option('--timeout <min>', 'polling timeout in minutes (with --wait)', '15')
      .option('--no-download', 'with --wait, print URLs without downloading')
      .option('-o, --out <dir>', 'download directory (with --wait)', '.')
      .option(
        '--open',
        `with --wait, after download, open every ${spec.artifactNoun.singular} with the system default app`,
      )
      .action(async (taskId: string, opts: StatusCommandOptions) => {
        exitCode = await runStatus(taskId, opts, spec);
      });
  }

  const auth = program.command('auth').description('Manage API key authentication');
  auth
    .command('login')
    .description('Verify and save an API key')
    .requiredOption('--api-key <key>', 'LinkModel API key')
    .option('--json', 'output a single-line JSON')
    .action(async (opts: { apiKey?: string; json?: boolean }) => {
      exitCode = await runAuthLogin(opts);
    });
  auth
    .command('status')
    .description('Show current API key status')
    .option('--api-key <key>', 'check this API key for the current command only')
    .option('--reveal', 'print the full, unmasked API key')
    .option('--json', 'output a single-line JSON')
    .action((opts: { apiKey?: string; reveal?: boolean; json?: boolean }) => {
      exitCode = runAuthStatus(opts);
    });
  auth
    .command('logout')
    .description('Remove the saved API key while keeping other config')
    .option('--json', 'output a single-line JSON')
    .action((opts: { json?: boolean }) => {
      exitCode = runAuthLogout(opts);
    });

  const models = program.command('models').description('Inspect built-in model schemas');
  models
    .command('list')
    .description('List built-in image/video models')
    .option('--modality <modality>', 'filter by modality: image or video')
    .option('--json', 'output a single-line JSON')
    .action((opts: { modality?: string; json?: boolean }) => {
      exitCode = runModelsList(opts);
    });
  models
    .command('show')
    .description('Show generated options for a model')
    .argument('<model>', 'model name')
    .option('--json', 'output a single-line JSON')
    .action((model: string, opts: { json?: boolean }) => {
      exitCode = runModelsShow(model, opts);
    });

  program
    .command('setup')
    .description('Run interactive first-time setup')
    .option('--json', 'fail with a structured message because setup is interactive')
    .action(async (opts: { json?: boolean }) => {
      exitCode = await runSetup(opts);
    });

  const config = program.command('config').description('Manage configuration');
  config
    .command('set')
    .description('Set a config value')
    .argument('<name>', "config name ('api-key', 'default-image-model', or 'default-video-model')")
    .argument('<value>', 'config value')
    .action((name: string, value: string) => {
      if (name === 'api-key') {
        exitCode = runConfigSetApiKey(value);
        return;
      }
      if (name === 'default-image-model' || name === 'default-video-model') {
        exitCode = runConfigSetDefaultModel(name as DefaultModelKey, value);
        return;
      }
      {
        console.error(`Unknown config key: ${name} (supported: api-key, default-image-model, default-video-model)`);
        exitCode = EXIT.USAGE;
        return;
      }
    });
  config
    .command('get')
    .description('Show a config value; no name keeps the legacy api-key view')
    .argument('[name]', 'config name: api-key, default-image-model, or default-video-model')
    .option('--reveal', 'print the full, unmasked API key')
    .option('--json', 'output a single-line JSON')
    .action((name: string | undefined, opts: { reveal?: boolean; json?: boolean }) => {
      if (name === undefined) {
        exitCode = runConfigGet(opts);
        return;
      }
      if (name === 'api-key' || name === 'default-image-model' || name === 'default-video-model') {
        exitCode = runConfigGetValue(name, opts);
        return;
      }
      console.error(`Unknown config key: ${name} (supported: api-key, default-image-model, default-video-model)`);
      exitCode = EXIT.USAGE;
    });
  config
    .command('list')
    .description('Show all config values')
    .option('--reveal', 'print the full, unmasked API key')
    .option('--json', 'output a single-line JSON')
    .action((opts: { reveal?: boolean; json?: boolean }) => {
      exitCode = runConfigList(opts);
    });
  config
    .command('path')
    .description('Print the config file path')
    .action(() => {
      exitCode = runConfigPath();
    });
  config
    .command('models')
    .description('Show configured default image/video models')
    .option('--json', 'output a single-line JSON')
    .action((opts: { json?: boolean }) => {
      exitCode = runConfigGetDefaultModels(opts);
    });

  program.addHelpText(
    'after',
    `\nExamples:\n  lkm setup                           Run interactive first-time setup\n  lkm image "a red panda" -q low      Generate an image (the word gen may be omitted)\n  lkm video "a misty valley drone shot"  Generate a video (the word gen may be omitted)\n  lkm image gen "a red panda" -q low  Same as above, explicit form\n  lkm image status <task_id>          Query a task\n`,
  );

  if (argv.length <= 2) {
    program.outputHelp();
    return EXIT.OK;
  }

  try {
    await program.parseAsync(effectiveArgv);
  } catch (err) {
    if (err instanceof CommanderError) {
      // Commander has already printed usage/help to stderr/stdout.
      // --help and --version exit with 0; all other usage errors map to exit code 2.
      return err.exitCode === 0 ? EXIT.OK : EXIT.USAGE;
    }
    console.error(`Unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return EXIT.FAILED;
  }
  if (shouldUpdateCheck) await maybePrintUpdateNotice();
  return exitCode;
}

function shouldCheckForUpdate(argv: string[]): boolean {
  if (!process.stdout.isTTY) return false;
  if (process.env.NO_UPDATE_NOTIFIER || process.env.LINKMODEL_NO_UPDATE_CHECK) return false;
  for (const arg of argv.slice(2)) {
    if (arg === '--json' || arg === '--help' || arg === '-h' || arg === '--version' || arg === '-V') {
      return false;
    }
  }
  return argv.length > 2;
}

async function maybePrintUpdateNotice(): Promise<void> {
  const result = await checkForUpdate({
    packageName: PACKAGE_NAME,
    currentVersion: VERSION,
  });
  if (!result?.updateAvailable) return;
  process.stderr.write(
    `Update available: ${PACKAGE_NAME} ${result.currentVersion} -> ${result.latestVersion}\n` +
      `Run: npm install -g ${PACKAGE_NAME}@latest\n`,
  );
}

// npm link / npm i -g install symlinks, so argv[1] is the symlink path.
// import.meta.url is the real path resolved by Node, so compare after realpath.
// Otherwise global installs would never call run() and would silently exit 0.
const invokedAsScript = (() => {
  const scriptPath = process.argv[1];
  if (typeof scriptPath !== 'string') return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(scriptPath)).href;
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  run(process.argv).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err);
      process.exitCode = EXIT.FAILED;
    },
  );
}
