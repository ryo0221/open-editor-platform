import { describe, expect, it } from 'vitest';
import {
  factoryStillFileName,
  factoryVideoFileName,
  factoryVideoFrames,
  factoryVideoProblems,
} from './video';

const ok = { fromS: 3600, toS: 7200, speed: 600, width: 1280, height: 720 };

// TS-2665: FT4c the replay video's settings and frames.
describe('FT4c video settings (TS-2665)', () => {
  it('records a span of the replay at a speed: 30 frames a video second', () => {
    expect(factoryVideoProblems(32_400, ok)).toEqual([]);
    const f = factoryVideoFrames(ok);
    // 3,600 s at ×600 = 6 video seconds = 180 frames, and the last time itself.
    expect(f.ticks).toHaveLength(181);
    expect(f.timeOf(0)).toBe(3_600_000);
    expect(f.timeOf(30)).toBe(4_200_000);
    expect(f.timeOf(180)).toBe(7_200_000);
    // Walkers stride once a video second, whatever the speed.
    expect(f.strideOf(30)).toBe(1);
  });

  it('refuses spans outside the replay, reversed ones, other speeds, sizes and too many frames', () => {
    expect(factoryVideoProblems(32_400, { ...ok, toS: 40_000 })).toEqual([
      'The times must lie from 0 to 32400 s.',
    ]);
    expect(factoryVideoProblems(32_400, { ...ok, toS: 3600 })).toEqual([
      'From must come before To.',
    ]);
    expect(factoryVideoProblems(32_400, { ...ok, fromS: NaN })).toEqual([
      'From and To must be numbers of seconds.',
    ]);
    expect(factoryVideoProblems(32_400, { ...ok, speed: 7 })[0]).toContain('The speed must be');
    expect(factoryVideoProblems(32_400, { ...ok, width: 640 })[0]).toContain('The size must be');
    // A year at ×1: refused by counting, without listing 946 million frames.
    const year = { ...ok, fromS: 0, toS: 365 * 86_400, speed: 1 };
    const t0 = performance.now();
    expect(factoryVideoProblems(365 * 86_400, year)[0]).toContain('946080001 frames');
    expect(performance.now() - t0).toBeLessThan(100);
    // 9 hours at ×1: 972,001 frames.
    expect(factoryVideoProblems(32_400, { ...ok, fromS: 0, toS: 32_400, speed: 1 })[0]).toContain(
      'more than',
    );
  });

  it('names the files by the factory and the replay time', () => {
    expect(factoryVideoFileName('E-Axle line / A', ok)).toBe('E-Axle-line-A-010000-020000.mp4');
    expect(factoryStillFileName('', 14_400_500)).toBe('factory-040000.png');
  });
});
