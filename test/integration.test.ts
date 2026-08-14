import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Compiled artifact path: .test-dist/test/integration.test.js -> .test-dist/src/cli.js
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

/** Override schedule: skip the 10s quiet period and poll every 50ms so integration tests finish quickly. */
const FAST_SCHEDULE = JSON.stringify([{ until: 0, interval: 50 }]);

// ---------- mock linkmodel server ----------

const counts = { authCheck: 0, create: 0, query: 0 };
let origin = '';
let server: http.Server;

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://placeholder');

  // All /api/v1 endpoints require Bearer test-key.
  if (url.pathname.startsWith('/api/v1/') && req.headers.authorization !== 'Bearer test-key') {
    return sendJson(res, 401, { code: 401, msg: 'Invalid API key', request_id: 'r-401' });
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/auth/check') {
    counts.authCheck++;
    return sendJson(res, 200, {
      code: 0,
      msg: 'success',
      data: { valid: true },
      request_id: 'r-auth-check',
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/image-generation') {
    counts.create++;
    const body = JSON.parse(await readBody(req));
    const { prompt } = body;
    if (prompt === 'seedream-case') {
      if (body.model !== 'seedream-4.5' || body.max_images !== 2) {
        return sendJson(res, 400, {
          code: 400,
          msg: `unexpected seedream body: ${JSON.stringify(body)}`,
          request_id: 'r-seedream-body',
        });
      }
      return sendJson(res, 200, {
        code: 0,
        msg: 'success',
        data: { task_id: 'task-ok', price: 0.074 },
        request_id: 'r-create',
      });
    }
    // HTTP 200 + non-zero business code:insufficient balance(real regression case; do not hide it)
    if (prompt === 'billing-case') {
      return sendJson(res, 200, {
        code: 500,
        msg: 'create task failed: billing: code=100601: insufficient balance',
        request_id: 'r-billing',
      });
    }
    // HTTP 200 + auth business code:maps to AuthError → exit code 3
    if (prompt === 'biz-auth-case') {
      return sendJson(res, 200, { code: 401, msg: 'token expired', request_id: 'r-bauth' });
    }
    // HTTP 200 + missing code + msg success is an easy path to accidentally produce "✖ success".
    if (prompt === 'no-code-case') {
      return sendJson(res, 200, {
        msg: 'success',
        data: { task_id: 'task-no-code' },
        request_id: 'no-code-case',
      });
    }
    const taskId =
      prompt === 'fail-case'
        ? 'task-fail'
        : prompt === 'cancel-case'
          ? 'task-cancel'
          : prompt === 'timeout-case'
            ? 'task-slow'
            : prompt === 'partial-case'
              ? 'task-partial'
              : 'task-ok';
    // Create endpoint uses msg; free-case simulates price 0 because billing may settle after completion.
    const price = prompt === 'free-case' ? 0 : 0.074;
    return sendJson(res, 200, {
      code: 0,
      msg: 'success',
      data: { task_id: taskId, price },
      request_id: 'r-create',
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/video-generation') {
    counts.create++;
    const body = JSON.parse(await readBody(req));
    if (body.prompt === 'kling-case') {
      if (
        body.model !== 'kling-v3'
        || body.extends?.cfg_scale !== 0.7
        || body.extends?.audio !== true
      ) {
        return sendJson(res, 400, {
          code: 400,
          msg: `unexpected kling body: ${JSON.stringify(body)}`,
          request_id: 'r-kling-body',
        });
      }
      return sendJson(res, 200, {
        code: 0,
        msg: 'success',
        data: { task_id: 'video-ok', order_id: 'order-video', status: 'processing', price: 3.87 },
        request_id: 'r-video-create',
      });
    }
    const taskId = body.prompt === 'video-timeout-case' ? 'video-slow' : 'video-ok';
    return sendJson(res, 200, {
      code: 0,
      msg: 'success',
      data: { task_id: taskId, order_id: 'order-video', status: 'processing', price: 3.87 },
      request_id: 'r-video-create',
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/query/image-generation') {
    counts.query++;
    const taskId = url.searchParams.get('task_id');
    // Query endpoint uses message, covering the other half of envelope compatibility.
    if (taskId === 'task-ok') {
      return sendJson(res, 200, {
        code: 0,
        message: 'ok',
        data: {
          task_id: taskId,
          status: 'Success',
          output_images: [`${origin}/img/1.png`, `${origin}/img/2.png`],
        },
        request_id: 'r-q',
      });
    }
    if (taskId === 'task-partial') {
      return sendJson(res, 200, {
        code: 0,
        message: 'ok',
        data: {
          task_id: taskId,
          status: 'Success',
          output_images: [`${origin}/img/1.png`, `${origin}/img/404.png`],
        },
        request_id: 'r-q',
      });
    }
    if (taskId === 'task-fail') {
      return sendJson(res, 200, {
        code: 0,
        message: 'ok',
        data: { task_id: taskId, status: 'Failed', msg: 'content policy blocked the task' },
        request_id: 'r-q',
      });
    }
    if (taskId === 'task-cancel') {
      return sendJson(res, 200, {
        code: 0,
        message: 'ok',
        data: { task_id: taskId, status: 'Cancelled' },
        request_id: 'r-q',
      });
    }
    // task-slow and unknown tasks stay Processing forever.
    return sendJson(res, 200, {
      code: 0,
      message: 'ok',
      data: { task_id: taskId, status: 'Processing' },
      request_id: 'r-q',
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/query/video-generation') {
    counts.query++;
    const taskId = url.searchParams.get('task_id');
    if (taskId === 'video-ok') {
      return sendJson(res, 200, {
        code: 0,
        message: 'ok',
        data: {
          task_id: taskId,
          status: 'Success',
          file_url: `${origin}/video/out.mp4`,
        },
        request_id: 'r-video-q',
      });
    }
    return sendJson(res, 200, {
      code: 0,
      message: 'ok',
      data: { task_id: taskId, status: 'Processing' },
      request_id: 'r-video-q',
    });
  }

  if (req.method === 'GET' && (url.pathname === '/img/1.png' || url.pathname === '/img/2.png')) {
    res.writeHead(200, { 'content-type': 'image/png' });
    return res.end(Buffer.from(`PNG-BYTES-${url.pathname.endsWith('1.png') ? 1 : 2}`));
  }
  if (req.method === 'GET' && url.pathname === '/img/404.png') {
    res.writeHead(404);
    return res.end('not found');
  }
  if (req.method === 'GET' && url.pathname === '/video/out.mp4') {
    res.writeHead(200, { 'content-type': 'video/mp4' });
    return res.end(Buffer.from('MP4-BYTES'));
  }

  res.writeHead(404);
  res.end('unknown route');
}

before(async () => {
  server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      res.writeHead(500);
      res.end(String(err));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

// ---------- Run CLI in a subprocess ----------

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  envOverrides: Record<string, string | undefined> = {},
  cliPath: string = CLI,
): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'lm-home-')),
    LINKMODEL_BASE_URL: `${origin}/api/v1`,
    LINKMODEL_POLL_SCHEDULE: FAST_SCHEDULE,
    LINKMODEL_API_KEY: 'test-key',
  };
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lm-out-'));

test('CLI also works when invoked through a symlink, as with npm link or global bin links', async () => {
  // argv[1] is the symlink path while import.meta.url is the real path; the guard must compare realpaths.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-bin-'));
  const link = path.join(dir, 'linkmodel');
  fs.symlinkSync(CLI, link);
  const r = await runCli(['--version'], {}, link);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

// ---------- gen success paths ----------

test('gen end-to-end: create -> poll -> download, exit 0', async () => {
  const out = tmpDir();
  const r = await runCli(['image', 'gen', 'ok-case', '-o', out]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /Task created \(\$0\.074\): task-ok/);
  assert.match(r.stdout, /task-ok-1\.png/);
  assert.match(r.stdout, /task-ok-2\.png/);
  assert.equal(fs.readFileSync(path.join(out, 'task-ok-1.png'), 'utf8'), 'PNG-BYTES-1');
  assert.equal(fs.readFileSync(path.join(out, 'task-ok-2.png'), 'utf8'), 'PNG-BYTES-2');
});

test('gen displays price when > 0 and omits parentheses when price is 0', async () => {
  const paid = await runCli(['image', 'gen', 'ok-case', '--no-wait']);
  assert.match(paid.stderr, /Task created \(\$0\.074\): task-ok/);

  const free = await runCli(['image', 'gen', 'free-case', '--no-wait']);
  assert.equal(free.code, 0, free.stderr);
  assert.match(free.stderr, /Task created: task-ok/);
  assert.ok(!free.stderr.includes('$'), 'price 0 should not be displayed');
});

test('Implicit gen within a modality group:lkm image "<prompt>" ≡ lkm image gen "<prompt>"', async () => {
  const implicit = await runCli(['image', 'ok-case', '--no-wait']);
  assert.equal(implicit.code, 0, implicit.stderr);
  assert.equal(implicit.stdout.trim(), 'task-ok');
  // The explicit form is equivalent.
  const explicit = await runCli(['image', 'gen', 'ok-case', '--no-wait']);
  assert.equal(explicit.code, 0, explicit.stderr);
  assert.equal(explicit.stdout.trim(), 'task-ok');
});

test('video gen end-to-end: create -> poll -> download, exit 0', async () => {
  const out = tmpDir();
  const r = await runCli([
    'video',
    'gen',
    'video-ok-case',
    '-m',
    'seedance-2-0',
    '-o',
    out,
    '-d',
    '8',
    '-r',
    '480P',
    '-s',
    '9x16',
    '--first-frame-image',
    'https://x/first.png',
    '--video',
    'https://x/ref.mp4',
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /Task created \(\$3\.87\): video-ok/);
  assert.match(r.stdout, /video-ok-1\.mp4/);
  assert.equal(fs.readFileSync(path.join(out, 'video-ok-1.mp4'), 'utf8'), 'MP4-BYTES');
});

test('Implicit gen within a modality group:lkm video "<prompt>" ≡ lkm video gen "<prompt>"', async () => {
  const implicit = await runCli(['video', 'video-ok-case', '-m', 'seedance-2-0', '--no-wait']);
  assert.equal(implicit.code, 0, implicit.stderr);
  assert.equal(implicit.stdout.trim(), 'video-ok');
});

test('generated image model option:seedream-4.5 --max-images sends max_images', async () => {
  const r = await runCli([
    'image',
    'gen',
    'seedream-case',
    '-m',
    'seedream-4.5',
    '--max-images',
    '2',
    '--no-wait',
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'task-ok');
});

test('generated video model option:kling-v3 dotted extends sends nested parameters', async () => {
  const r = await runCli([
    'video',
    'gen',
    'kling-case',
    '-m',
    'kling-v3',
    '--extends-cfg-scale',
    '0.7',
    '--extends-audio',
    '--no-wait',
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'video-ok');
});

test('system default video model:uses kling-v3 when no config and no -m are provided', async () => {
  const r = await runCli([
    'video',
    'gen',
    'kling-case',
    '--extends-cfg-scale',
    '0.7',
    '--extends-audio',
    '--no-wait',
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'video-ok');
});

test('config default-image-model:uses configured model and registers its model-specific options when -m is omitted', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-home-'));
  const set = await runCli(['config', 'set', 'default-image-model', 'seedream-4.5'], { HOME: home });
  assert.equal(set.code, 0, set.stderr);
  const r = await runCli([
    'image',
    'gen',
    'seedream-case',
    '--max-images',
    '2',
    '--no-wait',
  ], { HOME: home });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'task-ok');
});

test('config default-video-model:uses configured model and registers dotted parameters when -m is omitted', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-home-'));
  const set = await runCli(['config', 'set', 'default-video-model', 'kling-v3'], { HOME: home });
  assert.equal(set.code, 0, set.stderr);
  const r = await runCli([
    'video',
    'gen',
    'kling-case',
    '--extends-cfg-scale',
    '0.7',
    '--extends-audio',
    '--no-wait',
  ], { HOME: home });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'video-ok');
});

test('lkm image with no args prints group help and exits 0 instead of sending an empty prompt', async () => {
  const createBefore = counts.create;
  const r = await runCli(['image']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Usage: lkm image/);
  assert.equal(counts.create, createBefore, 'must not create a task');
});

test('prompts equal to status or gen require explicit form', async () => {
  // Explicit form: prompt status creates normally.
  const r = await runCli(['image', 'gen', 'status', '--no-wait']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'task-ok');
  // lkm image status missing task_id → usage error exits 2,must not treat status as a prompt
  const createBefore = counts.create;
  const bare = await runCli(['image', 'status']);
  assert.equal(bare.code, 2);
  assert.equal(counts.create, createBefore, 'must not create a task');
  // 'config' still runs the config command and is not treated as a prompt
  await runCli(['config']);
  assert.equal(counts.create, createBefore);
});

test('lkm with no args prints top-level help and exits 0; --help includes implicit gen examples; --version still works', async () => {
  const bare = await runCli([]);
  assert.equal(bare.code, 0);
  assert.match(bare.stdout, /Usage: lkm/);

  const help = await runCli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /lkm setup/);
  assert.match(help.stdout, /lkm doctor/);
  assert.match(help.stdout, /lkm image "a red panda"/);
  assert.match(help.stdout, /gen may be omitted/);

  const ver = await runCli(['--version']);
  assert.equal(ver.code, 0);
  assert.match(ver.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('setup --json fails fast because setup is interactive', async () => {
  const r = await runCli(['setup', '--json']);
  assert.equal(r.code, 2);
  const payload = JSON.parse(r.stdout.trim());
  assert.equal(payload.ok, false);
  assert.match(payload.error, /Interactive setup requires a TTY/);
});

test('doctor --json reports local diagnostics and validates the API key', async () => {
  const r = await runCli(['doctor', '--json']);
  assert.equal(r.code, 0);
  const payload = JSON.parse(r.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(typeof payload.version, 'string');
  assert.ok(Array.isArray(payload.checks));
  assert.ok(payload.checks.some((check: { name: string; status: string }) => (
    check.name === 'API key validation' && check.status === 'pass'
  )));
});

test('--json contract: every error path emits exactly one JSON line with non-empty error', async () => {
  const out = tmpDir();
  const cases: { name: string; args: string[]; env?: Record<string, string | undefined> }[] = [
    { name: 'local validation failure', args: ['image', 'gen', 'x', '-s', '512x512', '--json'] },
    {
      name: '401',
      args: ['image', 'gen', 'ok-case', '--no-wait', '--json'],
      env: { LINKMODEL_API_KEY: 'wrong-key' },
    },
    { name: 'non-zero business code', args: ['image', 'gen', 'billing-case', '--json'] },
    { name: 'task Failed', args: ['image', 'gen', 'fail-case', '--json'] },
    { name: 'timeout', args: ['image', 'gen', 'timeout-case', '--timeout', '0.001', '--json'] },
    { name: 'download failure', args: ['image', 'gen', 'partial-case', '-o', out, '--json'] },
    { name: 'status Failed', args: ['image', 'status', 'task-fail', '--json'] },
  ];
  for (const c of cases) {
    const r = await runCli(c.args, c.env ?? {});
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 1, `${c.name}:stdout must contain exactly one JSON line; actual:${r.stdout}`);
    const payload = JSON.parse(lines[0]);
    assert.equal(payload.ok, false, `${c.name}:ok should be false`);
    assert.equal(typeof payload.error, 'string', `${c.name}:error must exist and be a string`);
    assert.ok(payload.error.length > 0, `${c.name}:error must not be empty`);
  }
});

test('--json validation failure: error is the joined string and errors keeps individual messages', async () => {
  // Single validation error.
  const single = JSON.parse(
    (await runCli(['image', 'gen', 'x', '-s', '512x512', '--json'])).stdout.trim(),
  );
  assert.match(single.error, /total pixels must be >= 655360/);
  assert.deepEqual(single.errors, [single.error]);

  // Multiple validation errors: error joins with ; and errors keeps each item.
  const multi = JSON.parse(
    (await runCli(['image', 'gen', 'x', '-s', '512x512', '--timeout', 'abc', '--json'])).stdout.trim(),
  );
  assert.equal(multi.errors.length, 2);
  assert.equal(multi.error, multi.errors.join('; '));
  assert.match(multi.error, /total pixels/);
  assert.match(multi.error, /--timeout must be/);
});

test('gen --no-wait creates only, prints task_id to stdout, and does not poll', async () => {
  const queryBefore = counts.query;
  const r = await runCli(['image', 'gen', 'ok-case', '--no-wait']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'task-ok');
  assert.equal(counts.query, queryBefore);
});

test('gen --no-download prints URLs without writing files and reminds about 48-hour expiry on stderr', async () => {
  const out = tmpDir();
  const r = await runCli(['image', 'gen', 'ok-case', '--no-download', '-o', out]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes(`${origin}/img/1.png`));
  assert.ok(r.stdout.includes(`${origin}/img/2.png`));
  assert.deepEqual(fs.readdirSync(out), []);
  assert.match(r.stderr, /48 hours/);
  assert.ok(!r.stdout.includes('48 hours'), 'reminder must not pollute stdout');
});

test('gen --json emits one parseable JSON line on stdout', async () => {
  const out = tmpDir();
  const r = await runCli(['image', 'gen', 'ok-case', '--json', '-o', out]);
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1, `stdout should contain one JSON line; actual:${r.stdout}`);
  const payload = JSON.parse(lines[0]);
  assert.equal(payload.ok, true);
  assert.equal(payload.task_id, 'task-ok');
  assert.equal(payload.downloaded.length, 2);
  assert.ok(!r.stdout.includes('task-ok-1.png\n')); // file paths appear only inside JSON
});

// ---------- failure paths ----------

test('gen 401:exit code 3,error message includes request_id', async () => {
  const r = await runCli(['image', 'gen', 'ok-case', '--no-wait'], { LINKMODEL_API_KEY: 'wrong-key' });
  assert.equal(r.code, 3, r.stderr);
  assert.match(r.stderr, /Authentication failed/);
  assert.match(r.stderr, /r-401/);
});

test('gen HTTP 200 + business code 500 (insufficient balance): exit 1 and preserves real error', async () => {
  const r = await runCli(['image', 'gen', 'billing-case']);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /insufficient balance/);
  assert.match(r.stderr, /r-billing/);
  assert.ok(!r.stderr.includes('missing task_id'), 'must not report the misleading missing task_id error');
});

test('gen HTTP 200 + business code 401 exits 3', async () => {
  const r = await runCli(['image', 'gen', 'biz-auth-case']);
  assert.equal(r.code, 3, r.stderr);
  assert.match(r.stderr, /token expired/);
  assert.match(r.stderr, /r-bauth/);
});

test('gen HTTP 200 + missing code + msg success exits 1 with missing-code reason and server msg', async () => {
  const r = await runCli(['image', 'gen', 'no-code-case']);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /Response missing code field \(server message: success\)/);
  assert.match(r.stderr, /no-code-case/);
  assert.ok(!/✖ success\n/.test(r.stderr), 'must not output the contradictory "✖ success"');
});

test('gen task Failed:exit code 1,prints task-level data.msg details', async () => {
  const r = await runCli(['image', 'gen', 'fail-case']);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /content policy blocked the task/);
});

test('gen Cancelled task exits 1', async () => {
  const r = await runCli(['image', 'gen', 'cancel-case']);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /cancelled/);
});

test('gen Polling timeout.:exit code 4,keeps task_id and suggests checking status', async () => {
  const r = await runCli(['image', 'gen', 'timeout-case', '--timeout', '0.001']); // 60ms
  assert.equal(r.code, 4, r.stderr);
  assert.match(r.stderr, /Timed out after/);
  assert.match(r.stderr, /task-slow/);
  assert.match(r.stderr, /lkm image status task-slow/);
});

test('video gen Polling timeout.:suggests video status check', async () => {
  const r = await runCli([
    'video',
    'gen',
    'video-timeout-case',
    '-m',
    'seedance-2-0',
    '--timeout',
    '0.001',
  ]);
  assert.equal(r.code, 4, r.stderr);
  assert.match(r.stderr, /video-slow/);
  assert.match(r.stderr, /lkm video status video-slow/);
});

test('gen partial download failure does not block others, summarizes at end, exits 1', async () => {
  const out = tmpDir();
  const r = await runCli(['image', 'gen', 'partial-case', '-o', out]);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /Download failed:.*img\/404\.png/);
  assert.match(r.stderr, /1 of 2 images failed to download/);
  assert.equal(fs.readFileSync(path.join(out, 'task-partial-1.png'), 'utf8'), 'PNG-BYTES-1');
  assert.ok(!fs.existsSync(path.join(out, 'task-partial-2.png')));
});

test('gen without API key exits 2 and points to auth login', async () => {
  const r = await runCli(['image', 'gen', 'ok-case', '--no-wait'], { LINKMODEL_API_KEY: undefined });
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /No API key found/);
  assert.match(r.stderr, /lkm auth login --api-key/);
});

test('top-level legacy gen/status forms are removed: unknown command exits 2 without requests', async () => {
  const createBefore = counts.create;
  assert.equal((await runCli(['gen', 'ok-case'])).code, 2);
  assert.equal((await runCli(['status', 'task-ok'])).code, 2);
  assert.equal(counts.create, createBefore, 'gen/status must not be treated as prompts');
});

test('gen --open and --no-download are mutually exclusive: exit 2 without requests', async () => {
  const createBefore = counts.create;
  const r = await runCli(['image', 'gen', 'ok-case', '--no-download', '--open']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--open cannot be used with --no-download/);
  assert.equal(counts.create, createBefore, 'mutual exclusion errors must happen before any request');
});

test('gen parameter errors: missing prompt, invalid enum, too many images, invalid timeout -> exit 2', async () => {
  assert.equal((await runCli(['image', 'gen'])).code, 2);
  assert.equal((await runCli(['image', 'gen', 'x', '-q', 'ultra'])).code, 2);
  const eleven = Array.from({ length: 11 }, (_, i) => `https://x/${i}.png`);
  assert.equal((await runCli(['image', 'gen', 'x', '-i', ...eleven])).code, 2);
  assert.equal((await runCli(['image', 'gen', 'x', '--timeout', 'abc'])).code, 2);
});

test('video gen parameter errors: invalid enum, too many videos, invalid URL -> exit 2', async () => {
  assert.equal((await runCli(['video', 'gen', 'x', '-d', '3'])).code, 2);
  const four = Array.from({ length: 4 }, (_, i) => `https://x/${i}.mp4`);
  assert.equal((await runCli(['video', 'gen', 'x', '--video', ...four])).code, 2);
  assert.equal((await runCli(['video', 'gen', 'x', '--first-frame-image', 'bad'])).code, 2);
});

test('gen -s size constraints: invalid values are blocked locally and valid enum-outside values pass', async () => {
  const createBefore = counts.create;
  const bad = await runCli(['image', 'gen', 'x', '-s', '1000x1024']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /multiples of 16/);
  assert.equal(counts.create, createBefore, 'invalid size must not send a request');

  const ratio = await runCli(['image', 'gen', 'x', '-s', '3840x512']);
  assert.equal(ratio.code, 2);
  assert.match(ratio.stderr, /ratio must not exceed 3:1 \(got 7\.5\)/);

  // Enum-outside but officially supported sizes must pass local validation.
  for (const ok of ['2048x1152', '3840x2160', '1792x1024']) {
    const r = await runCli(['image', 'gen', 'ok-case', '--no-wait', '-s', ok]);
    assert.equal(r.code, 0, `${ok} should pass local validation:${r.stderr}`);
  }
});

// ---------- SIGINT safety ----------

test('Ctrl-C reports that the server task is still running and exits 130', async () => {
  // Use the real schedule without LINKMODEL_POLL_SCHEDULE: after creation it enters a 10s quiet period, making SIGINT deterministic.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'lm-home-')),
    LINKMODEL_BASE_URL: `${origin}/api/v1`,
    LINKMODEL_API_KEY: 'test-key',
  };
  const child: ChildProcess = spawn(process.execPath, [CLI, 'image', 'gen', 'ok-case'], { env });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d) => (stdout += d));
  let killed = false;
  child.stderr?.on('data', (d) => {
    stderr += d;
    if (!killed && stderr.includes('Task created')) {
      killed = true;
      child.kill('SIGINT');
    }
  });
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  assert.equal(code, 130, stderr);
  assert.match(stderr, /Task task-ok is still running on the server; check it with: lkm image status task-ok/);
});

