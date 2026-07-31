import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { test } from 'node:test';

import { runGen, type SharedGenOptions } from '../src/commands/gen.js';
import type { OpenFiles } from '../src/core/open.js';
import { imageModality } from '../src/modalities/image.js';
import { createReporter } from '../src/ui/reporter.js';

/** runGen test with fully injected fakes: no network, no real 10s wait, no real UI opening. */

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lm-open-test-'));

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeDeps(openFiles: OpenFiles, json: boolean) {
  const fetchCalls: string[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    fetchCalls.push(u);
    if (init?.method === 'POST') {
      return jsonResponse({ code: 0, msg: 'ok', data: { task_id: 't-open', price: 0 }, request_id: 'r' });
    }
    if (u.includes('/query/image-generation')) {
      return jsonResponse({
        code: 0,
        message: 'ok',
        data: { status: 'Success', output_images: ['https://img/1.png', 'https://img/2.png'] },
        request_id: 'r',
      });
    }
    return new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'image/png' } });
  }) as unknown as typeof fetch;

  const clock = {
    t: 0,
    now() {
      return this.t;
    },
    async sleep(ms: number) {
      this.t += ms;
    },
  };

  const stdout = { buf: '', write(s: string) { this.buf += s; } };
  const stderr = { buf: '', write(s: string) { this.buf += s; } };
  const reporter = createReporter({ mode: json ? 'json' : 'plain', stdout, stderr });

  return { fetchCalls, stdout, stderr, deps: { env: {}, fetchImpl, clock, reporter, openFiles } };
}

function opts(out: string, over: Partial<SharedGenOptions> = {}): SharedGenOptions & Record<string, unknown> {
  return {
    model: 'gpt-image-2',
    quality: 'medium',
    size: 'auto',
    image: [],
    out,
    wait: true,
    download: true,
    json: false,
    timeout: '15',
    apiKey: 'k',
    open: true,
    ...over,
  };
}

test('--open happy path passes all downloaded file paths to opener', async () => {
  const out = tmpDir();
  const received: string[] = [];
  const openFiles: OpenFiles = async (files) => {
    received.push(...files);
    return { opened: files, failed: [] };
  };
  const { deps } = makeDeps(openFiles, false);
  const code = await runGen('a cat', opts(out), imageModality, deps);
  assert.equal(code, 0);
  assert.deepEqual(received, [path.join(out, 't-open-1.png'), path.join(out, 't-open-2.png')]);
});

test('--json + --open does not call opener, avoiding UI in scripts/CI', async () => {
  const out = tmpDir();
  let called = 0;
  const openFiles: OpenFiles = async (files) => {
    called++;
    return { opened: files, failed: [] };
  };
  const { deps } = makeDeps(openFiles, true);
  const code = await runGen('a cat', opts(out, { json: true }), imageModality, deps);
  assert.equal(code, 0);
  assert.equal(called, 0, '--json mode must not open files');
});

test('--open and --no-download are mutually exclusive: exit 2, no request, no opener', async () => {
  const out = tmpDir();
  let called = 0;
  const openFiles: OpenFiles = async (files) => {
    called++;
    return { opened: files, failed: [] };
  };
  const { deps, fetchCalls, stderr } = makeDeps(openFiles, false);
  const code = await runGen('a cat', opts(out, { download: false }), imageModality, deps);
  assert.equal(code, 2);
  assert.match(stderr.buf, /--open cannot be used with --no-download/);
  assert.equal(fetchCalls.length, 0, 'usage errors must happen before any request');
  assert.equal(called, 0);
});

test('all opener failures still exit 0 and print file locations to stderr', async () => {
  const out = tmpDir();
  const openFiles: OpenFiles = async (files) => ({
    opened: [],
    failed: files.map((file) => ({ file, error: 'spawn xdg-open ENOENT' })),
  });
  const { deps, stderr } = makeDeps(openFiles, false);
  const code = await runGen('a cat', opts(out), imageModality, deps);
  assert.equal(code, 0, 'open failure must not turn successful generation into failure');
  assert.match(stderr.buf, /Could not auto-open/);
  assert.match(stderr.buf, /t-open-1\.png/);
});
