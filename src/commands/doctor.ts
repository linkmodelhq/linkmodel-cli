import fs from 'node:fs';

import { AuthError } from '../api/client.js';
import {
  configPath,
  maskApiKey,
  readConfigObject,
  resolveApiKey,
} from '../core/config.js';
import { checkForUpdate } from '../core/update.js';
import { PACKAGE_NAME, VERSION } from '../generated/version.js';
import { validateApiKey } from './auth.js';
import { errorMessage, EXIT, makeReporter, type CommandDeps } from './gen.js';

export interface DoctorOptions {
  json?: boolean;
  apiKey?: string;
}

type CheckStatus = 'pass' | 'warn' | 'fail';

interface DoctorCheck {
  name: string;
  status: CheckStatus;
  message: string;
}

export async function runDoctor(
  opts: DoctorOptions = {},
  deps: CommandDeps = {},
): Promise<number> {
  const reporter = makeReporter(opts.json, deps);
  const checks: DoctorCheck[] = [];

  checks.push(nodeVersionCheck(process.versions.node));
  checks.push({ name: 'CLI version', status: 'pass', message: VERSION });

  const p = configPath(deps.homeDir);
  checks.push(configFileCheck(p, deps.homeDir));

  let key: { key: string; source: string } | null = null;
  try {
    key = resolveApiKey({ flag: opts.apiKey, env: deps.env ?? process.env, homeDir: deps.homeDir });
    checks.push({
      name: 'API key',
      status: key ? 'pass' : 'warn',
      message: key ? `${maskApiKey(key.key)} (${key.source})` : 'not configured',
    });
  } catch (err) {
    checks.push({ name: 'API key', status: 'fail', message: errorMessage(err) });
  }

  if (key) {
    try {
      await validateApiKey(key.key, deps);
      checks.push({ name: 'API key validation', status: 'pass', message: 'valid' });
    } catch (err) {
      checks.push({
        name: 'API key validation',
        status: err instanceof AuthError ? 'fail' : 'warn',
        message: errorMessage(err),
      });
    }
  }

  try {
    const update = await checkForUpdate({
      packageName: PACKAGE_NAME,
      currentVersion: VERSION,
      homeDir: deps.homeDir,
      fetchImpl: deps.fetchImpl,
      force: true,
    });
    checks.push({
      name: 'Update check',
      status: update?.updateAvailable ? 'warn' : 'pass',
      message: update
        ? update.updateAvailable
          ? `update available: ${update.currentVersion} -> ${update.latestVersion}`
          : `latest: ${update.latestVersion}`
        : 'unable to check npm registry',
    });
  } catch (err) {
    checks.push({ name: 'Update check', status: 'warn', message: errorMessage(err) });
  }

  const ok = checks.every((check) => check.status !== 'fail');
  if (reporter.mode === 'json') {
    reporter.emitJson({ ok, version: VERSION, config_path: p, checks });
  } else {
    reporter.info('LinkModel CLI doctor');
    for (const check of checks) {
      reporter.out(`${symbolFor(check.status)} ${check.name}: ${check.message}`);
    }
  }
  return ok ? EXIT.OK : EXIT.FAILED;
}

function nodeVersionCheck(version: string): DoctorCheck {
  const major = Number(version.split('.')[0]);
  return {
    name: 'Node.js',
    status: Number.isFinite(major) && major >= 20 ? 'pass' : 'fail',
    message: version,
  };
}

function configFileCheck(p: string, homeDir: string | undefined): DoctorCheck {
  try {
    if (!fs.existsSync(p)) return { name: 'Config file', status: 'warn', message: `${p} does not exist` };
    readConfigObject(homeDir);
    const mode = fs.statSync(p).mode & 0o777;
    return {
      name: 'Config file',
      status: mode === 0o600 ? 'pass' : 'warn',
      message: mode === 0o600 ? `${p} (mode 0600)` : `${p} (mode ${mode.toString(8)}, expected 0600)`,
    };
  } catch (err) {
    return { name: 'Config file', status: 'fail', message: errorMessage(err) };
  }
}

function symbolFor(status: CheckStatus): string {
  if (status === 'pass') return 'OK';
  if (status === 'warn') return 'WARN';
  return 'FAIL';
}
