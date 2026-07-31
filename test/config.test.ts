import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  ConfigError,
  configPath,
  ENV_API_KEY,
  maskApiKey,
  resolveApiKey,
  resolveDefaultModel,
  writeApiKey,
  writeDefaultModel,
} from '../src/core/config.js';

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'linkmodel-config-test-'));

test('priority: --api-key > environment variable > config file', () => {
  const home = tmpHome();
  writeApiKey('file-key', home);
  const env = { [ENV_API_KEY]: 'env-key' };

  assert.deepEqual(resolveApiKey({ flag: 'flag-key', env, homeDir: home }), {
    key: 'flag-key',
    source: 'flag',
  });
  assert.deepEqual(resolveApiKey({ env, homeDir: home }), { key: 'env-key', source: 'env' });
  assert.deepEqual(resolveApiKey({ env: {}, homeDir: home }), { key: 'file-key', source: 'config' });
});

test('returns null when none of the three sources is present', () => {
  assert.equal(resolveApiKey({ env: {}, homeDir: tmpHome() }), null);
});

test('blank key is ignored and lower-priority sources are checked', () => {
  const home = tmpHome();
  writeApiKey('file-key', home);
  assert.deepEqual(resolveApiKey({ flag: '   ', env: { [ENV_API_KEY]: '' }, homeDir: home }), {
    key: 'file-key',
    source: 'config',
  });
});

test('invalid JSON config throws ConfigError without silent fallback', () => {
  const home = tmpHome();
  fs.mkdirSync(path.dirname(configPath(home)), { recursive: true });
  fs.writeFileSync(configPath(home), '{not json');
  assert.throws(() => resolveApiKey({ env: {}, homeDir: home }), ConfigError);
});

test('valid config without api_key returns null', () => {
  const home = tmpHome();
  fs.mkdirSync(path.dirname(configPath(home)), { recursive: true });
  fs.writeFileSync(configPath(home), '{"other": 1}');
  assert.equal(resolveApiKey({ env: {}, homeDir: home }), null);
});

test('maskApiKey:prefix plus last 4 characters with middle omitted', () => {
  assert.equal(maskApiKey('sk-8b06abcdef1234fcc6'), 'sk-8b06…fcc6');
  // Exactly 15 chars (7+4+4) is the minimum boundary for head/tail masking.
  assert.equal(maskApiKey('abcdefghijklmno'), 'abcdefg…lmno');
});

test('maskApiKey:short keys are fully masked with fixed width to avoid leaking length', () => {
  for (const k of ['', 'a', 'abc', 'short-key', 'abcdefghijklmn']) {
    const masked = maskApiKey(k);
    assert.equal(masked, '••••••••', `key "${k}" should be fully masked`);
    // No two-character source fragment should appear in the masked result.
    if (k.length >= 2) assert.ok(!masked.includes(k.slice(0, 2)));
  }
});

test('maskApiKey:masked key is identifiable but not usable', () => {
  const key = 'sk-testkey1234567890';
  const masked = maskApiKey(key);
  assert.ok(masked.startsWith('sk-test'));
  assert.ok(masked.endsWith('7890'));
  assert.ok(!masked.includes(key));
});

test('writeApiKey writes with mode 0600', () => {
  const home = tmpHome();
  const p = writeApiKey('k1', home);
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(parsed.api_key, 'k1');
});

test('repeated writes restore existing file to 0600 and preserve other fields', () => {
  const home = tmpHome();
  const p = writeApiKey('k1', home);
  fs.chmodSync(p, 0o644); // Simulate a user loosening permissions.
  fs.writeFileSync(p, JSON.stringify({ api_key: 'k1', other: 'keep' }));
  writeApiKey('k2', home);
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(parsed.api_key, 'k2');
  assert.equal(parsed.other, 'keep');
});

test('writeDefaultModel / resolveDefaultModel:stores per-modality default models while preserving api_key', () => {
  const home = tmpHome();
  writeApiKey('k1', home);
  writeDefaultModel('default-image-model', 'seedream-4.5', home);
  writeDefaultModel('default-video-model', 'kling-v3', home);
  assert.equal(resolveDefaultModel('default-image-model', home), 'seedream-4.5');
  assert.equal(resolveDefaultModel('default-video-model', home), 'kling-v3');
  const parsed = JSON.parse(fs.readFileSync(configPath(home), 'utf8'));
  assert.equal(parsed.api_key, 'k1');
  assert.equal(parsed.default_image_model, 'seedream-4.5');
  assert.equal(parsed.default_video_model, 'kling-v3');
});