// ---------- status ----------

test('status success exits 0, prints image URLs to stdout, and expiry note to stderr', async () => {
  const r = await runCli(['image', 'status', 'task-ok']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes(`${origin}/img/1.png`));
  assert.match(r.stderr, /48 hours/);
});

test('video status success exits 0 and prints video URL to stdout', async () => {
  const r = await runCli(['video', 'status', 'video-ok']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes(`${origin}/video/out.mp4`));
  assert.match(r.stderr, /48 hours/);
});

test('status failed task exits 1 and prints data.msg', async () => {
  const r = await runCli(['image', 'status', 'task-fail']);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /content policy blocked the task/);
});

test('status in-progress task exits 0', async () => {
  const r = await runCli(['image', 'status', 'task-slow']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /Processing/);
});

test('status --wait resumes polling an existing task and downloads artifacts', async () => {
  const out = tmpDir();
  const r = await runCli(['image', 'status', 'task-ok', '--wait', '-o', out]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /task-ok-1\.png/);
  assert.equal(fs.readFileSync(path.join(out, 'task-ok-1.png'), 'utf8'), 'PNG-BYTES-1');
});

test('video status --wait --no-download resumes polling an existing video task and prints URL only', async () => {
  const out = tmpDir();
  const r = await runCli(['video', 'status', 'video-ok', '--wait', '--no-download', '-o', out]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes(`${origin}/video/out.mp4`));
  assert.deepEqual(fs.readdirSync(out), []);
});

