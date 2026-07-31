import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DisplayModel, UpstreamParameterSchema } from '../src/upstream/client.js';
import { toModelSchema } from '../src/upstream/transform.js';

const models: DisplayModel[] = [
  { name: 'gpt-image-2', mode_type: 'image', provider: 'openai', task_types: ['text-to-image', 'image-to-image'] },
  { name: 'kling-v3', mode_type: 'video', provider: 'kling', task_types: ['text-to-video', 'image-to-video'] },
];

const schemas: Record<string, UpstreamParameterSchema> = {
  'gpt-image-2': {
    fields: [
      { name: 'model', type: 'string' },
      { name: 'prompt', type: 'string', min_length: 1, max_length: 32000 },
      { name: 'images', type: 'array', constraints: { item_format: 'url', array_max_length: 10 }, ui: { label: 'Reference images' } },
      { name: 'quality', type: 'string', constraints: { enum_values: ['high', 'low', 'medium'], default: 'medium' } },
    ],
  },
  'kling-v3': {
    fields: [
      { name: 'model', type: 'string' },
      { name: 'prompt', type: 'string' },
      { name: 'extends', type: 'object' },
      { name: 'extends.cfg_scale', type: 'float', min: 0, max: 1, ui: { label: 'CFG scale' } },
      { name: 'first_frame_image', type: 'string', format: 'url' },
    ],
  },
};

test('transforms image parameter constraints and excludes model/prompt fields', () => {
  const schema = toModelSchema('image', models, schemas);
  assert.equal(schema.defaultModel, 'gpt-image-2');
  assert.deepEqual(schema.models['gpt-image-2'].prompt, { minLength: 1, maxLength: 32000 });
  assert.equal(schema.models['gpt-image-2'].fields.model, undefined);
  assert.equal(schema.models['gpt-image-2'].fields.prompt, undefined);
  assert.equal(schema.models['gpt-image-2'].fields.images.type, 'urlArray');
  assert.equal(schema.models['gpt-image-2'].fields.images.maxItems, 10);
  assert.deepEqual(schema.models['gpt-image-2'].fields.quality.choices, ['high', 'low', 'medium']);
  assert.equal(schema.models['gpt-image-2'].fields.quality.default, 'medium');
  assert.equal(schema.models['kling-v3'], undefined, 'image-to-video task type must not make a model an image modality');
});

test('transforms dotted video fields into raw CLI flags', () => {
  const schema = toModelSchema('video', models, schemas);
  assert.equal(schema.defaultModel, 'kling-v3');
  assert.equal(schema.models['kling-v3'].fields.extends, undefined);
  assert.deepEqual(schema.models['kling-v3'].fields['extends.cfg_scale'], {
    type: 'float',
    flags: '--extends-cfg-scale <value>',
    description: 'CFG scale',
    min: 0,
    max: 1,
  });
  assert.equal(schema.models['kling-v3'].fields.first_frame_image.flags, '--first-frame-image <url>');
});
