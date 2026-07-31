import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_TIMEOUT_MS = 2_000;

interface UpdateCache {
  checked_at?: number;
  latest?: string;
}

export interface UpdateCheckOptions {
  packageName: string;
  currentVersion: string;
  homeDir?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  force?: boolean;
}

export interface UpdateCheckResult {
  latestVersion: string;
  currentVersion: string;
  updateAvailable: boolean;
}

export function updateCachePath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.linkmodel', 'update.json');
}

export async function checkForUpdate(
  options: UpdateCheckOptions,
): Promise<UpdateCheckResult | null> {
  const now = options.now?.() ?? Date.now();
  const cachePath = updateCachePath(options.homeDir);
  const cached = readCache(cachePath);
  if (
    !options.force
    && cached.checked_at
    && now - cached.checked_at < CHECK_INTERVAL_MS
  ) {
    return resultFromLatest(options.currentVersion, cached.latest);
  }

  let latest: string | null = null;
  try {
    latest = await fetchLatestVersion(options.packageName, options.fetchImpl ?? fetch);
  } catch {
    latest = null;
  }
  writeCache(cachePath, { checked_at: now, latest: latest ?? cached.latest });
  return resultFromLatest(options.currentVersion, latest ?? cached.latest);
}

function resultFromLatest(currentVersion: string, latest: string | undefined): UpdateCheckResult | null {
  if (!latest) return null;
  return {
    latestVersion: latest,
    currentVersion,
    updateAvailable: compareSemver(latest, currentVersion) > 0,
  };
}

async function fetchLatestVersion(packageName: string, fetchImpl: typeof fetch): Promise<string> {
  const encoded = encodeURIComponent(packageName).replace(/^%40/, '@');
  const res = await fetchImpl(`https://registry.npmjs.org/${encoded}/latest`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`npm registry returned HTTP ${res.status}`);
  const body: unknown = await res.json();
  const version = typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>).version
    : undefined;
  if (typeof version !== 'string' || !version.trim()) {
    throw new Error('npm registry response missing version');
  }
  return version.trim();
}

function readCache(p: string): UpdateCache {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as UpdateCache;
    }
  } catch {
    // Corrupt or absent update cache should never affect the primary command.
  }
  return {};
}

function writeCache(p: string, cache: UpdateCache): void {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(p, 0o600);
  } catch {
    // Update checks are advisory only.
  }
}

export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (left[i] > right[i]) return 1;
    if (left[i] < right[i]) return -1;
  }
  return 0;
}

function parseSemver(value: string): [number, number, number] {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
