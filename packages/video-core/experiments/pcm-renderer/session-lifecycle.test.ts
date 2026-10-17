import { expect, it } from 'vitest';
import { time } from '@editor-platform/video-core';
import { PcmRenderSession } from './session';
import { planWindow, type PcmWindow, type WindowPlan } from './render';
const mapping = { start: time(0), end: time(1, 10), sourceStart: time(1, 4), speed: time(1) },
  valid = { start: time(0), end: time(1) };
const pcm = (plan: WindowPlan): PcmWindow => ({
  first: plan.first,
  rate: plan.rate,
  planes: [new Float32Array(plan.end - plan.first).fill(0.2)],
});
const settle = <T>(p: Promise<T>) =>
  p.then(
    (value) => ({ state: 'fulfilled' as const, value }),
    (error) => ({ state: 'rejected' as const, error }),
  );
it('abort listener render(200) owns the session; outer render(100) never starts decode', async () => {
  const calls: number[] = [];
  let late!: () => void, latest: ReturnType<typeof settle<PcmWindow>> | undefined;
  const session = new PcmRenderSession({
    decode: (plan, signal) => {
      calls.push(plan.first);
      if (calls.length === 1) {
        signal.addEventListener(
          'abort',
          () => {
            latest = settle(
              session.render(
                mapping,
                200,
                300,
                48000,
                44100,
                valid,
                1,
                new AbortController().signal,
              ),
            );
          },
          { once: true },
        );
        return new Promise((resolve) => {
          late = () => resolve(pcm(plan));
        });
      }
      return Promise.resolve(pcm(plan));
    },
  });
  const first = settle(
    session.render(mapping, 0, 100, 48000, 44100, valid, 1, new AbortController().signal),
  );
  const outer = await settle(
    session.render(mapping, 100, 200, 48000, 44100, valid, 1, new AbortController().signal),
  );
  const winner = await latest!;
  late();
  const retired = await first;
  expect(outer.state).toBe('rejected');
  expect(winner.state).toBe('fulfilled');
  if (winner.state === 'fulfilled') expect(winner.value.first).toBe(200);
  expect(retired.state).toBe('rejected');
  expect(calls).toEqual([
    planWindow(mapping, 0, 100, 48000, 44100, valid, 1).first,
    planWindow(mapping, 200, 300, 48000, 44100, valid, 1).first,
  ]);
});
it('abort listener dispose prevents the outer request from allocating a decoder', async () => {
  let calls = 0,
    late!: () => void;
  const session = new PcmRenderSession({
    decode: (plan, signal) => {
      calls++;
      signal.addEventListener('abort', () => session.dispose(), { once: true });
      if (calls === 1)
        return new Promise((resolve) => {
          late = () => resolve(pcm(plan));
        });
      return Promise.resolve(pcm(plan));
    },
  });
  const first = settle(
    session.render(mapping, 0, 100, 48000, 44100, valid, 1, new AbortController().signal),
  );
  const outer = await settle(
    session.render(mapping, 100, 200, 48000, 44100, valid, 1, new AbortController().signal),
  );
  late();
  await first;
  expect(outer.state).toBe('rejected');
  expect(calls).toBe(1);
  await expect(
    session.render(mapping, 200, 300, 48000, 44100, valid, 1, new AbortController().signal),
  ).rejects.toThrow('disposed');
});
it('caller abort during old-owner notification is observed before decode', async () => {
  const caller = new AbortController();
  let calls = 0,
    late!: () => void;
  const session = new PcmRenderSession({
    decode: (plan, signal) => {
      calls++;
      signal.addEventListener('abort', () => caller.abort(), { once: true });
      if (calls === 1)
        return new Promise((resolve) => {
          late = () => resolve(pcm(plan));
        });
      return Promise.resolve(pcm(plan));
    },
  });
  const first = settle(
    session.render(mapping, 0, 100, 48000, 44100, valid, 1, new AbortController().signal),
  );
  const outer = await settle(
    session.render(mapping, 100, 200, 48000, 44100, valid, 1, caller.signal),
  );
  late();
  await first;
  expect(outer.state).toBe('rejected');
  expect(calls).toBe(1);
});
