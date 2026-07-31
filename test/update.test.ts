import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { checkForUpdate, compareSemver, updateCachePath } from '../src/core/update.js';

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'linkmodel-update-test-'));

test('compareSemver compares only the stable version core', () => {
  assert.equal(compareSemver('0.1.1', '0.1.0'), 1);
  assert.equal(compareSemver('0.2.0', '0.10.0'), -1);
  assert.equal(compareSemver('v1.0.0', '1.0.0'), 0);
});

test('checkForUpdate:writes cache and reuses it within 24 hours', async () => {
  const home = tmpHome();
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response(JSON.stringify({ version: '0.1.1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const first = await checkForUpdate({
    packageName: 'linkmodel-cli',
    currentVersion: '0.1.0',
    homeDir: home,
    fetchImpl: fetchImpl as typeof fetch,
    now: () => 1_000,
  });
  assert.equal(first?.updateAvailable, true);
  assert.equal(first?.latestVersion, '0.1.1');
  assert.equal(calls, 1);
  assert.equal(fs.statSync(updateCachePath(home)).mode & 0o777, 0o600);

  const second = await checkForUpdate({
    packageName: 'linkmodel-cli',
    currentVersion: '0.1.0',
    homeDir: home,
    fetchImpl: fetchImpl as typeof fetch,
    now: () => 2_000,
  });
  assert.equal(second?.latestVersion, '0.1.1');
  assert.equal(calls, 1);
});

test('checkForUpdate:network failures quietly return cache or null', async () => {
  const home = tmpHome();
  const failedFetch = async () => {
    throw new Error('offline');
  };
  const result = await checkForUpdate({
    packageName: 'linkmodel-cli',
    currentVersion: '0.1.0',
    homeDir: home,
    fetchImpl: failedFetch as typeof fetch,
    now: () => 1_000,
  });
  assert.equal(result, null);
});
