/**
 * #16: the shared progress and cancel contract for heavy operations (checks, exports, renders).
 * An operation reports how much of a known total is done; the Host shows it with an estimate of
 * the time left and a way to cancel (an AbortSignal the operation checks between steps).
 */
export interface OperationProgress {
  done: number;
  total: number;
  /** When the operation started, in the clock's milliseconds (`performance.now()` or `Date.now()`). */
  startedAt: number;
}

/** Starts a progress record at `now`. */
export const startProgress = (total: number, now: number): OperationProgress => ({
  done: 0,
  total: Math.max(0, total),
  startedAt: now,
});

/**
 * The milliseconds still to go at `now`, from the rate so far; undefined until there is a rate to
 * go by (nothing done yet, or under half a second spent).
 */
export function progressRemainingMs(p: OperationProgress, now: number): number | undefined {
  const spent = now - p.startedAt;
  if (!(p.done > 0) || !(p.total > 0) || !(spent >= 500)) return undefined;
  if (p.done >= p.total) return 0;
  return (spent / p.done) * (p.total - p.done);
}

/** "under a minute", "about 4 min", "about 1 h 20 min". */
export function formatRemaining(ms: number): string {
  if (ms < 60_000) return 'under a minute';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `about ${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `about ${h} h ${m} min` : `about ${h} h`;
}

/** "120 of 300 frames · about 4 min left", or without the estimate while there is none. */
export function describeProgress(p: OperationProgress, now: number, unit = ''): string {
  const count = `${Math.min(p.done, p.total)} of ${p.total}${unit ? ` ${unit}` : ''}`;
  const left = progressRemainingMs(p, now);
  return left === undefined || p.done >= p.total
    ? count
    : `${count} · ${formatRemaining(left)} left`;
}

/**
 * Runs `step(i)` for i from 0 below `count`, giving the page back (`pause`) whenever a slice has
 * taken `sliceMs`, so no long task holds the screen. Between slices it reports progress and stops
 * with the signal's reason when cancelled.
 */
export async function runInSlices(
  count: number,
  step: (i: number) => void,
  options: {
    signal?: AbortSignal;
    sliceMs?: number;
    pause?: () => Promise<void>;
    onProgress?: (done: number, total: number) => void;
    now?: () => number;
  } = {},
): Promise<void> {
  const { signal, sliceMs = 25 } = options;
  const pause = options.pause ?? (() => new Promise<void>((r) => setTimeout(r, 0)));
  const now =
    options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  signal?.throwIfAborted();
  let from = now();
  for (let i = 0; i < count; i++) {
    step(i);
    if (now() - from >= sliceMs && i + 1 < count) {
      options.onProgress?.(i + 1, count);
      await pause();
      signal?.throwIfAborted();
      from = now();
    }
  }
  options.onProgress?.(count, count);
}
