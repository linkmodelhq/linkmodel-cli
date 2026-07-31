import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiError, AuthError, LinkmodelClient, NetworkError } from '../src/api/client.js';
import { PACKAGE_NAME, VERSION } from '../src/generated/version.js';

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response> | Response;

function makeClient(handler: FetchHandler, extra?: { sleeps?: number[] }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as unknown as typeof fetch;
  const client = new LinkmodelClient({
    apiKey: 'test-key',
    baseUrl: 'https://api.test/api/v1',
    fetchImpl,
    sleep: async (ms) => {
      extra?.sleeps?.push(ms);
    },
  });
  return { client, calls };
}

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('createTask:POST path, Bearer header, request body, msg envelope', async () => {
  const { client, calls } = makeClient(() =>
    jsonResponse(200, {
      code: 0,
      msg: 'success',
      data: { task_id: 't-1', price: 0.074 },
      request_id: 'r-create',
    }),
  );
  const env = await client.createTask('/image-generation', {
    model: 'gpt-image-2',
    prompt: 'a cat',
    quality: 'medium',
    size: 'auto',
    images: ['https://x/1.png'],
  });
  assert.equal(env.data.task_id, 't-1');
  assert.equal(env.data.price, 0.074);
  assert.equal(env.message, 'success');
  assert.equal(env.requestId, 'r-create');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.test/api/v1/image-generation');
  assert.equal(calls[0].init?.method, 'POST');
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer test-key');
  assert.equal(headers.Accept, 'application/json');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(headers['User-Agent'], `${PACKAGE_NAME}/${VERSION}`);
  assert.equal(headers['X-LinkModel-Client'], 'cli');
  assert.equal(headers['X-LinkModel-Client-Version'], VERSION);
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    model: 'gpt-image-2',
    prompt: 'a cat',
    quality: 'medium',
    size: 'auto',
    images: ['https://x/1.png'],
  });
});

test('queryTask:GET path includes task_id, message envelope', async () => {
  const { client, calls } = makeClient(() =>
    jsonResponse(200, {
      code: 0,
      message: 'ok',
      data: { status: 'Success', output_images: ['https://x/1.png'] },
      request_id: 'r-q',
    }),
  );
  const env = await client.queryTask('/query/image-generation', 'task/with space');
  assert.equal(env.data.status, 'Success');
  assert.equal(env.message, 'ok');
  assert.equal(calls[0].init?.method, 'GET');
  assert.match(calls[0].url, /\/query\/image-generation\?task_id=/);
  assert.ok(calls[0].url.includes(encodeURIComponent('task/with space')));
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers['User-Agent'], `${PACKAGE_NAME}/${VERSION}`);
  assert.equal(headers['X-LinkModel-Client'], 'cli');
  assert.equal(headers['X-LinkModel-Client-Version'], VERSION);
  assert.equal(headers['Content-Type'], undefined);
});

test('unknown task status throws ApiError with request_id and is not silently accepted', async () => {
  const { client } = makeClient(() =>
    jsonResponse(200, { code: 0, message: 'ok', data: { status: 'Weird' }, request_id: 'r-w' }),
  );
  await assert.rejects(client.queryTask('/query/image-generation', 't'), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.match(err.message, /Unknown task status/);
    assert.match(err.message, /r-w/);
    return true;
  });
});

test('401 -> AuthError, no retry, message includes request_id', async () => {
  const { client, calls } = makeClient(() =>
    jsonResponse(401, { code: 401, msg: 'invalid key', request_id: 'r-401' }),
  );
  await assert.rejects(client.createTask('/image-generation', { model: 'm', prompt: 'p' }), (err: unknown) => {
    assert.ok(err instanceof AuthError);
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 401);
    assert.match(err.message, /invalid key/);
    assert.match(err.message, /r-401/);
    return true;
  });
  assert.equal(calls.length, 1);
});

test('4xx responses such as 400 and 429 are never retried', async () => {
  for (const status of [400, 429]) {
    const { client, calls } = makeClient(() => jsonResponse(status, { code: status, msg: 'bad' }));
    await assert.rejects(client.createTask('/image-generation', { model: 'm', prompt: 'p' }), ApiError);
    assert.equal(calls.length, 1, `status ${status} should not retry`);
  }
});

test('5xx uses exponential backoff retries(500ms→1s),returns after third attempt succeeds', async () => {
  const sleeps: number[] = [];
  let n = 0;
  const { client, calls } = makeClient(
    () => {
      n++;
      return n < 3
        ? jsonResponse(500, { code: 500, msg: 'server error', request_id: `r-${n}` })
        : jsonResponse(200, { code: 0, msg: 'ok', data: { task_id: 't-9' } });
    },
    { sleeps },
  );
  const env = await client.createTask('/image-generation', { model: 'm', prompt: 'p' });
  assert.equal(env.data.task_id, 't-9');
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [500, 1000]);
});

