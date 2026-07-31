import type { ModelFieldSpec, ModelSchema, PromptSpec } from '../modalities/model-schema.js';
import type { DisplayModel, UpstreamField, UpstreamParameterSchema } from './client.js';

export type SchemaByModel = Readonly<Record<string, UpstreamParameterSchema>>;

function fieldsForSchema(schema: UpstreamParameterSchema | undefined): UpstreamField[] {
  if (!schema) return [];
  if (Array.isArray(schema.fields)) return schema.fields;
  if (Array.isArray(schema.parameters)) return schema.parameters;
  for (const key of ['data', 'schema']) {
    const nested = schema[key];
    if (nested && typeof nested === 'object') return fieldsForSchema(nested as UpstreamParameterSchema);
  }
  return [];
}

function modelSupportsMode(model: DisplayModel, mode: 'image' | 'video'): boolean {
  const candidates = [model.mode_type, model.mode, model.type]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.toLowerCase());
  return candidates.some((value) => value === mode);
}

function fieldType(field: UpstreamField): ModelFieldSpec['type'] {
  const constraints = field.constraints ?? {};
  const itemFormat = typeof constraints.item_format === 'string' ? constraints.item_format : field.item_format;
  const format = typeof constraints.format === 'string' ? constraints.format : field.format;
  switch (field.type) {
    case 'int': return 'integer';
    case 'float': return 'float';
    case 'bool': return 'bool';
    case 'array': return itemFormat === 'url' ? 'urlArray' : 'stringArray';
    case 'object': return 'object';
    case 'string': return format === 'url' ? 'url' : 'string';
    default: return 'string';
  }
}

function fieldFlags(name: string, type: ModelFieldSpec['type']): string {
  const flag = `--${name.replace(/[_.]/g, '-')}`;
  if (type === 'bool') return flag;
  if (type === 'url') return `${flag} <url>`;
  if (type === 'urlArray') return `${flag} <url...>`;
  if (type === 'stringArray') return `${flag} <value...>`;
  return `${flag} <value>`;
}

function numberValue(field: UpstreamField, names: string[]): number | undefined {
  for (const name of names) {
    const value = field[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const constraintValue = field.constraints?.[name];
    if (typeof constraintValue === 'number' && Number.isFinite(constraintValue)) return constraintValue;
  }
  return undefined;
}

function choices(field: UpstreamField): readonly (string | number)[] | undefined {
  const values = field.enum_values ?? field.constraints?.enum_values ?? field.enum ?? field.choices;
  if (!Array.isArray(values) || !values.every((value) => typeof value === 'string' || typeof value === 'number')) return undefined;
  return values;
}

function defaultValue(field: UpstreamField): unknown {
  return field.default ?? field.constraints?.default;
}

function toFieldSpec(field: UpstreamField): ModelFieldSpec {
  const type = fieldType(field);
  const fallback = defaultValue(field);
  return {
    type,
    flags: fieldFlags(field.name, type),
    description: field.description ?? field.ui?.label ?? field.name,
    ...(fallback !== undefined ? { default: fallback } : {}),
    ...(field.required === true ? { required: true } : {}),
    ...(choices(field) ? { choices: choices(field) } : {}),
    ...(numberValue(field, ['min', 'minimum']) !== undefined ? { min: numberValue(field, ['min', 'minimum']) } : {}),
    ...(numberValue(field, ['max', 'maximum']) !== undefined ? { max: numberValue(field, ['max', 'maximum']) } : {}),
    ...(numberValue(field, ['min_length']) !== undefined ? { minLength: numberValue(field, ['min_length']) } : {}),
    ...(numberValue(field, ['max_length']) !== undefined ? { maxLength: numberValue(field, ['max_length']) } : {}),
    ...(numberValue(field, ['array_min_length']) !== undefined ? { minItems: numberValue(field, ['array_min_length']) } : {}),
    ...(numberValue(field, ['array_max_length']) !== undefined ? { maxItems: numberValue(field, ['array_max_length']) } : {}),
  };
}

function promptSpec(fields: UpstreamField[]): PromptSpec {
  const prompt = fields.find((field) => field.name === 'prompt');
  if (!prompt) return { minLength: 1 };
  return {
    minLength: numberValue(prompt, ['min_length']) ?? 1,
    ...(numberValue(prompt, ['max_length']) !== undefined
      ? { maxLength: numberValue(prompt, ['max_length']) }
      : {}),
  };
}

function fieldsForModel(schema: UpstreamParameterSchema | undefined): Record<string, ModelFieldSpec> {
  const fields = fieldsForSchema(schema);
  const names = new Set(fields.map((field) => field.name));
  return Object.fromEntries(
    fields
      .filter((field) => field.name && field.name !== 'model' && field.name !== 'prompt')
      .filter((field) => field.type !== 'object' || ![...names].some((name) => name.startsWith(`${field.name}.`)))
      .map((field) => [field.name, toFieldSpec(field)]),
  );
}

export function toModelSchema(
  mode: 'image' | 'video',
  models: readonly DisplayModel[],
  schemas: SchemaByModel,
): ModelSchema {
  const selected = models.filter((model) => modelSupportsMode(model, mode)).sort((a, b) => a.name.localeCompare(b.name));
  const defaultName = mode === 'image' ? 'gpt-image-2' : 'kling-v3';
  const defaultModel = selected.some((model) => model.name === defaultName) ? defaultName : selected[0]?.name ?? defaultName;
  return {
    defaultModel,
    models: Object.fromEntries(selected.map((model) => {
      const fields = fieldsForSchema(schemas[model.name]);
      return [model.name, { prompt: promptSpec(fields), fields: fieldsForModel(schemas[model.name]) }];
    })),
  };
}
