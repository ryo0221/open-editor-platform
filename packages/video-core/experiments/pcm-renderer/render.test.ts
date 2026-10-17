import { expect, it } from 'vitest';
import { add, time, multiply } from '@editor-platform/video-core';
import {
  renderPcm,
  prefixEnd,
  sampleSpan,
  sourceAt,
  frameSource,
  planWindow,
  WindowCollector,
  LIMITS,
  type Mapping,
  type PcmWindow,
} from './render';
import { PcmRenderSession } from './session';
const signal = () => new AbortController().signal;
const cut = time(1001, 30000);
const mapping = (end = time(1, 10)): Mapping => ({
  start: time(0),
  end,
  sourceStart: time(1, 4),
  speed: time(1),
});
function pcm(rate: number, freq = 1000): PcmWindow {
  return {
    first: 0,
    rate,
    planes: [
      Float32Array.from({ length: 32768 }, (_, i) => Math.sin((2 * Math.PI * freq * i) / rate)),
    ],
  };
}
function parts(m: Mapping, rate: number, input: PcmWindow, chunk: number) {
  const span = sampleSpan(m, rate),
    out = new Float32Array(span.end - span.first);
  for (let i = span.first; i < span.end; i += chunk) {
    const result = renderPcm(m, i, Math.min(i + chunk, span.end), rate, input, signal());
    out.set(result.planes[0], i - span.first);
  }
  return out;
}
it.each([44100, 48000])(
  '29.97 cuts retain rational source edges at %i Hz and share the absolute output grid',
  (sourceRate) => {
    for (const outputRate of [44100, 48000]) {
      const whole = mapping(multiply(cut, time(6))),
        input = pcm(sourceRate);
      const reference = parts(whole, outputRate, input, 1024),
        joined: number[] = [];
      for (let frame = 0; frame < 6; frame++) {
        const start = multiply(cut, time(frame)),
          end = add(start, cut);
        const clip = { ...whole, start, end, sourceStart: add(whole.sourceStart, start) };
        joined.push(...parts(clip, outputRate, input, 257));
        expect(sourceAt(clip, start)).toEqual(add(time(1, 4), start));
      }
      expect(Float32Array.from(joined)).toEqual(reference);
      expect(sampleSpan({ ...whole, end: cut }, outputRate).end).toBe(
        outputRate === 44100 ? 1472 : 1602,
      );
      expect(multiply(cut, time(sourceRate)).timescale).toBeGreaterThan(1);
      expect(frameSource(whole, 1, time(30000, 1001))).toEqual(add(time(1, 4), cut));
    }
  },
);
it('fractional source phase matches a sine oracle and preview/export chunking is identical', () => {
  const m = { ...mapping(), sourceStart: add(time(1, 4), time(1, 3 * 44100)) },
    input = pcm(44100);
  const preview = parts(m, 48000, input, 128),
    exported = parts(m, 48000, input, 4096);
  expect(preview).toEqual(exported);
  for (let k = 0; k < preview.length; k++) {
    const t = sourceAt(m, time(k, 48000));
    expect(
      Math.abs(preview[k] - Math.sin((2 * Math.PI * 1000 * t.value) / t.timescale)),
    ).toBeLessThan(0.0002);
  }
});
it('downsampling rejects a high-frequency alias while preserving an in-band tone', () => {
  const m = mapping(),
    high = parts(m, 16000, pcm(48000, 18000), 512),
    low = parts(m, 16000, pcm(48000, 1000), 512);
  const rms = (v: Float32Array) => Math.sqrt(v.reduce((s, x) => s + x * x, 0) / v.length);
  expect(rms(high)).toBeLessThan(0.001);
  expect(rms(low)).toBeGreaterThan(0.7);
});
it('constant amplitude is retained at fractional phases without phase-dependent gain', () => {
  const input = pcm(44100);
  input.planes[0].fill(0.3);
  const m = { ...mapping(), sourceStart: add(time(1, 4), time(1, 7 * 44100)) };
  for (const x of parts(m, 48000, input, 333)) expect(Math.abs(x - 0.3)).toBeLessThan(0.000001);
});
it('coverage collector rejects one missing sample, overlap, changed format and nonfinite PCM', () => {
  const plan = { first: 100, end: 200, rate: 48000, channels: 1 };
  const c = new WindowCollector(plan);
  c.push({ first: 100, rate: 48000, planes: [new Float32Array(99)] });
  expect(() => c.finish()).toThrow('Missing');
  expect(() => c.push({ first: 100, rate: 48000, planes: [new Float32Array(1)] })).toThrow(
    'Overlapping',
  );
  const bad = new WindowCollector(plan);
  expect(() => bad.push({ first: 100, rate: 44100, planes: [new Float32Array(100)] })).toThrow(
    'shape',
  );
  const data = new Float32Array(100);
  data[20] = NaN;
  expect(() => bad.push({ first: 100, rate: 48000, planes: [data] })).toThrow('Nonfinite');
  c.release();
  bad.release();
  expect(() => c.finish()).toThrow('closed');
});
it('collector orders timestamped blocks by location, never pads or concatenates arrival order', () => {
  const c = new WindowCollector({ first: 10, end: 14, rate: 48000, channels: 1 });
  c.push({ first: 12, rate: 48000, planes: [new Float32Array([3, 4])] });
  c.push({ first: 10, rate: 48000, planes: [new Float32Array([1, 2])] });
  expect(c.finish().planes[0]).toEqual(new Float32Array([1, 2, 3, 4]));
});
it('window support and explicit memory/output bounds reject before rendering; no implicit edge padding', () => {
  const m = mapping();
  const plan = planWindow(m, 0, 1024, 48000, 44100, { start: time(0), end: time(1) }, 2);
  expect(plan.end - plan.first).toBeLessThan(LIMITS.windowFrames);
  expect(() =>
    planWindow(
      { ...m, sourceStart: time(0) },
      0,
      1024,
      48000,
      44100,
      { start: time(0), end: time(1) },
      2,
    ),
  ).toThrow();
  expect(() => renderPcm(m, 0, 4097, 48000, pcm(44100), signal())).toThrow('budget');
  expect(() => new WindowCollector({ ...plan, end: plan.first + LIMITS.windowFrames + 1 })).toThrow(
    'budget',
  );
  expect(() =>
    renderPcm(
      m,
      0,
      100,
      48000,
      { first: 11025, rate: 44100, planes: [new Float32Array(100)] },
      signal(),
    ),
  ).toThrow('support');
});
it('superseding seek aborts the previous decode and never publishes its late result', async () => {
  const pending: { signal: AbortSignal; resolve: (v: PcmWindow) => void }[] = [];
  const session = new PcmRenderSession({
    decode: (_plan, abort) => new Promise((resolve) => pending.push({ signal: abort, resolve })),
  });
  const m = mapping(),
    valid = { start: time(0), end: time(1) };
  const first = session.render(m, 0, 100, 48000, 44100, valid, 1, signal());
  const rejected = expect(first).rejects.toThrow();
  const second = session.render(m, 100, 200, 48000, 44100, valid, 1, signal());
  expect(pending[0].signal.aborted).toBe(true);
  pending[1].resolve(pcm(44100));
  expect((await second).first).toBe(100);
  pending[0].resolve(pcm(44100));
  await rejected;
  session.dispose();
  await expect(session.render(m, 0, 100, 48000, 44100, valid, 1, signal())).rejects.toThrow(
    'disposed',
  );
});
it('caller cancellation propagates to decode and rejects even a later successful callback', async () => {
  let complete!: (v: PcmWindow) => void;
  let received: AbortSignal | undefined;
  const session = new PcmRenderSession({
    decode: (_p, s) => {
      received = s;
      return new Promise((r) => {
        complete = r;
      });
    },
  });
  const abort = new AbortController(),
    result = session.render(
      mapping(),
      0,
      100,
      48000,
      44100,
      { start: time(0), end: time(1) },
      1,
      abort.signal,
    );
  const rejected = expect(result).rejects.toThrow();
  abort.abort();
  expect(received!.aborted).toBe(true);
  complete(pcm(44100));
  await rejected;
});

it('prefix seek/preroll bound rejects long scans and packet gaps before decoder allocation', () => {
  const samples = Array.from({ length: 2050 }, (_, i) => ({ pts: i * 1024, duration: 1024 }));
  expect(prefixEnd(samples, 2048 * 1024)).toBe(2047);
  expect(() => prefixEnd(samples, 2048 * 1024 + 1)).toThrow('preroll');
  expect(() =>
    prefixEnd(
      [
        { pts: 0, duration: 1024 },
        { pts: 2048, duration: 1024 },
      ],
      2500,
    ),
  ).toThrow('coverage');
});