test('persistent 5xx failure throws after initial request plus 3 retries', async () => {
  const sleeps: number[] = [];
  const { client, calls } = makeClient(
    () => jsonResponse(502, { code: 502, msg: 'bad gateway', request_id: 'r-502' }),
    { sleeps },
  );
  await assert.rejects(client.createTask('/image-generation', { model: 'm', prompt: 'p' }), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal((err as ApiError).status, 502);
    return true;
  });
  assert.equal(calls.length, 4);
  assert.deepEqual(sleeps, [500, 1000, 2000]);
});

test('network errors also use exponential backoff retries', async () => {
  const sleeps: number[] = [];
  let n = 0;
  const { client, calls } = makeClient(
    () => {
      n++;
      if (n < 3) throw new TypeError('fetch failed');
      return jsonResponse(200, { code: 0, msg: 'ok', data: { task_id: 't-7' } });
    },
    { sleeps },
  );
  const env = await client.createTask('/image-generation', { model: 'm', prompt: 'p' });
  assert.equal(env.data.task_id, 't-7');
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [500, 1000]);
});

test('network errors throw NetworkError after retries are exhausted', async () => {
  const { client, calls } = makeClient(() => {
    throw new TypeError('fetch failed');
  });
  await assert.rejects(client.createTask('/image-generation', { model: 'm', prompt: 'p' }), NetworkError);
  assert.equal(calls.length, 4);
});

// Real regression case: AbortSignal still applies after response headers arrive. Earlier, res.text() lived outside the try,
// so a raw TimeoutError during body read was not wrapped as NetworkError and therefore was never retried.
// It bubbled up as failure even though the server task had succeeded. 97 passing tests did not catch it,
// because mocks only failed the whole request and never simulated headers returned but body failed.
test('response headers returned but body read failed -> still wraps as NetworkError and retries', async () => {
  const { client, calls } = makeClient(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );
  await assert.rejects(
    client.createTask('/image-generation', { model: 'm', prompt: 'p' }),
    (err: unknown) => {
      assert.ok(err instanceof NetworkError, `expected NetworkError, got ${(err as Error).name}`);
      assert.match((err as Error).message, /image-generation/, 'error message should include URL');
      return true;
    },
  );
  assert.equal(calls.length, 4, 'body read failure should also trigger retries (initial request plus 3 retries)');
});

test('2xx invalid envelope throws instead of silently accepting', async () => {
  const { client } = makeClient(() => new Response('<html>oops</html>', { status: 200 }));
  await assert.rejects(client.createTask('/image-generation', { model: 'm', prompt: 'p' }), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.match(err.message, /Invalid envelope/);
    return true;
  });
});

test('HTTP 200 + non-zero business code such as insufficient balance -> ApiError with msg/request_id and no retry', async () => {
  const { client, calls } = makeClient(() =>
    jsonResponse(200, {
      code: 500,
      msg: 'create task failed: billing: code=100601: insufficient balance',
      request_id: 'r-billing',
    }),
  );
  await assert.rejects(client.createTask('/image-generation', { model: 'm', prompt: 'p' }), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.ok(!(err instanceof AuthError));
    assert.equal((err as ApiError).status, 200); // business error, does not trigger 5xx retries
    assert.match(err.message, /error code 500/); // business code information is not hidden by msg
    assert.match(err.message, /insufficient balance/);
    assert.match(err.message, /r-billing/);
    return true;
  });
  assert.equal(calls.length, 1);
});

test('HTTP 200 + missing code + msg success combines reason with server message and never emits bare success', async () => {
  const { client, calls } = makeClient(() =>
    jsonResponse(200, { msg: 'success', data: { task_id: 't-1' }, request_id: 'no-code-case' }),
  );
  await assert.rejects(client.createTask('/image-generation', { model: 'm', prompt: 'p' }), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    // Includes both the missing-code explanation and server msg context.
    assert.match(err.message, /Response missing code field/);
    assert.match(err.message, /server message: success/);
    assert.match(err.message, /no-code-case/);
    assert.ok(!err.message.startsWith('success'), 'must not degrade to success only');
    return true;
  });
  assert.equal(calls.length, 1);
});

test('HTTP 200 + auth business code 401 -> AuthError (exit 3), no retry', async () => {
  const { client, calls } = makeClient(() =>
    jsonResponse(200, { code: 401, msg: 'token expired', request_id: 'r-bauth' }),
  );
  await assert.rejects(client.queryTask('/query/image-generation', 't'), (err: unknown) => {
    assert.ok(err instanceof AuthError);
    assert.match(err.message, /token expired/);
    assert.match(err.message, /r-bauth/);
    return true;
  });
  assert.equal(calls.length, 1);
});

test('HTTP 200 with missing code is treated as invalid rather than success', async () => {
  const { client, calls } = makeClient(() => jsonResponse(200, { data: { task_id: 't-1' } }));
  await assert.rejects(client.createTask('/image-generation', { model: 'm', prompt: 'p' }), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.match(err.message, /Response missing code field/);
    return true;
  });
  assert.equal(calls.length, 1);
});
