import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createOpener } from '../src/core/open.js';

interface SpawnCall {
  command: string;
  args: string[];
}

/** Fake spawn: records calls and emits spawn/error on the next tick according to behavior. */
function fakeSpawn(behavior: 'spawn' | 'error' | 'throw', calls: SpawnCall[]) {
  return ((command: string, args: string[]) => {
    calls.push({ command, args });
    if (behavior === 'throw') throw new Error('spawn sync failure');
    const listeners = new Map<string, ((...a: unknown[]) => void)[]>();
    const child = {
      unrefCalled: false,
      on(event: string, cb: (...a: unknown[]) => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), cb]);
        return child;
      },
      unref() {
        child.unrefCalled = true;
      },
    };
    queueMicrotask(() => {
      if (behavior === 'spawn') listeners.get('spawn')?.forEach((cb) => cb());
      else listeners.get('error')?.forEach((cb) => cb(new Error('spawn xdg-open ENOENT')));
    });
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
}

test('platform command selection:macOS open / Linux xdg-open / Windows cmd start', async () => {
  for (const [platform, command] of [
    ['darwin', 'open'],
    ['linux', 'xdg-open'],
    ['win32', 'cmd.exe'],
  ] as const) {
    const calls: SpawnCall[] = [];
    const opener = createOpener({ platform, spawnImpl: fakeSpawn('spawn', calls) });
    await opener(['/tmp/a b.png']); // Path contains spaces: arguments are passed as an array unchanged.
    assert.equal(calls[0].command, command);
    assert.equal(calls[0].args.at(-1), '/tmp/a b.png');
    if (platform === 'win32') assert.deepEqual(calls[0].args.slice(0, -1), ['/c', 'start', '']);
  }
});

test('spawn success counts as opened, detached + unref fire-and-forget', async () => {
  const calls: SpawnCall[] = [];
  const opener = createOpener({ platform: 'darwin', spawnImpl: fakeSpawn('spawn', calls) });
  const outcome = await opener(['/tmp/1.png', '/tmp/2.png']);
  assert.deepEqual(outcome.opened, ['/tmp/1.png', '/tmp/2.png']);
  assert.deepEqual(outcome.failed, []);
});

test('missing command (error event) is recorded as failed without throwing', async () => {
  const calls: SpawnCall[] = [];
  const opener = createOpener({ platform: 'linux', spawnImpl: fakeSpawn('error', calls) });
  const outcome = await opener(['/tmp/1.png']);
  assert.deepEqual(outcome.opened, []);
  assert.equal(outcome.failed.length, 1);
  assert.equal(outcome.failed[0].file, '/tmp/1.png');
  assert.match(outcome.failed[0].error, /ENOENT/);
});

test('synchronous spawn throw is recorded as failed without throwing', async () => {
  const calls: SpawnCall[] = [];
  const opener = createOpener({ platform: 'linux', spawnImpl: fakeSpawn('throw', calls) });
  const outcome = await opener(['/tmp/1.png']);
  assert.equal(outcome.failed.length, 1);
  assert.match(outcome.failed[0].error, /sync failure/);
});

test('partial failure does not block other files', async () => {
  const calls: SpawnCall[] = [];
  // First file fails, second succeeds.
  let n = 0;
  const spawnImpl = ((command: string, args: string[]) => {
    const behavior = n++ === 0 ? 'error' : 'spawn';
    return fakeSpawn(behavior, calls)(command, args);
  }) as unknown as typeof import('node:child_process').spawn;
  const opener = createOpener({ platform: 'darwin', spawnImpl });
  const outcome = await opener(['/tmp/1.png', '/tmp/2.png']);
  assert.deepEqual(outcome.opened, ['/tmp/2.png']);
  assert.equal(outcome.failed.length, 1);
  assert.equal(outcome.failed[0].file, '/tmp/1.png');
});
