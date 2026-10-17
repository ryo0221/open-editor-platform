import { expect, it } from 'vitest';
import { createPreviewTransport } from './transport';
function fixture(loop = false) {
  let time = 0,
    id = 0;
  const callbacks = new Map<number, () => void>(),
    ticks: number[] = [];
  const clock = {
    now: () => time,
    request: (cb: () => void) => {
      callbacks.set(++id, cb);
      return id;
    },
    cancel: (id: number) => {
      callbacks.delete(id);
    },
  };
  const transport = createPreviewTransport(240000, 240000, clock, (tick) => ticks.push(tick), loop);
  return {
    transport,
    ticks,
    callbacks,
    elapseWithoutFrame(ms: number) {
      time = ms;
    },
    advance(ms: number) {
      time = ms;
      const pending = [...callbacks.values()];
      callbacks.clear();
      pending.forEach((cb) => cb());
    },
  };
}
it('samples absolute elapsed time after dropped frames, pause/resume and rate changes', () => {
  const f = fixture();
  f.transport.play();
  f.advance(100);
  expect(f.transport.tick).toBe(24000);
  f.advance(500);
  expect(f.transport.tick).toBe(120000);
  f.transport.pause();
  expect(f.callbacks.size).toBe(0);
  f.advance(1500);
  expect(f.transport.tick).toBe(120000);
  f.transport.play();
  f.advance(1750);
  expect(f.transport.tick).toBe(180000);
  f.transport.setRate(2);
  f.advance(1875);
  expect(f.transport.tick).toBe(240000);
  expect(f.transport.playing).toBe(false);
  expect(f.callbacks.size).toBe(0);
});
it('seek resets the clock anchor and loop wraps; disposal is idempotent', () => {
  const f = fixture(true);
  f.transport.play();
  f.advance(1250);
  expect(f.transport.tick).toBe(60000);
  f.transport.seek(120000);
  f.advance(1500);
  expect(f.transport.tick).toBe(180000);
  const old = [...f.callbacks.values()];
  f.transport.dispose();
  f.transport.dispose();
  const count = f.ticks.length;
  old.forEach((cb) => cb());
  expect(f.ticks).toHaveLength(count);
  expect(f.callbacks.size).toBe(0);
  expect(() => f.transport.seek(0)).toThrow('disposed');
  expect(() => f.transport.play()).toThrow('disposed');
});
it('rejects invalid controls without changing pose or running state', () => {
  const f = fixture();
  f.transport.seek(100);
  for (const value of [-1, 0.5, Infinity, 240001]) expect(() => f.transport.seek(value)).toThrow();
  for (const rate of [0, -1, Infinity, 17]) expect(() => f.transport.setRate(rate)).toThrow();
  expect(f.transport.tick).toBe(100);
  expect(f.callbacks.size).toBe(0);
});
it('stops scheduling after renderer failure and ignores canceled frame callbacks', () => {
  let callback = () => {};
  const p = createPreviewTransport(
    100,
    100,
    {
      now: () => 1,
      request: (cb) => {
        callback = cb;
        return 1;
      },
      cancel: () => {},
    },
    () => {
      throw new Error('render failure');
    },
  );
  p.play();
  expect(() => callback()).toThrow('render failure');
  expect(p.playing).toBe(false);
  expect(() => callback()).not.toThrow();
  p.dispose();
});
it('ignores a canceled old frame even after playback resumes', () => {
  const f = fixture();
  f.transport.play();
  const old = [...f.callbacks.values()][0];
  f.transport.pause();
  f.transport.play();
  const count = f.ticks.length;
  old();
  expect(f.ticks).toHaveLength(count);
  expect(f.callbacks.size).toBe(1);
});

it.each([1000, 1250])(
  'does not restart nonloop playback when setRate samples a delayed terminal frame at %d ms',
  (ms) => {
    const f = fixture();
    f.transport.play();
    const delayed = [...f.callbacks.values()][0];
    f.elapseWithoutFrame(ms);
    f.transport.setRate(2);
    expect(f.transport.tick).toBe(240000);
    expect(f.ticks.at(-1)).toBe(240000);
    expect(f.transport.playing).toBe(false);
    expect(f.callbacks.size).toBe(0);
    delayed();
    expect(f.callbacks.size).toBe(0);
    expect(f.transport.tick).toBe(240000);
    f.transport.setRate(0.5);
    expect(f.transport.playing).toBe(false);
    f.transport.play();
    expect(f.transport.tick).toBe(0);
    expect(f.transport.playing).toBe(true);
  },
);
it('preserves looping playback when setRate samples a delayed wrap', () => {
  const f = fixture(true);
  f.transport.play();
  f.elapseWithoutFrame(1250);
  f.transport.setRate(2);
  expect(f.transport.tick).toBe(60000);
  expect(f.transport.playing).toBe(true);
  expect(f.callbacks.size).toBe(1);
  f.advance(1500);
  expect(f.transport.tick).toBe(180000);
});
