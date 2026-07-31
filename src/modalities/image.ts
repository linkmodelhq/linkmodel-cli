/**
 * image modality: the first ModalitySpec implementation.
 *
 * Endpoints: POST /image-generation + GET /query/image-generation
 * Parameters: model (default gpt-image-2) / quality / size / images (reference image URLs)
 * Artifacts: output_images array; file extension is inferred from image MIME and falls back to .png
 */

import path from 'node:path';

import { GENERATED_IMAGE_MODEL_SCHEMA } from '../generated/model-schemas.js';
import type { ModalitySpec } from './spec.js';
import {
  buildModelCreateRequest,
  buildModelGenOptions,
  buildModelGenOptionsForModel,
  parseModelGenOptions,
  validateModelGen,
  type ModelGenOptions,
  type ModelSchema,
} from './model-schema.js';

export const QUALITIES = ['low', 'medium', 'high'] as const;
export type Quality = (typeof QUALITIES)[number];

/**
 * size constraints from the official Size and quality options documentation:
 * gpt-image-2 accepts any resolution in the size parameter satisfying these.
 * Regression note: do not copy the OpenAPI enum as a hard constraint. 1792x1024 was observed to create successfully,
 * and official popular sizes such as 2048x2048, 2048x1152, 3840x2160, and 2160x3840 are also valid.
 * The enum would incorrectly reject sizes the server supports.
 */
const SIZE_EDGE_MULTIPLE = 16;
const SIZE_MAX_EDGE = 3840;
const SIZE_MAX_RATIO = 3;
const SIZE_MIN_TOTAL_PIXELS = 655_360;
const SIZE_MAX_TOTAL_PIXELS = 8_294_400; // 3840x2160 exactly equals the inclusive upper bound.

const SIZE_PATTERN = /^(\d+)x(\d+)$/;

/**
 * Validate size and return the exact violated rule; null means valid.
 * Local validation gives faster and clearer actionable feedback than the server.
 */
export function validateSize(size: string): string | null {
  if (size === 'auto') return null;
  const m = SIZE_PATTERN.exec(size);
  if (!m) {
    return `Size ${size}: must be "auto" or <width>x<height> (e.g. 1024x1024, 2048x1152)`;
  }
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (w <= 0 || h <= 0) {
    return `Size ${size}: width and height must be positive integers`;
  }
  if (w % SIZE_EDGE_MULTIPLE !== 0 || h % SIZE_EDGE_MULTIPLE !== 0) {
    return `Size ${size}: both edges must be multiples of 16`;
  }
  const longest = Math.max(w, h);
  const shortest = Math.min(w, h);
  if (longest > SIZE_MAX_EDGE) {
    return `Size ${size}: longest edge must be <= 3840px`;
  }
  const ratio = longest / shortest;
  if (ratio > SIZE_MAX_RATIO) {
    return `Size ${size}: long-to-short edge ratio must not exceed 3:1 (got ${Number(ratio.toFixed(2))})`;
  }
  const pixels = w * h;
  if (pixels < SIZE_MIN_TOTAL_PIXELS) {
    return `Size ${size}: total pixels must be >= 655360 (got ${pixels})`;
  }
  if (pixels > SIZE_MAX_TOTAL_PIXELS) {
    return `Size ${size}: total pixels must be <= 8294400 (got ${pixels})`;
  }
  return null;
}

const MAX_PROMPT_LENGTH = 32_000;
const MAX_IMAGES = 10;
const DEFAULT_MODEL = 'gpt-image-2';
export type ImageGenOptions = ModelGenOptions;

export const IMAGE_MODEL_SCHEMA: ModelSchema = {
  ...GENERATED_IMAGE_MODEL_SCHEMA,
  models: {
    ...GENERATED_IMAGE_MODEL_SCHEMA.models,
    [DEFAULT_MODEL]: {
      ...GENERATED_IMAGE_MODEL_SCHEMA.models[DEFAULT_MODEL],
      prompt: {
        minLength: 1,
        maxLength: MAX_PROMPT_LENGTH,
      },
      fields: {
        ...GENERATED_IMAGE_MODEL_SCHEMA.models[DEFAULT_MODEL].fields,
        quality: {
          ...GENERATED_IMAGE_MODEL_SCHEMA.models[DEFAULT_MODEL].fields.quality,
          flags: '-q, --quality <quality>',
          description: 'image quality',
          choices: QUALITIES,
          default: 'medium',
        },
        size: {
          ...GENERATED_IMAGE_MODEL_SCHEMA.models[DEFAULT_MODEL].fields.size,
          flags: '-s, --size <size>',
          description:
            'image size: "auto" or <width>x<height>; edges must be multiples of 16, longest edge <= 3840, ratio <= 3:1, total pixels 655360-8294400 (e.g. 1024x1024 square, 1536x1024 landscape, 1024x1536 portrait, 2048x1152 2K 16:9, 3840x2160 4K 16:9)',
          default: 'auto',
          choices: undefined,
          validate: (value) => validateSize(String(value ?? 'auto')),
        },
        images: {
          ...GENERATED_IMAGE_MODEL_SCHEMA.models[DEFAULT_MODEL].fields.images,
          flags: '-i, --image <url...>',
          rawKey: 'image',
          description: 'reference image URL (repeatable, max 10)',
          minItems: undefined,
          maxItems: MAX_IMAGES,
        },
      },
    },
  },
};

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
};

const KNOWN_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']);

/** Image extension inference: Content-Type first, then URL path extension, then .png fallback. */
export function resolveImageExtension(url: string, contentType: string | null): string {
  const mime = contentType?.split(';')[0]?.trim().toLowerCase();
  if (mime && EXT_BY_MIME[mime]) return EXT_BY_MIME[mime];
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (KNOWN_EXTS.has(ext)) return ext === '.jpeg' ? '.jpg' : ext;
  } catch {
    // Invalid URL: use fallback.
  }
  return '.png';
}

export const imageModality: ModalitySpec<ImageGenOptions> = {
  name: 'image',
  description: 'Image generation tasks',
  genDescription: 'Generate an image: create task, poll, download',
  createPath: '/image-generation',
  queryPath: '/query/image-generation',
  artifactNoun: { singular: 'image', plural: 'images' },
  defaultModelConfigKey: 'default-image-model',

  genOptions: buildModelGenOptions(IMAGE_MODEL_SCHEMA),
  genOptionsForModel(model) {
    return buildModelGenOptionsForModel(IMAGE_MODEL_SCHEMA, model);
  },

  parseGenOptions(raw) {
    return parseModelGenOptions(IMAGE_MODEL_SCHEMA, raw);
  },

  validateGen(prompt, opts) {
    return validateModelGen(IMAGE_MODEL_SCHEMA, prompt, opts);
  },

  buildCreateRequest(prompt, opts) {
    return buildModelCreateRequest(IMAGE_MODEL_SCHEMA, prompt, opts);
  },

  extractArtifactUrls(data) {
    const urls = data.output_images;
    if (!Array.isArray(urls)) return [];
    return urls.filter((u): u is string => typeof u === 'string');
  },

  resolveExtension: resolveImageExtension,
};
