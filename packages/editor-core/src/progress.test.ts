import { describe, expect, it } from 'vitest';
import {
  describeProgress,
  formatRemaining,
  progressRemainingMs,
  runInSlices,
  startProgress,
} from './progress';

describe('progress and cancel (#16)', () => {
  it('estimates the time left from the rate so far, once there is one', () => {
    const p = { ...startProgress(300, 1_000), done: 0 };
    expect(progressRemainingMs(p, 5_000)).toBeUndefined();
    expect(describeProgress(p, 5_000, 'frames')).toBe('0 of 300 frames');
    const later = { ...p, done: 100 };
    expect(progressRemainingMs(later, 1_200)).toBeUndefined();
    // 100 frames in 2 min: 200 more take 4 min.
    expect(progressRemainingMs(later, 121_000)).toBe(240_000);
    expect(describeProgress(later, 121_000, 'frames')).toBe('100 of 300 frames · about 4 min left');
    expect(describeProgress({ ...later, done: 300 }, 121_000)).toBe('300 of 300');
    expect(formatRemaining(30_000)).toBe('under a minute');
    expect(formatRemaining(100 * 60_000)).toBe('about 1 h 40 min');
    expect(formatRemaining(120 * 60_000)).toBe('about 2 h');
  });

  it('gives the page back between slices, reports progress and stops when cancelled', async () => {
    let clock = 0;
    const pauses: number[] = [];
    const seen: [number, number][] = [];
    const abort = new AbortController();
    const done: number[] = [];
    const run = runInSlices(
      10,
      (i) => {
        done.push(i);
        clock += 10;
      },
      {
        signal: abort.signal,
        sliceMs: 25,
        now: () => clock,
        pause: async () => {
          pauses.push(done.length);
          if (done.length >= 6) abort.abort(new Error('stopped'));
        },
        onProgress: (d, t) => seen.push([d, t]),
      },
    );
    await expect(run).rejects.toThrow('stopped');
    // Each slice ran ~30 ms of steps (3 of them) before giving the page back.
    expect(pauses).toEqual([3, 6]);
    expect(seen).toEqual([
      [3, 10],
      [6, 10],
    ]);
    expect(done).toHaveLength(6);

    const all: [number, number][] = [];
    await runInSlices(4, () => {}, { onProgress: (d, t) => all.push([d, t]) });
    expect(all.at(-1)).toEqual([4, 4]);
    const already = new AbortController();
    already.abort();
    await expect(runInSlices(4, () => {}, { signal: already.signal })).rejects.toBeDefined();
  });
});
