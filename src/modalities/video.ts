/**
 * video modality: POST /video-generation + GET /query/video-generation.
 *
 * Default model: kling-v3.
 * Artifacts: after successful query, read file_url with output_videos fallback. Infer extension from video MIME and fall back to .mp4.
 */

import path from 'node:path';

import { GENERATED_VIDEO_MODEL_SCHEMA } from '../generated/model-schemas.js';
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

const DEFAULT_MODEL = 'kling-v3';
const DURATIONS = ['4', '5', '6', '7', '8', '9', '10', '11', '12', '13'] as const;
const RESOLUTIONS = ['480P', '720P'] as const;
const SIZES = ['16x9', '1x1', '21x9', '3x4', '4x3', '9x16'] as const;
const MAX_PROMPT_LENGTH = 2500;
const MAX_AUDIOS = 3;
const MAX_VIDEOS = 3;

export type VideoGenOptions = ModelGenOptions;

export const VIDEO_MODEL_SCHEMA: ModelSchema = {
  ...GENERATED_VIDEO_MODEL_SCHEMA,
  defaultModel: DEFAULT_MODEL,
  models: {
    ...GENERATED_VIDEO_MODEL_SCHEMA.models,
    'seedance-2-0': {
      ...GENERATED_VIDEO_MODEL_SCHEMA.models['seedance-2-0'],
      prompt: { minLength: 1, maxLength: MAX_PROMPT_LENGTH },
      fields: {
        duration: {
          ...GENERATED_VIDEO_MODEL_SCHEMA.models['seedance-2-0'].fields.duration,
          flags: '-d, --duration <seconds>',
          description: 'video duration in seconds',
          default: 4,
        },
        resolution: {
          ...GENERATED_VIDEO_MODEL_SCHEMA.models['seedance-2-0'].fields.resolution,
          flags: '-r, --resolution <resolution>',
          description: 'video resolution',
          default: '720P',
        },
        size: {
          ...GENERATED_VIDEO_MODEL_SCHEMA.models['seedance-2-0'].fields.size,
          flags: '-s, --size <size>',
          description: 'video aspect ratio',
          default: '16x9',
        },
        firstFrameImage: {
          ...GENERATED_VIDEO_MODEL_SCHEMA.models['seedance-2-0'].fields.first_frame_image,
          flags: '--first-frame-image <url>',
          apiName: 'first_frame_image',
          description: 'first frame image URL',
        },
        lastFrameImage: {
          ...GENERATED_VIDEO_MODEL_SCHEMA.models['seedance-2-0'].fields.last_frame_image,
          flags: '--last-frame-image <url>',
          apiName: 'last_frame_image',
          description: 'last frame image URL',
        },
        audios: {
          ...GENERATED_VIDEO_MODEL_SCHEMA.models['seedance-2-0'].fields.audios,
          flags: '--audio <url...>',
          rawKey: 'audio',
          description: 'audio URL (repeatable, max 3)',
          maxItems: MAX_AUDIOS,
        },
        videos: {
          ...GENERATED_VIDEO_MODEL_SCHEMA.models['seedance-2-0'].fields.videos,
          flags: '--video <url...>',
          rawKey: 'video',
          description: 'reference video URL (repeatable, max 3)',
          maxItems: MAX_VIDEOS,
        },
      },
    },
  },
};

const EXT_BY_MIME: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/mpeg': '.mpeg',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-msvideo': '.avi',
};

const KNOWN_EXTS = new Set(['.mp4', '.mpeg', '.mpg', '.mov', '.webm', '.avi']);

/** Video extension inference: Content-Type first, then URL path extension, then .mp4 fallback. */
export function resolveVideoExtension(url: string, contentType: string | null): string {
  const mime = contentType?.split(';')[0]?.trim().toLowerCase();
  if (mime && EXT_BY_MIME[mime]) return EXT_BY_MIME[mime];
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (KNOWN_EXTS.has(ext)) return ext === '.mpg' ? '.mpeg' : ext;
  } catch {
    // Invalid URL: use fallback.
  }
  return '.mp4';
}

export const videoModality: ModalitySpec<VideoGenOptions> = {
  name: 'video',
  description: 'Video generation tasks',
  genDescription: 'Generate a video: create task, poll, download',
  createPath: '/video-generation',
  queryPath: '/query/video-generation',
  artifactNoun: { singular: 'video', plural: 'videos' },
  defaultModelConfigKey: 'default-video-model',

  genOptions: buildModelGenOptions(VIDEO_MODEL_SCHEMA),
  genOptionsForModel(model) {
    return buildModelGenOptionsForModel(VIDEO_MODEL_SCHEMA, model);
  },

  parseGenOptions(raw) {
    return parseModelGenOptions(VIDEO_MODEL_SCHEMA, raw);
  },

  validateGen(prompt, opts) {
    return validateModelGen(VIDEO_MODEL_SCHEMA, prompt, opts);
  },

  buildCreateRequest(prompt, opts) {
    return buildModelCreateRequest(VIDEO_MODEL_SCHEMA, prompt, opts);
  },

  extractArtifactUrls(data) {
    const fileUrl = data.file_url;
    if (typeof fileUrl === 'string') return [fileUrl];
    const urls = data.output_videos;
    if (!Array.isArray(urls)) return [];
    return urls.filter((u): u is string => typeof u === 'string');
  },

  resolveExtension: resolveVideoExtension,
};
