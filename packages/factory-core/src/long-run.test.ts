import { describe, expect, it } from 'vitest';
import { f170SmallLine } from './fixtures';
import { factoryLimits } from './model';
import { runFactory, startFactoryRun } from './engine';

const year = factoryLimits.maxTimeMs;

describe('#17 long runs in slices', () => {
  it('a simulated year taken in slices gives the same result as one run at once', () => {
    const doc = f170SmallLine();
    doc.run = { warmupMs: 3_600_000, durationMs: year - 3_600_000, seed: 7 };
    const t0 = performance.now();
    const whole = runFactory(doc);
    const once = performance.now() - t0;
    expect(whole.events).toBeGreaterThan(1_000_000);
    const run = startFactoryRun(doc);
    const seen: number[] = [];
    let p = run.progress();
    expect(p).toMatchObject({ done: false, events: 0, endMs: year });
    while (!p.done) {
      p = run.advance(250_000);
      seen.push(p.simMs);
    }
    // Progress moves forward through the year, slice by slice.
    expect(seen.length).toBeGreaterThan(4);
    expect(seen.every((t, i) => i === 0 || t >= seen[i - 1]!)).toBe(true);
    expect(seen.at(-1)).toBe(year);
    expect(run.finish()).toEqual(whole);
    expect(run.advance(10)).toMatchObject({ done: true });
    console.info(`#17 year: ${whole.events} events, ${Math.round(once)} ms at once`);
  }, 120_000);

  it('allows runs far longer than ten million events, and still stops at a set limit', () => {
    expect(factoryLimits.events).toBeGreaterThanOrEqual(500_000_000);
    const doc = f170SmallLine();
    const run = startFactoryRun(doc, { maxEvents: 1_000 });
    expect(() => {
      for (let i = 0; i < 100; i++) run.advance(100);
    }).toThrow(/more than 1000 events/);
    expect(() => startFactoryRun(doc).finish()).toThrow(/not finished/);
  });
});
