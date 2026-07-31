import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveVideoExtension, videoModality } from '../src/modalities/video.js';

test('extension inference:Content-Type first,then URL when unavailable, then fallback .mp4', () => {
  assert.equal(resolveVideoExtension('https://x/a.mp4', 'video/webm'), '.webm');
  assert.equal(resolveVideoExtension('https://x/a.MOV?sig=1', null), '.mov');
  assert.equal(resolveVideoExtension('https://x/a.mpg', ''), '.mpeg');
  assert.equal(resolveVideoExtension('https://x/noext', 'application/octet-stream'), '.mp4');
  assert.equal(resolveVideoExtension('not a url', null), '.mp4');
});

test('parseGenOptions: normalizes raw Commander opts and applies defaults', () => {
  assert.deepEqual(
    videoModality.parseGenOptions({
      model: 'seedance-2-0',
      duration: '8',
      resolution: '480P',
      size: '9x16',
      firstFrameImage: 'https://x/first.png',
      audio: ['a1', 'a2'],
      video: ['https://x/v.mp4'],
    }),
    {
      model: 'seedance-2-0',
      duration: 8,
      resolution: '480P',
      size: '9x16',
      firstFrameImage: 'https://x/first.png',
      lastFrameImage: undefined,
      audios: ['a1', 'a2'],
      videos: ['https://x/v.mp4'],
    },
  );
});

test('validateGen:prompt, enum, URL, and count constraints', () => {
  const base = {
    model: 'seedance-2-0' as const,
    duration: 4,
    resolution: '720P' as const,
    size: '16x9' as const,
    audios: [],
    videos: [],
  };
  assert.deepEqual(videoModality.validateGen('a drone shot', base), []);
  assert.deepEqual(videoModality.validateGen('   ', base), ['Prompt must not be empty']);
  assert.ok(videoModality.validateGen('x'.repeat(2501), base)[0].includes('too long'));
  assert.match(
    videoModality.validateGen('ok', { ...base, firstFrameImage: 'not-url' })[0],
    /first_frame_image/,
  );
  assert.match(
    videoModality.validateGen('ok', { ...base, audios: ['a', 'b', 'c', 'd'] })[0],
    /max 3/,
  );
  assert.match(
    videoModality.validateGen('ok', { ...base, videos: ['https://x/1.mp4', 'bad'] })[0],
    /valid URL/,
  );
});

test('buildCreateRequest: includes all fields and omits empty optional arrays', () => {
  assert.deepEqual(
    videoModality.buildCreateRequest('a city timelapse', {
      model: 'seedance-2-0',
      duration: 6,
      resolution: '720P',
      size: '16x9',
      audios: [],
      videos: [],
    }),
    {
      model: 'seedance-2-0',
      prompt: 'a city timelapse',
      duration: 6,
      resolution: '720P',
      size: '16x9',
    },
  );
  assert.deepEqual(
    videoModality.buildCreateRequest('a product orbit', {
      model: 'seedance-2-0',
      duration: 8,
      resolution: '480P',
      size: '9x16',
      firstFrameImage: 'https://x/first.png',
      lastFrameImage: 'https://x/last.png',
      audios: ['audio-1'],
      videos: ['https://x/ref.mp4'],
    }),
    {
      model: 'seedance-2-0',
      prompt: 'a product orbit',
      duration: 8,
      resolution: '480P',
      size: '9x16',
      first_frame_image: 'https://x/first.png',
      last_frame_image: 'https://x/last.png',
      audios: ['audio-1'],
      videos: ['https://x/ref.mp4'],
    },
  );
});

test('extractArtifactUrls:prefers file_url and supports output_videos arrays', () => {
  assert.deepEqual(videoModality.extractArtifactUrls({ file_url: 'u1' }), ['u1']);
  assert.deepEqual(videoModality.extractArtifactUrls({ output_videos: ['u1', 'u2'] }), [
    'u1',
    'u2',
  ]);
  assert.deepEqual(videoModality.extractArtifactUrls({}), []);
  assert.deepEqual(videoModality.extractArtifactUrls({ output_videos: ['u1', 42, null] }), ['u1']);
});
