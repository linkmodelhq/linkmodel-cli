import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildModelCreateRequest,
  parseModelGenOptions,
  validateModelGen,
  type ModelSchema,
} from '../src/modalities/model-schema.js';

const schema: ModelSchema = {
  defaultModel: 'kling-v3',
  models: {
    'kling-v3': {
      prompt: { minLength: 1, maxLength: 2500 },
      fields: {
        duration: { type: 'integer', flags: '-d, --duration <seconds>', description: 'duration', choices: [3, 4, 5], default: 5 },
        'extends.audio': { type: 'bool', flags: '--extends-audio', description: 'include audio', default: false },
        'extends.cfg_scale': { type: 'float', flags: '--extends-cfg-scale <value>', description: 'cfg', min: 0, max: 1, default: 0.5 },
        first_frame_image: { type: 'url', flags: '--first-frame-image <url>', description: 'first frame' },
        videos: { type: 'urlArray', flags: '--video <url...>', rawKey: 'video', description: 'videos', maxItems: 3 },
      },
    },
  },
};

test('parse/build: bool, float, dotted fields become nested request body', () => {
  const opts = parseModelGenOptions(schema, {
    model: 'kling-v3',
    duration: '4',
    extendsAudio: true,
    extendsCfgScale: '0.7',
    firstFrameImage: 'https://x/first.png',
    video: ['https://x/ref.mp4'],
  });
  assert.equal(opts.duration, 4);
  assert.equal(opts['extends.audio'], true);
  assert.equal(opts['extends.cfg_scale'], 0.7);
  assert.deepEqual(buildModelCreateRequest(schema, 'prompt', opts), {
    model: 'kling-v3',
    prompt: 'prompt',
    duration: 4,
    extends: { audio: true, cfg_scale: 0.7 },
    first_frame_image: 'https://x/first.png',
    videos: ['https://x/ref.mp4'],
  });
});

test('validate: max/min, prompt length, url arrays', () => {
  const opts = parseModelGenOptions(schema, {
    model: 'kling-v3',
    duration: '9',
    extendsCfgScale: '2',
    video: ['bad'],
  });
  const errors = validateModelGen(schema, '', opts);
  assert.ok(errors.some((e) => e.includes('Prompt must not be empty')));
  assert.ok(errors.some((e) => e.includes('duration must be one of')));
  assert.ok(errors.some((e) => e.includes('extends.cfg_scale must be <= 1')));
  assert.ok(errors.some((e) => e.includes('videos must contain only valid URLs')));
});

test('parse/build: absent optional numeric fields are omitted, not serialized as null', () => {
  const optionalNumericSchema: ModelSchema = {
    defaultModel: 'm',
    models: {
      m: {
        prompt: { minLength: 1 },
        fields: {
          duration: { type: 'integer', flags: '--duration <value>', description: 'duration' },
          scale: { type: 'float', flags: '--scale <value>', description: 'scale' },
        },
      },
    },
  };
  const opts = parseModelGenOptions(optionalNumericSchema, { model: 'm' });
  assert.equal(opts.duration, undefined);
  assert.equal(opts.scale, undefined);
  assert.deepEqual(buildModelCreateRequest(optionalNumericSchema, 'prompt', opts), {
    model: 'm',
    prompt: 'prompt',
  });
});
