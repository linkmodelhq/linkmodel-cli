/**
 * API key resolution priority:
 *   --api-key command-line flag > LINKMODEL_API_KEY environment variable > ~/.linkmodel/config.json
 *
 * Config files are written with mode 0600. Corrupt config is not silently ignored; ConfigError tells the user.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ENV_API_KEY = 'LINKMODEL_API_KEY';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type KeySource = 'flag' | 'env' | 'config';

const MASK_HEAD = 7; // Matches the sk-8b06... display format.
const MASK_TAIL = 4;
/** Minimum hidden characters. Short keys are fully masked to avoid revealing most of the value. */
const MASK_MIN_HIDDEN = 4;
const FULL_MASK = '••••••••';

/**
 * API key masking: prefix plus last 4 characters, with the middle omitted.
 * The key remains identifiable but not usable. Short keys are fully masked.
 */
export function maskApiKey(key: string): string {
  if (key.length >= MASK_HEAD + MASK_TAIL + MASK_MIN_HIDDEN) {
    return `${key.slice(0, MASK_HEAD)}…${key.slice(-MASK_TAIL)}`;
  }
  return FULL_MASK;
}

export interface ResolvedKey {
  key: string;
  source: KeySource;
}

export type DefaultModelKey = 'default-image-model' | 'default-video-model';
export type ConfigModelField = 'default_image_model' | 'default_video_model';

const DEFAULT_MODEL_FIELD: Record<DefaultModelKey, ConfigModelField> = {
  'default-image-model': 'default_image_model',
  'default-video-model': 'default_video_model',
};

export function configPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.linkmodel', 'config.json');
}

export interface ResolveApiKeyOptions {
  /** --api-key command-line flag */
  flag?: string;
  /** Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to os.homedir(). */
  homeDir?: string;
}

export function resolveApiKey(options: ResolveApiKeyOptions = {}): ResolvedKey | null {
  const flag = options.flag?.trim();
  if (flag) return { key: flag, source: 'flag' };

  const env = options.env ?? process.env;
  const fromEnv = env[ENV_API_KEY]?.trim();
  if (fromEnv) return { key: fromEnv, source: 'env' };

  const p = configPath(options.homeDir);
  const raw = readConfigFile(p);
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`Config file ${p} is not valid JSON: ${(err as Error).message}`);
  }
  const key =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>).api_key
      : undefined;
  if (typeof key === 'string' && key.trim()) return { key: key.trim(), source: 'config' };
  return null;
}

export function readConfigObject(homeDir?: string): Record<string, unknown> | null {
  const p = configPath(homeDir);
  const raw = readConfigFile(p);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`Config file ${p} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

export function resolveDefaultModel(key: DefaultModelKey, homeDir?: string): string | null {
  const config = readConfigObject(homeDir);
  if (!config) return null;
  const value = config[DEFAULT_MODEL_FIELD[key]];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Write ~/.linkmodel/config.json with mode 0600. Existing fields are preserved. */
export function writeApiKey(apiKey: string, homeDir?: string): string {
  return writeConfigValue('api_key', apiKey, homeDir);
}

export function removeApiKey(homeDir?: string): string {
  const p = configPath(homeDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const existing = readConfigObject(homeDir) ?? {};
  delete existing.api_key;
  fs.writeFileSync(p, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(p, 0o600);
  return p;
}

export function writeDefaultModel(key: DefaultModelKey, model: string, homeDir?: string): string {
  return writeConfigValue(DEFAULT_MODEL_FIELD[key], model, homeDir);
}

function writeConfigValue(field: string, value: string, homeDir?: string): string {
  const p = configPath(homeDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });

  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // File missing or corrupt: the user is explicitly resetting config, so rewrite it.
  }

  fs.writeFileSync(p, `${JSON.stringify({ ...existing, [field]: value }, null, 2)}\n`, {
    mode: 0o600,
  });
  // writeFile mode only applies to new files; chmod ensures existing files return to 0600.
  fs.chmodSync(p, 0o600);
  return p;
}

function readConfigFile(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ConfigError(`Cannot read config file ${p}: ${(err as Error).message}`);
  }
}
