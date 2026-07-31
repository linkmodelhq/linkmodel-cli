import {
  GENERATED_IMAGE_MODEL_SCHEMA,
  GENERATED_VIDEO_MODEL_SCHEMA,
} from '../generated/model-schemas.js';
import type { ModelFieldSpec, ModelSchema } from '../modalities/model-schema.js';
import { EXIT, makeReporter, reportFailure, type CommandDeps } from './gen.js';

type ModalityName = 'image' | 'video';

const SCHEMAS: Record<ModalityName, ModelSchema> = {
  image: GENERATED_IMAGE_MODEL_SCHEMA,
  video: GENERATED_VIDEO_MODEL_SCHEMA,
};

export interface ModelsListOptions {
  modality?: string;
  json?: boolean;
}

export interface ModelsShowOptions {
  json?: boolean;
}

export function runModelsList(opts: ModelsListOptions = {}, deps: CommandDeps = {}): number {
  const reporter = makeReporter(opts.json, deps);
  const modalities = selectedModalities(opts.modality);
  if (!modalities) {
    return reportFailure(reporter, '--modality must be one of: image, video', EXIT.USAGE);
  }

  const models = modalities.flatMap((modality) => {
    const schema = SCHEMAS[modality];
    return Object.keys(schema.models).sort().map((name) => ({
      modality,
      name,
      default: name === schema.defaultModel,
    }));
  });

  if (reporter.mode === 'json') reporter.emitJson({ ok: true, models });
  else {
    for (const model of models) {
      reporter.out(`${model.modality}\t${model.name}${model.default ? '\t(default)' : ''}`);
    }
  }
  return EXIT.OK;
}

export function runModelsShow(
  name: string,
  opts: ModelsShowOptions = {},
  deps: CommandDeps = {},
): number {
  const reporter = makeReporter(opts.json, deps);
  const found = findModel(name);
  if (!found) return reportFailure(reporter, `Unknown model: ${name}`, EXIT.USAGE);

  const fields = Object.entries(found.schema.models[name].fields)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fieldName, field]) => describeField(fieldName, field));
  const payload = {
    ok: true,
    modality: found.modality,
    name,
    default: found.schema.defaultModel === name,
    prompt: found.schema.models[name].prompt,
    fields,
  };

  if (reporter.mode === 'json') {
    reporter.emitJson(payload);
  } else {
    reporter.out(`${found.modality}/${name}${payload.default ? ' (default)' : ''}`);
    reporter.out(`prompt: ${formatPrompt(payload.prompt)}`);
    for (const field of fields) {
      reporter.out(`${field.flags}\t${field.type}${field.default !== undefined ? `\tdefault=${String(field.default)}` : ''}`);
      if (field.choices?.length) reporter.out(`  choices: ${field.choices.join(', ')}`);
      if (field.constraints.length) reporter.out(`  constraints: ${field.constraints.join(', ')}`);
    }
  }
  return EXIT.OK;
}

function selectedModalities(value: string | undefined): ModalityName[] | null {
  if (!value) return ['image', 'video'];
  if (value === 'image' || value === 'video') return [value];
  return null;
}

function findModel(name: string): { modality: ModalityName; schema: ModelSchema } | null {
  for (const modality of ['image', 'video'] as const) {
    const schema = SCHEMAS[modality];
    if (schema.models[name]) return { modality, schema };
  }
  return null;
}

function describeField(name: string, field: ModelFieldSpec) {
  const constraints: string[] = [];
  if (field.required) constraints.push('required');
  if (field.min !== undefined) constraints.push(`min=${field.min}`);
  if (field.max !== undefined) constraints.push(`max=${field.max}`);
  if (field.minLength !== undefined) constraints.push(`minLength=${field.minLength}`);
  if (field.maxLength !== undefined) constraints.push(`maxLength=${field.maxLength}`);
  if (field.minItems !== undefined) constraints.push(`minItems=${field.minItems}`);
  if (field.maxItems !== undefined) constraints.push(`maxItems=${field.maxItems}`);
  return {
    name,
    api_name: field.apiName ?? name,
    flags: field.flags,
    type: field.type,
    description: field.description,
    default: field.default,
    choices: field.choices,
    constraints,
  };
}

function formatPrompt(prompt: { minLength?: number; maxLength?: number }): string {
  const parts: string[] = [];
  if (prompt.minLength !== undefined) parts.push(`minLength=${prompt.minLength}`);
  if (prompt.maxLength !== undefined) parts.push(`maxLength=${prompt.maxLength}`);
  return parts.length ? parts.join(', ') : 'no generated constraints';
}
