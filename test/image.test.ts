import assert from 'node:assert/strict';
import { test } from 'node:test';

import { imageModality, resolveImageExtension, validateSize } from '../src/modalities/image.js';

test('extension inference:Content-Type first', () => {
  // URL is .png but the server actually returns webp, so Content-Type wins.
  assert.equal(resolveImageExtension('https://x/a.png', 'image/webp'), '.webp');
  assert.equal(resolveImageExtension('https://x/a', 'image/jpeg; charset=binary'), '.jpg');
});

test('extension inference:uses URL path when Content-Type is absent', () => {
  assert.equal(resolveImageExtension('https://x/a.JPG?sig=1', null), '.jpg');
  assert.equal(resolveImageExtension('https://x/a.jpeg', ''), '.jpg');
});

test('extension inference:falls back when neither source has an extension .png', () => {
  assert.equal(resolveImageExtension('https://x/noext', null), '.png');
  assert.equal(resolveImageExtension('https://x/a.bin', 'application/octet-stream'), '.png');
  assert.equal(resolveImageExtension('not a url', null), '.png');
});

test('validateGen:empty/too-long prompt, empty model, more than 10 images', () => {
  const base = { model: 'gpt-image-2', quality: 'medium' as const, size: 'auto' as const, images: [] };
  assert.deepEqual(imageModality.validateGen('a cat', base), []);
  assert.deepEqual(imageModality.validateGen('   ', base), ['Prompt must not be empty']);
  assert.ok(imageModality.validateGen('x'.repeat(32_001), base)[0].includes('too long'));
  assert.deepEqual(imageModality.validateGen('ok', { ...base, model: ' ' }), [
    'Model must not be empty',
  ]);
  const eleven = Array.from({ length: 11 }, (_, i) => `https://x/${i}.png`);
  assert.ok(
    imageModality.validateGen('ok', { ...base, images: eleven })[0].includes('max 10'),
  );
});

test('buildCreateRequest: includes all fields and omits empty images', () => {
  assert.deepEqual(
    imageModality.buildCreateRequest('a cat', {
      model: 'gpt-image-2',
      quality: 'high',
      size: '1024x1024',
      images: [],
    }),
    { model: 'gpt-image-2', prompt: 'a cat', quality: 'high', size: '1024x1024' },
  );
  assert.deepEqual(
    imageModality.buildCreateRequest('a cat', {
      model: 'm',
      quality: 'low',
      size: 'auto',
      images: ['https://x/1.png'],
    }).images,
    ['https://x/1.png'],
  );
});

test('extractArtifactUrls: reads output_images and returns empty for invalid shapes', () => {
  assert.deepEqual(imageModality.extractArtifactUrls({ output_images: ['u1', 'u2'] }), [
    'u1',
    'u2',
  ]);
  assert.deepEqual(imageModality.extractArtifactUrls({}), []);
  assert.deepEqual(imageModality.extractArtifactUrls({ output_images: 'not-array' }), []);
  // Non-string items are filtered while valid URLs remain available.
  assert.deepEqual(imageModality.extractArtifactUrls({ output_images: ['u1', 42, null] }), ['u1']);
});

test('validateSize:all valid values pass(including inclusive upper bound 3840x2160)', () => {
  for (const ok of [
    'auto',
    '1024x1024',
    '2048x1152', // 2K 16:9
    '3840x2160', // 4K 16:9, total pixels exactly equal the inclusive upper bound 8294400
    '1792x1024', // enum-outside size observed to be accepted by the server
    '2048x2048',
    '2160x3840',
  ]) {
    assert.equal(validateSize(ok), null, `${ok} should be valid`);
  }
});

test('validateSize:non-multiple of 16 reports the exact issue', () => {
  assert.equal(validateSize('1000x1024'), 'Size 1000x1024: both edges must be multiples of 16');
});

test('validateSize:longest edge over 3840 reports the exact issue', () => {
  assert.equal(validateSize('4096x1024'), 'Size 4096x1024: longest edge must be <= 3840px');
});

test('validateSize:ratio over 3:1 reports the exact ratio', () => {
  assert.equal(
    validateSize('3840x512'),
    'Size 3840x512: long-to-short edge ratio must not exceed 3:1 (got 7.5)',
  );
});

test('validateSize:pixel count too small / too large', () => {
  assert.equal(validateSize('512x512'), 'Size 512x512: total pixels must be >= 655360 (got 262144)');
  // 3840x3840 satisfies edge and ratio constraints but exceeds the inclusive total-pixel upper bound.
  assert.equal(
    validateSize('3840x3840'),
    'Size 3840x3840: total pixels must be <= 8294400 (got 14745600)',
  );
});

test('validateSize:invalid format', () => {
  for (const bad of ['1024*1024', 'abc', '1024x', 'x1024', '1024X1024', '']) {
    assert.match(validateSize(bad)!, /must be "auto" or <width>x<height>/, `${bad} should report a format error`);
  }
  assert.match(validateSize('0x1024')!, /positive integers/);
});

test('validateGen:size errors are included in validation errors', () => {
  const base = { model: 'gpt-image-2', quality: 'medium' as const, size: 'auto', images: [] };
  assert.deepEqual(imageModality.validateGen('a cat', { ...base, size: '2048x1152' }), []);
  assert.deepEqual(imageModality.validateGen('a cat', { ...base, size: '1000x1024' }), [
    'Size 1000x1024: both edges must be multiples of 16',
  ]);
});

test('parseGenOptions:normalizes raw Commander opts', () => {
  assert.deepEqual(
    imageModality.parseGenOptions({ quality: 'high', size: 'auto', image: ['u1'] }),
    { model: 'gpt-image-2', quality: 'high', size: 'auto', images: ['u1'] },
  );
});