test('status --wait timeout exits 4 and says waiting can continue', async () => {
  const r = await runCli(['image', 'status', 'task-slow', '--wait', '--timeout', '0.001']);
  assert.equal(r.code, 4, r.stderr);
  assert.match(r.stderr, /Timed out after/);
  assert.match(r.stderr, /lkm image status task-slow --wait/);
});

test('status 401:exit code 3', async () => {
  const r = await runCli(['image', 'status', 'task-ok'], { LINKMODEL_API_KEY: 'wrong-key' });
  assert.equal(r.code, 3, r.stderr);
});

// ---------- auth ----------

test('auth login/status/logout verifies API key before saving, and logout removes only api_key', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-home-'));
  const key = 'test-key';
  const setModel = await runCli(['config', 'set', 'default-video-model', 'kling-v3'], { HOME: home });
  assert.equal(setModel.code, 0, setModel.stderr);

  const authCheckBefore = counts.authCheck;
  const queryBefore = counts.query;
  const login = await runCli(['auth', 'login', '--api-key', key], {
    HOME: home,
    LINKMODEL_API_KEY: undefined,
  });
  assert.equal(login.code, 0, login.stderr);
  assert.match(login.stderr, /verified and saved/);
  assert.equal(counts.authCheck, authCheckBefore + 1);
  assert.equal(counts.query, queryBefore, 'auth validation must not query a fake task');

  const status = await runCli(['auth', 'status', '--json'], {
    HOME: home,
    LINKMODEL_API_KEY: undefined,
  });
  assert.equal(status.code, 0, status.stderr);
  const payload = JSON.parse(status.stdout.trim());
  assert.equal(payload.configured, true);
  assert.equal(payload.api_key, '••••••••');
  assert.equal(payload.source, 'config');

  const logout = await runCli(['auth', 'logout', '--json'], { HOME: home });
  assert.equal(logout.code, 0, logout.stderr);
  const config = JSON.parse(fs.readFileSync(path.join(home, '.linkmodel', 'config.json'), 'utf8'));
  assert.equal(config.api_key, undefined);
  assert.equal(config.default_video_model, 'kling-v3');
});

