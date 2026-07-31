export const UPSTREAM_BASE_URL = 'https://server.linkmodel.ai/auroraai/v1';
const DISPLAY_MODELS_PAGE_SIZE = 100;

export interface DisplayModel {
  name: string;
  mode_type?: string;
  mode?: string;
  provider?: string;
  task_types?: string[];
  [key: string]: unknown;
}

export interface UpstreamField {
  name: string;
  type: string;
  description?: string;
  default?: unknown;
  required?: boolean;
  format?: string;
  item_format?: string;
  enum_values?: unknown[];
  enum?: unknown[];
  choices?: unknown[];
  constraints?: Record<string, unknown>;
  min?: number;
  max?: number;
  minimum?: number;
  maximum?: number;
  min_length?: number;
  max_length?: number;
  array_min_length?: number;
  array_max_length?: number;
  ui?: { label?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface UpstreamParameterSchema {
  fields?: UpstreamField[];
  parameters?: UpstreamField[];
  [key: string]: unknown;
}

interface UpstreamEnvelope<T> {
  code?: unknown;
  data?: T;
  msg?: unknown;
  request_id?: unknown;
}

function errorMessage(prefix: string, envelope?: UpstreamEnvelope<unknown>): string {
  const message = typeof envelope?.msg === 'string' ? `: ${envelope.msg}` : '';
  const requestId = typeof envelope?.request_id === 'string'
    ? ` (request_id: ${envelope.request_id})`
    : '';
  return `${prefix}${message}${requestId}`;
}

async function fetchEnvelope<T>(path: string, fetchImpl: typeof fetch): Promise<T> {
  const response = await fetchImpl(`${UPSTREAM_BASE_URL}${path}`, {
    headers: { Accept: 'application/json' },
  });
  let envelope: UpstreamEnvelope<T>;
  try {
    envelope = await response.json() as UpstreamEnvelope<T>;
  } catch {
    throw new Error(`Invalid upstream response (HTTP ${response.status})`);
  }
  if (!response.ok) throw new Error(errorMessage(`Upstream request failed (HTTP ${response.status})`, envelope));
  if (envelope.code !== 0) throw new Error(errorMessage(`Upstream returned error code ${String(envelope.code)}`, envelope));
  if (envelope.data === undefined || envelope.data === null) {
    throw new Error(errorMessage('Upstream response missing data', envelope));
  }
  return envelope.data;
}

function pageItems(data: unknown): DisplayModel[] {
  if (Array.isArray(data)) return data.filter(isDisplayModel);
  if (!data || typeof data !== 'object') return [];
  const record = data as Record<string, unknown>;
  for (const key of ['items', 'list', 'models']) {
    if (Array.isArray(record[key])) return record[key].filter(isDisplayModel);
  }
  return [];
}

function pageTotal(data: unknown, fallback: number): number {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fallback;
  const total = (data as Record<string, unknown>).total;
  return typeof total === 'number' && Number.isFinite(total) && total >= 0 ? total : fallback;
}

function isDisplayModel(value: unknown): value is DisplayModel {
  return !!value && typeof value === 'object' && typeof (value as { name?: unknown }).name === 'string';
}

export async function fetchDisplayModels(fetchImpl: typeof fetch = fetch): Promise<DisplayModel[]> {
  const models: DisplayModel[] = [];
  let page = 1;
  let total = Number.POSITIVE_INFINITY;
  while (models.length < total) {
    const data = await fetchEnvelope<unknown>(
      `/display-models?lang=en&page=${page}&page_size=${DISPLAY_MODELS_PAGE_SIZE}`,
      fetchImpl,
    );
    const items = pageItems(data);
    total = pageTotal(data, models.length + items.length);
    models.push(...items);
    if (items.length === 0) break;
    page++;
  }
  return models;
}

export function fetchParameterSchema(
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UpstreamParameterSchema> {
  return fetchEnvelope<UpstreamParameterSchema>(
    `/display-models/${encodeURIComponent(name)}/parameter-schema?lang=en`,
    fetchImpl,
  );
}
