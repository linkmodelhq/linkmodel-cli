import { Option } from 'commander';

export interface PromptSpec {
  minLength?: number;
  maxLength?: number;
}

type FieldType =
  | 'string'
  | 'integer'
  | 'float'
  | 'bool'
  | 'stringArray'
  | 'url'
  | 'urlArray'
  | 'object';

export interface BaseFieldSpec {
  type: FieldType;
  flags: string;
  description: string;
  /** Key parsed by Commander; inferred from flags by default. */
  rawKey?: string;
  /** API request body field name; defaults to the key in fields. */
  apiName?: string;
  default?: unknown;
  choices?: readonly (string | number)[];
  required?: boolean;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  validate?: (value: unknown) => string | null;
}

export type ModelFieldSpec = BaseFieldSpec;

export interface ModelSpecData {
  prompt: PromptSpec;
  fields: Record<string, ModelFieldSpec>;
}

export interface ModelSchema {
  defaultModel: string;
  models: Record<string, ModelSpecData>;
  /** When true, unknown models reuse default model validation for legacy arbitrary model passthrough. */
  allowUnknownModel?: boolean;
}

export type ModelGenOptions = Record<string, unknown> & { model: string };

const collect = (value: string, previous: string[]): string[] => previous.concat([value]);

function rawKeyFromFlags(flags: string): string {
  const long = flags
    .split(/[,\s]+/)
    .find((part) => part.startsWith('--'))
    ?.replace(/^--no-/, '')
    .replace(/^--/, '')
    .replace(/[<[].*$/, '');
  if (!long) throw new Error(`Option flags must include a long flag: ${flags}`);
  return long.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function defaultForField(field: ModelFieldSpec): unknown {
  if (field.default !== undefined) return field.default;
  if (field.type === 'stringArray' || field.type === 'urlArray') return [];
  return undefined;
}

function fieldChoicesAsStrings(field: ModelFieldSpec): string[] | undefined {
  return field.choices?.map(String);
}

function mergeFieldForCommander(current: ModelFieldSpec, next: ModelFieldSpec): ModelFieldSpec {
  if (!current.choices && !next.choices) return current;
  const choices = new Set<string>();
  for (const choice of current.choices ?? []) choices.add(String(choice));
  for (const choice of next.choices ?? []) choices.add(String(choice));
  return { ...current, choices: [...choices] };
}

export function buildModelGenOptions(schema: ModelSchema): Option[] {
  return buildModelGenOptionsForFields(schema, collectFieldsForCommander(schema));
}

export function buildModelGenOptionsForModel(schema: ModelSchema, model: string): Option[] {
  const modelSpec = schema.models[model] ?? schema.models[schema.defaultModel];
  const optionDefault = schema.models[model] ? model : schema.defaultModel;
  return buildModelGenOptionsForFields(schema, modelSpec.fields, optionDefault);
}

function buildModelGenOptionsForFields(
  schema: ModelSchema,
  fieldsForCommand: Record<string, ModelFieldSpec> | Map<string, ModelFieldSpec>,
  modelDefault: string = schema.defaultModel,
): Option[] {
  const modelNames = Object.keys(schema.models);
  const options: Option[] = [
    new Option('-m, --model <model>', 'model name').default(modelDefault),
  ];
  if (!schema.allowUnknownModel) options[0].choices(modelNames);

  const fields =
    fieldsForCommand instanceof Map ? fieldsForCommand : new Map(Object.entries(fieldsForCommand));
  for (const field of fields.values()) {
    const option = new Option(field.flags, field.description);
    const choices = fieldChoicesAsStrings(field);
    if (choices) option.choices(choices);
    const fallback = defaultForField(field);
    if (fallback !== undefined) option.default(fallback);
    if (field.type === 'stringArray' || field.type === 'urlArray') option.argParser(collect);
    options.push(option);
  }
  return options;
}

function collectFieldsForCommander(schema: ModelSchema): Map<string, ModelFieldSpec> {
  const fields = new Map<string, ModelFieldSpec>();
  for (const model of Object.values(schema.models)) {
    for (const [key, field] of Object.entries(model.fields)) {
      const current = fields.get(key);
      fields.set(key, current ? mergeFieldForCommander(current, field) : field);
    }
  }
  return fields;
}

export function parseModelGenOptions(schema: ModelSchema, raw: Record<string, unknown>): ModelGenOptions {
  const model = String(raw.model ?? schema.defaultModel);
  const modelSpec = schema.models[model] ?? schema.models[schema.defaultModel];
  const parsed: ModelGenOptions = { model };
  for (const [key, field] of Object.entries(modelSpec.fields)) {
    const rawKey = field.rawKey ?? rawKeyFromFlags(field.flags);
    const value = raw[rawKey] ?? defaultForField(field);
    if (field.type === 'integer' || field.type === 'float') {
      parsed[key] = value === undefined || value === null || value === '' ? undefined : Number(value);
    } else if (field.type === 'bool') {
      parsed[key] = Boolean(value);
    } else if (field.type === 'stringArray' || field.type === 'urlArray') {
      parsed[key] = Array.isArray(value) ? value : [];
    } else if (typeof value === 'string') {
      const trimmed = value.trim();
      parsed[key] = trimmed.length > 0 ? trimmed : undefined;
    } else {
      parsed[key] = value;
    }
  }
  return parsed;
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

export function validateModelGen(
  schema: ModelSchema,
  prompt: string,
  opts: ModelGenOptions,
): string[] {
  const errors: string[] = [];
  const modelSpec = schema.models[opts.model];
  const effectiveSpec = modelSpec ?? schema.models[schema.defaultModel];

  const minLength = effectiveSpec.prompt.minLength ?? 1;
  if (prompt.trim().length < minLength) errors.push('Prompt must not be empty');
  const maxLength = effectiveSpec.prompt.maxLength;
  if (maxLength !== undefined && prompt.length > maxLength) {
    errors.push(`Prompt is too long (${prompt.length} chars, max ${maxLength})`);
  }
  const modelName = opts.model.trim();
  if (!modelName) errors.push('Model must not be empty');
  if (modelName && !modelSpec && !schema.allowUnknownModel) {
    errors.push(`Unknown model: ${opts.model}`);
  }

  for (const [key, field] of Object.entries(effectiveSpec.fields)) {
    const value = opts[key];
    const name = field.apiName ?? key;
    const isEmpty = value === undefined
      || value === null
      || (typeof value === 'string' && value.trim().length === 0)
      || (Array.isArray(value) && value.length === 0);
    if (field.required && isEmpty) errors.push(`${name} is required`);
    if (field.choices && value !== undefined && !field.choices.map(String).includes(String(value))) {
      errors.push(`${key} must be one of: ${field.choices.join(', ')}`);
    }
    if (typeof value === 'number') {
      if (field.min !== undefined && value < field.min) errors.push(`${key} must be >= ${field.min}`);
      if (field.max !== undefined && value > field.max) errors.push(`${key} must be <= ${field.max}`);
    }
    if (typeof value === 'string') {
      if (field.minLength !== undefined && value.length < field.minLength) {
        errors.push(`${key} must be at least ${field.minLength} characters`);
      }
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        errors.push(`${key} must be at most ${field.maxLength} characters`);
      }
    }
    if (field.type === 'url' && typeof value === 'string' && !isValidUrl(value)) {
      errors.push(`${name} must be a valid URL`);
    }
    if ((field.type === 'stringArray' || field.type === 'urlArray') && Array.isArray(value)) {
      if (field.minItems !== undefined && value.length < field.minItems) {
        errors.push(`Too few ${name}: min ${field.minItems}, got ${value.length}`);
      }
      if (field.maxItems !== undefined && value.length > field.maxItems) {
        errors.push(`Too many ${name}: max ${field.maxItems}, got ${value.length}`);
      }
      if (field.type === 'urlArray') {
        for (const item of value) {
          if (typeof item !== 'string' || !isValidUrl(item)) {
            errors.push(`${name} must contain only valid URLs: ${String(item)}`);
          }
        }
      }
    }
    const customError = field.validate?.(value);
    if (customError) errors.push(customError);
  }
  return errors;
}

function setNested(body: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  const finalKey = parts.pop();
  if (!finalKey) return;

  let target = body;
  for (const part of parts) {
    const current = target[part];
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      target[part] = {};
    }
    target = target[part] as Record<string, unknown>;
  }
  target[finalKey] = value;
}

export function buildModelCreateRequest(
  schema: ModelSchema,
  prompt: string,
  opts: ModelGenOptions,
): Record<string, unknown> {
  const modelSpec = schema.models[opts.model] ?? schema.models[schema.defaultModel];
  const body: Record<string, unknown> = { model: opts.model, prompt };
  for (const [key, field] of Object.entries(modelSpec.fields)) {
    const value = opts[key];
    if (value === undefined) continue;
    if (typeof value === 'number' && Number.isNaN(value)) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    setNested(body, field.apiName ?? key, value);
  }
  return body;
}