test('auth login with invalid API key does not write config and exits 3', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-home-'));
  const r = await runCli(['auth', 'login', '--api-key', 'wrong-key'], {
    HOME: home,
    LINKMODEL_API_KEY: undefined,
  });
  assert.equal(r.code, 3, r.stderr);
  assert.match(r.stderr, /Authentication failed/);
  assert.ok(!fs.existsSync(path.join(home, '.linkmodel', 'config.json')));
});

// ---------- models ----------

test('models list/show reads built-in schema', async () => {
  const list = await runCli(['models', 'list', '--modality', 'video', '--json']);
  assert.equal(list.code, 0, list.stderr);
  const models = JSON.parse(list.stdout.trim()).models;
  assert.ok(models.some((m: { name: string; default: boolean }) => m.name === 'kling-v3' && m.default));

  const show = await runCli(['models', 'show', 'kling-v3', '--json']);
  assert.equal(show.code, 0, show.stderr);
  const detail = JSON.parse(show.stdout.trim());
  assert.equal(detail.modality, 'video');
  assert.ok(detail.fields.some((f: { name: string }) => f.name === 'extends.cfg_scale'));
});

// ---------- config ----------

test('config set/get/path round trip; get masks by default and --reveal/--json follow the contract', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-home-'));
  const key = 'sk-testkey1234567890'; // 20 characters, enough for head/tail masking
  const set = await runCli(['config', 'set', 'api-key', key], { HOME: home });
  assert.equal(set.code, 0, set.stderr);

  const configFile = path.join(home, '.linkmodel', 'config.json');
  assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);

  // Masked by default: stdout has identifiable but unusable fragments, full key is absent, and --reveal is suggested.
  const get = await runCli(['config', 'get'], { HOME: home, LINKMODEL_API_KEY: undefined });
  assert.equal(get.code, 0, get.stderr);
  assert.equal(get.stdout.trim(), 'sk-test…7890');
  assert.ok(!get.stdout.includes(key), 'stdout must not contain full key');
  assert.match(get.stderr, /--reveal/);
  assert.match(get.stderr, /config file/);

  // --reveal explicitly prints the full key.
  const reveal = await runCli(['config', 'get', '--reveal'], {
    HOME: home,
    LINKMODEL_API_KEY: undefined,
  });
  assert.equal(reveal.code, 0, reveal.stderr);
  assert.equal(reveal.stdout.trim(), key);

  // --json also masks by default; --reveal returns the full value.
  const j = await runCli(['config', 'get', '--json'], { HOME: home, LINKMODEL_API_KEY: undefined });
  const payload = JSON.parse(j.stdout.trim());
  assert.equal(payload.api_key, 'sk-test…7890');
  assert.equal(payload.masked, true);
  assert.equal(payload.source, 'config');
  const jr = await runCli(['config', 'get', '--json', '--reveal'], {
    HOME: home,
    LINKMODEL_API_KEY: undefined,
  });
  assert.equal(JSON.parse(jr.stdout.trim()).api_key, key);

  const p = await runCli(['config', 'path'], { HOME: home });
  assert.equal(p.code, 0);
  assert.equal(p.stdout.trim(), configFile);
});

