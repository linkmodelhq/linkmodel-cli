import assert from 'node:assert/strict';
import { test } from 'node:test';

import { poll, PollTimeoutError, type PollClock } from '../src/core/poller.js';

/** Fake clock: sleep advances time directly so a 15-minute polling window completes in milliseconds. */
class FakeClock implements PollClock {
  t = 0;
  sleeps: number[] = [];
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.t += ms;
  }
}

test('quiet period sends no requests for first 10s; first request happens exactly at t=10s', async () => {
  const clock = new FakeClock();
  const callTimes: number[] = [];
  const result = await poll({
    clock,
    timeoutMs: 900_000,
    query: async () => {
      callTimes.push(clock.t);
      return 'done';
    },
    isTerminal: (v) => v === 'done',
  });
  assert.equal(result, 'done');
  assert.deepEqual(callTimes, [10_000]);
  assert.deepEqual(clock.sleeps, [10_000]); // Sleep directly to the end of the quiet period.
});

test('full 15-minute window makes exactly 109 requests and matches official cadence', async () => {
  const clock = new FakeClock();
  const callTimes: number[] = [];
  await assert.rejects(
    poll({
      clock,
      timeoutMs: 900_000,
      query: async () => {
        callTimes.push(clock.t);
        return 'Pending';
      },
      isTerminal: () => false,
    }),
    (err: unknown) => err instanceof PollTimeoutError && err.elapsedMs === 900_000,
  );

  // Segment 2 (10s-60s, 3s): 10,13,...,58 -> 17 requests
  // Segment 3 (60s-180s, 6s): 61,67,...,175 -> 20 requests
  // Segment 4 (180s-900s, 10s): 181,191,...,891 -> 72 requests
  // total 17 + 20 + 72 = 109
  assert.equal(callTimes.length, 109);
  assert.equal(callTimes[0], 10_000);
  assert.equal(callTimes[16], 58_000);
  assert.equal(callTimes[17], 61_000);
  assert.equal(callTimes[36], 175_000);
  assert.equal(callTimes[37], 181_000);
  assert.equal(callTimes[108], 891_000);

  // Validate adjacent intervals segment by segment.
  for (let i = 1; i <= 16; i++) assert.equal(callTimes[i] - callTimes[i - 1], 3_000);
  for (let i = 18; i <= 36; i++) assert.equal(callTimes[i] - callTimes[i - 1], 6_000);
  for (let i = 38; i <= 108; i++) assert.equal(callTimes[i] - callTimes[i - 1], 10_000);
});

test('onProgress is called with elapsed time before each request', async () => {
  const clock = new FakeClock();
  const progress: number[] = [];
  let n = 0;
  await poll({
    clock,
    timeoutMs: 900_000,
    query: async () => ++n,
    isTerminal: (v) => v === 3,
    onProgress: (elapsed) => progress.push(elapsed),
  });
  assert.deepEqual(progress, [10_000, 13_000, 16_000]);
});

test('timeout before quiet period ends sends no requests', async () => {
  const clock = new FakeClock();
  let calls = 0;
  await assert.rejects(
    poll({
      clock,
      timeoutMs: 5_000,
      query: async () => {
        calls++;
        return 'x';
      },
      isTerminal: () => false,
    }),
    (err: unknown) => err instanceof PollTimeoutError && err.elapsedMs === 5_000,
  );
  assert.equal(calls, 0);
  assert.deepEqual(clock.sleeps, [5_000]); // sleep is capped at the timeout point
});

test('custom schedule can be injected for fast integration tests', async () => {
  const clock = new FakeClock();
  const callTimes: number[] = [];
  await assert.rejects(
    poll({
      clock,
      timeoutMs: 250,
      schedule: [{ until: 0, interval: 100 }],
      query: async () => {
        callTimes.push(clock.t);
        return 'Pending';
      },
      isTerminal: () => false,
    }),
    PollTimeoutError,
  );
  assert.deepEqual(callTimes, [0, 100, 200]);
});

test('query errors propagate directly without silent fallback', async () => {
  const clock = new FakeClock();
  const boom = new Error('boom');
  await assert.rejects(
    poll({
      clock,
      timeoutMs: 900_000,
      query: async () => {
        throw boom;
      },
      isTerminal: () => false,
    }),
    (err: unknown) => err === boom,
  );
});
