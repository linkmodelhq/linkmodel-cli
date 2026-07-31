import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const baseUrl = 'https://server.linkmodel.ai/auroraai/v1';

async function request(path) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { Accept: 'application/json' } });
  const envelope = await response.json();
  if (!response.ok || envelope.code !== 0 || envelope.data == null) {
    throw new Error(envelope.msg || `Upstream request failed (HTTP ${response.status})`);
  }
  return envelope.data;
}

function fieldsForSchema(schema) {
  if (Array.isArray(schema?.fields)) return schema.fields;
  if (Array.isArray(schema?.parameters)) return schema.parameters;
  if (schema?.data && typeof schema.data === 'object') return fieldsForSchema(schema.data);
  if (schema?.schema && typeof schema.schema === 'object') return fieldsForSchema(schema.schema);
  return [];
}

function supportsMode(model, mode) {
  const values = [model.mode_type, model.mode, model.type];
  return values.some((value) => typeof value === 'string' && value.toLowerCase() === mode);
}

function fieldType(field) {
  const constraints = field.constraints ?? {};
  const itemFormat = typeof constraints.item_format === 'string' ? constraints.item_format : field.item_format;
  const format = typeof constraints.format === 'string' ? constraints.format : field.format;
  if (field.type === 'int') return 'integer';
  if (field.type === 'float') return 'float';
  if (field.type === 'bool') return 'bool';
  if (field.type === 'array') return itemFormat === 'url' ? 'urlArray' : 'stringArray';
  if (field.type === 'object') return 'object';
  return format === 'url' ? 'url' : 'string';
}

function fieldFlags(name, type) {
  const flag = `--${name.replace(/[_.]/g, '-')}`;
  if (type === 'bool') return flag;
  if (type === 'url') return `${flag} <url>`;
  if (type === 'urlArray') return `${flag} <url...>`;
  if (type === 'stringArray') return `${flag} <value...>`;
  return `${flag} <value>`;
}

function numberValue(field, names) {
  for (const name of names) {
    if (typeof field[name] === 'number' && Number.isFinite(field[name])) return field[name];
    const constraintValue = field.constraints?.[name];
    if (typeof constraintValue === 'number' && Number.isFinite(constraintValue)) return constraintValue;
  }
  return undefined;
}

function choices(field) {
  const values = field.enum_values ?? field.constraints?.enum_values ?? field.enum ?? field.choices;
  return Array.isArray(values) && values.every((value) => typeof value === 'string' || typeof value === 'number')
    ? values
    : undefined;
}

function defaultValue(field) {
  return field.default ?? field.constraints?.default;
}

function modelSchema(mode, models, schemas) {
  const selected = models.filter((model) => supportsMode(model, mode)).sort((a, b) => a.name.localeCompare(b.name));
  const preferredDefault = mode === 'image' ? 'gpt-image-2' : 'kling-v3';
  const defaultModel = selected.some((model) => model.name === preferredDefault) ? preferredDefault : selected[0]?.name ?? preferredDefault;
  const entries = selected.map((model) => {
    const allFields = fieldsForSchema(schemas[model.name]);
    const names = new Set(allFields.map((field) => field.name));
    const prompt = allFields.find((field) => field.name === 'prompt');
    const fields = {};
    for (const field of allFields.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!field.name || field.name === 'model' || field.name === 'prompt') continue;
      if (field.type === 'object' && [...names].some((name) => name.startsWith(`${field.name}.`))) continue;
      const type = fieldType(field);
      const spec = { type, flags: fieldFlags(field.name, type), description: field.description ?? field.ui?.label ?? field.name };
      const fallback = defaultValue(field);
      if (fallback !== undefined) spec.default = fallback;
      if (field.required === true) spec.required = true;
      const choiceValues = choices(field);
      if (choiceValues) spec.choices = choiceValues;
      for (const [source, target] of [['min', 'min'], ['minimum', 'min'], ['max', 'max'], ['maximum', 'max'], ['min_length', 'minLength'], ['max_length', 'maxLength'], ['array_min_length', 'minItems'], ['array_max_length', 'maxItems']]) {
        const value = numberValue(field, [source]);
        if (value !== undefined && spec[target] === undefined) spec[target] = value;
      }
      fields[field.name] = spec;
    }
    const promptSpec = { minLength: numberValue(prompt ?? {}, ['min_length']) ?? 1 };
    const maxLength = numberValue(prompt ?? {}, ['max_length']);
    if (maxLength !== undefined) promptSpec.maxLength = maxLength;
    return [model.name, { prompt: promptSpec, fields }];
  });
  return { defaultModel, models: Object.fromEntries(entries) };
}

const firstPage = await request('/display-models?lang=en&page=1&page_size=100');
const models = Array.isArray(firstPage) ? firstPage : firstPage.items ?? firstPage.list ?? firstPage.models ?? [];
const total = Array.isArray(firstPage) ? models.length : firstPage.total ?? models.length;
for (let page = 2; models.length < total; page++) {
  const data = await request(`/display-models?lang=en&page=${page}&page_size=100`);
  const items = Array.isArray(data) ? data : data.items ?? data.list ?? data.models ?? [];
  if (items.length === 0) break;
  models.push(...items);
}
const schemas = {};
for (const model of [...models].sort((a, b) => a.name.localeCompare(b.name))) {
  schemas[model.name] = await request(`/display-models/${encodeURIComponent(model.name)}/parameter-schema?lang=en`);
}

const image = modelSchema('image', models, schemas);
const video = modelSchema('video', models, schemas);
const source = [
  '// Generated by npm run build:all. Do not edit manually.',
  "import type { ModelSchema } from '../modalities/model-schema.js';",
  '',
  `export const GENERATED_IMAGE_MODEL_SCHEMA: ModelSchema = ${JSON.stringify(image, null, 2)};`,
  '',
  `export const GENERATED_VIDEO_MODEL_SCHEMA: ModelSchema = ${JSON.stringify(video, null, 2)};`,
  '',
].join('\n');
await writeFile(fileURLToPath(new URL('../src/generated/model-schemas.ts', import.meta.url)), source);
