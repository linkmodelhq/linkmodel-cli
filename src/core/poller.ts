/**
 * Polling scheduler.
 *
 * The schedule follows the official recommendation and is expressed declaratively. now() and sleep() are injected through a clock.
 * Tests replace the clock so a 15-minute polling window can run in milliseconds.
 * This lets tests assert the exact number of requests.
 */

export interface PollClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: PollClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

export interface ScheduleSegment {
  /** Upper elapsed millisecond bound for this segment. */
  until: number;
  /** Request interval for this segment; null means wait silently without requests. */
  interval: number | null;
}

/** Officially recommended polling schedule. */
export const SCHEDULE: readonly ScheduleSegment[] = [
  { until: 10_000, interval: null }, // Silent wait; no requests.
  { until: 60_000, interval: 3_000 },
  { until: 180_000, interval: 6_000 },
  { until: 900_000, interval: 10_000 },
];

export class PollTimeoutError extends Error {
  constructor(readonly elapsedMs: number) {
    super(`Polling timed out after ${Math.round(elapsedMs / 1000)}s`);
    this.name = 'PollTimeoutError';
  }
}

export interface PollOptions<T> {
  clock: PollClock;
  timeoutMs: number;
  query: () => Promise<T>;
  isTerminal: (value: T) => boolean;
  /** Called before each request with elapsed milliseconds, used for spinner text. */
  onProgress?: (elapsedMs: number) => void;
  /** Defaults to SCHEDULE; integration tests can inject a fast schedule. */
  schedule?: readonly ScheduleSegment[];
}

export async function poll<T>(options: PollOptions<T>): Promise<T> {
  const { clock, timeoutMs, query, isTerminal, onProgress } = options;
  const schedule = options.schedule ?? SCHEDULE;
  if (schedule.length === 0) throw new Error('Poll schedule must not be empty');
  const start = clock.now();

  const intervalAt = (elapsedMs: number): number | null => {
    for (const seg of schedule) {
      if (elapsedMs < seg.until) return seg.interval;
    }
    // After the final segment, keep using the final interval.
    return schedule[schedule.length - 1].interval;
  };

  for (;;) {
    const elapsed = clock.now() - start;
    if (elapsed >= timeoutMs) throw new PollTimeoutError(elapsed);

    const interval = intervalAt(elapsed);
    if (interval === null) {
      // Silent segment: sleep until segment end or timeout without sending requests.
      const seg = schedule.find((s) => elapsed < s.until)!;
      await clock.sleep(Math.min(seg.until - elapsed, timeoutMs - elapsed));
      continue;
    }

    onProgress?.(elapsed);
    const value = await query();
    if (isTerminal(value)) return value;

    const remaining = timeoutMs - (clock.now() - start);
    if (remaining <= 0) throw new PollTimeoutError(clock.now() - start);
    await clock.sleep(Math.min(interval, remaining));
  }
}
