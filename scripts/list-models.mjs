const baseUrl = 'https://server.linkmodel.ai/auroraai/v1';

async function request(path) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { Accept: 'application/json' } });
  const envelope = await response.json();
  if (!response.ok || envelope.code !== 0 || envelope.data == null) {
    throw new Error(envelope.msg || `Upstream request failed (HTTP ${response.status})`);
  }
  return envelope.data;
}

function itemsForPage(data) {
  return Array.isArray(data) ? data : data.items ?? data.list ?? data.models ?? [];
}

const firstPage = await request('/display-models?lang=en&page=1&page_size=100');
const models = itemsForPage(firstPage);
const total = Array.isArray(firstPage) ? models.length : firstPage.total ?? models.length;
for (let page = 2; models.length < total; page++) {
  const data = await request(`/display-models?lang=en&page=${page}&page_size=100`);
  const items = itemsForPage(data);
  if (items.length === 0) break;
  models.push(...items);
}
for (const model of models) {
  const taskTypes = Array.isArray(model.task_types) ? model.task_types.join(',') : '';
  const mode = typeof model.mode_type === 'string'
    ? model.mode_type
    : typeof model.mode === 'string'
      ? model.mode
      : '';
  const provider = typeof model.provider === 'string'
    ? model.provider
    : typeof model.provider?.name === 'string'
      ? model.provider.name
      : '';
  if (mode === 'image' || mode === 'video') {
    console.log([mode, model.name, provider, taskTypes].join('\t'));
  }
}