test('config get fully masks short keys without revealing fragments', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-home-'));
  await runCli(['config', 'set', 'api-key', 'short-key'], { HOME: home }); // 9 characters
  const get = await runCli(['config', 'get'], { HOME: home, LINKMODEL_API_KEY: undefined });
  assert.equal(get.code, 0, get.stderr);
  assert.ok(!get.stdout.includes('short'));
  assert.ok(!get.stdout.includes('-key'));
  assert.ok(!get.stdout.trim().includes('…'), 'short keys should not use head/tail masking');
});

test('config list / get <name> reads default models and keeps api-key masked', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-home-'));
  await runCli(['config', 'set', 'api-key', 'sk-testkey1234567890'], { HOME: home });
  await runCli(['config', 'set', 'default-image-model', 'seedream-4.5'], { HOME: home });
  await runCli(['config', 'set', 'default-video-model', 'kling-v3'], { HOME: home });

  const image = await runCli(['config', 'get', 'default-image-model'], { HOME: home });
  assert.equal(image.code, 0, image.stderr);
  assert.equal(image.stdout.trim(), 'seedream-4.5');

  const list = await runCli(['config', 'list', '--json'], { HOME: home });
  assert.equal(list.code, 0, list.stderr);
  const payload = JSON.parse(list.stdout.trim());
  assert.equal(payload.api_key, 'sk-test…7890');
  assert.equal(payload.default_image_model, 'seedream-4.5');
  assert.equal(payload.default_video_model, 'kling-v3');
});
