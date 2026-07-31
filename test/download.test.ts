import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { downloadArtifacts } from '../src/core/download.js';
import { resolveImageExtension } from '../src/modalities/image.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lm-download-test-'));

test('downloadArtifacts: extension is decided by injected resolver, e.g. image Content-Type', async () => {
  const out = tmpDir();
  const fetchImpl = (async (url: unknown) => {
    if (String(url).endsWith('a')) {
      return new Response(new Uint8Array([1]), {
        status: 200,
        headers: { 'content-type': 'image/webp' },
      });
    }
    return new Response(new Uint8Array([2]), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    });
  }) as unknown as typeof fetch;

  const result = await downloadArtifacts({
    urls: ['https://x/a', 'https://x/b.png'],
    outDir: out,
    taskId: 't-1',
    resolveExtension: resolveImageExtension,
    fetchImpl,
  });

  assert.equal(result.failed.length, 0);
  assert.deepEqual(
    result.saved.map((s) => path.basename(s.file)),
    ['t-1-1.webp', 't-1-2.png'],
  );
});

test('downloadArtifacts: one failed file does not block others and includes failure reason', async () => {
  const out = tmpDir();
  const fetchImpl = (async (url: unknown) => {
    if (String(url).endsWith('bad')) return new Response('nope', { status: 404 });
    return new Response(new Uint8Array([9]), { status: 200 });
  }) as unknown as typeof fetch;

  const result = await downloadArtifacts({
    urls: ['https://x/good', 'https://x/bad'],
    outDir: out,
    taskId: 't-2',
    resolveExtension: resolveImageExtension,
    fetchImpl,
  });

  assert.equal(result.saved.length, 1);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /404/);
  assert.ok(fs.existsSync(path.join(out, 't-2-1.png')));
  assert.ok(!fs.existsSync(path.join(out, 't-2-2.png')));
});

test('downloadArtifacts: concurrency and failure summary are shared and resolver-independent', async () => {
  const out = tmpDir();
  const fetchImpl = (async () =>
    new Response(new Uint8Array([7]), { status: 200 })) as unknown as typeof fetch;
  // Swap in a hypothetical modality resolver that always returns .bin; shared download logic should not change.
  const result = await downloadArtifacts({
    urls: ['https://x/1', 'https://x/2', 'https://x/3'],
    outDir: out,
    taskId: 't-3',
    resolveExtension: () => '.bin',
    fetchImpl,
    concurrency: 2,
  });
  assert.equal(result.failed.length, 0);
  assert.deepEqual(
    result.saved.map((s) => path.basename(s.file)),
    ['t-3-1.bin', 't-3-2.bin', 't-3-3.bin'],
  );
});
