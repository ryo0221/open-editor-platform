import { expect, it } from 'vitest';
import { PcmRenderSession } from './session';
import { time, multiply, add, subtract } from '@editor-platform/video-core';
import {
  planWindow,
  renderPcm,
  sampleSpan,
  WindowCollector,
  type Mapping,
  type PcmWindow,
  type BoundaryMode,
} from './render';
const signal = () => new AbortController().signal;
const map = (count: number, rate: number): Mapping => ({
  start: time(0),
  end: time(count, rate),
  sourceStart: time(0),
  speed: time(1),
});
function decode(
  plan: { first: number; end: number; rate: number },
  source: Float32Array,
): PcmWindow {
  const c = new WindowCollector({ ...plan, channels: 1 });
  for (let i = plan.first; i < plan.end; i += 1024)
    c.push({ first: i, rate: plan.rate, planes: [source.slice(i, Math.min(i + 1024, plan.end))] });
  return c.finish();
}
function render(
  m: Mapping,
  source: Float32Array,
  rate: number,
  outRate: number,
  mode: Exclude<BoundaryMode, 'require-support'>,
  chunk = 1024,
) {
  const valid = { start: time(0), end: time(source.length, rate) },
    span = sampleSpan(m, outRate),
    out = new Float32Array(span.end - span.first);
  for (let k = span.first; k < span.end; k += chunk) {
    const end = Math.min(k + chunk, span.end),
      plan = planWindow(m, k, end, outRate, rate, valid, 1, mode),
      pcm = decode(plan, source);
    out.set(
      renderPcm(m, k, end, outRate, pcm, signal(), { mode, valid }).planes[0],
      k - span.first,
    );
  }
  return out;
}
it.each([1, 2, 17, 1024])(
  'both proposals render full %i-sample constant sources without invented decoded coverage',
  (count) => {
    for (const rate of [44100, 48000])
      for (const outputRate of [44100, 48000])
        for (const mode of ['edge-hold-v0', 'valid-taps-v0'] as const) {
          const original = new Float32Array(count).fill(0.3),
            result = render(map(count, rate), original, rate, outputRate, mode);
          expect(result.length).toBe(Math.ceil((count * outputRate) / rate));
          expect(result.every((x) => Math.abs(x - 0.3) < 1e-6)).toBe(true);
          expect(original.every((x) => x === Math.fround(0.3))).toBe(true);
        }
  },
);
it('edge-hold matches a separately materialized virtual endpoint-extension oracle', () => {
  for (const count of [1, 2, 17])
    for (const rate of [44100, 48000]) {
      const source = Float32Array.from({ length: count }, (_, i) => (i % 2 ? -0.75 : 0.5)),
        m = map(count, rate),
        padded = new Float32Array(count + 512);
      padded.fill(source[0], 0, 256);
      padded.set(source, 256);
      padded.fill(source.at(-1)!, 256 + count);
      const shifted = { ...m, sourceStart: time(256, rate) },
        span = sampleSpan(m, 48000);
      const oracle = renderPcm(
        shifted,
        span.first,
        span.end,
        48000,
        { first: 0, rate, planes: [padded] },
        signal(),
      ).planes[0];
      expect(render(m, source, rate, 48000, 'edge-hold-v0')).toEqual(oracle);
    }
});
it('boundary policy never extends a missing decoder window or accepts one missing actual sample', () => {
  const m = map(17, 48000),
    valid = { start: time(0), end: m.end };
  for (const mode of ['edge-hold-v0', 'valid-taps-v0'] as const) {
    const plan = planWindow(m, 0, 17, 48000, 48000, valid, 1, mode),
      c = new WindowCollector(plan);
    c.push({ first: 0, rate: 48000, planes: [new Float32Array(16)] });
    expect(() => c.finish()).toThrow('Missing decoded');
    expect(() =>
      renderPcm(
        m,
        0,
        17,
        48000,
        { first: 1, rate: 48000, planes: [new Float32Array(16)] },
        signal(),
        { mode, valid },
      ),
    ).toThrow('Missing filter support');
  }
});
it('source endpoints are independent of edits: separately planned/decoded split sides equal unsplit full render', () => {
  const rate = 48000,
    source = Float32Array.from({ length: 9600 }, (_, i) =>
      Math.sin((2 * Math.PI * 17000 * i) / rate),
    ),
    m = map(source.length, rate),
    cut = time(1001, 30000);
  for (const mode of ['edge-hold-v0', 'valid-taps-v0'] as const) {
    const whole = render(m, source, rate, 44100, mode, 997),
      joined: number[] = [];
    let start = time(0);
    for (let n = 1; n <= 6; n++) {
      const end = n === 6 ? m.end : multiply(cut, time(n));
      const clip = { ...m, start, end, sourceStart: start };
      joined.push(...render(clip, source, rate, 44100, mode, 257));
      start = end;
    }
    expect(Float32Array.from(joined)).toEqual(whole);
  }
});
it('fractional physical end retains exact global-grid membership and rejects mapping beyond validity', () => {
  const rate = 48000,
    source = new Float32Array(1602).fill(0.2),
    end = time(1001, 30000),
    m = { ...map(1602, rate), end },
    valid = { start: time(0), end };
  for (const mode of ['edge-hold-v0', 'valid-taps-v0'] as const) {
    const span = sampleSpan(m, 44100),
      plan = planWindow(m, span.first, span.end, 44100, rate, valid, 1, mode);
    const result = renderPcm(m, span.first, span.end, 44100, decode(plan, source), signal(), {
      mode,
      valid,
    });
    expect(result.planes[0]).toHaveLength(1472);
    expect(plan.end).toBe(1602);
    const beyond = { ...m, end: add(end, time(1, rate)) };
    expect(() => planWindow(beyond, 0, 1, 44100, rate, valid, 1, mode)).toThrow('outside original');
    expect(subtract(end, time(1601, rate))).toEqual(time(3, 5 * rate));
  }
});
it('finite-domain renormalization exposes high endpoint gain on a two-sample ramp', () => {
  for (const [rate, outputRate] of [
    [8000, 96000],
    [44100, 48000],
  ]) {
    const source = new Float32Array([0, 1]),
      m = map(2, rate);
    const hold = render(m, source, rate, outputRate, 'edge-hold-v0'),
      renormalized = render(m, source, rate, outputRate, 'valid-taps-v0');
    expect(Math.max(...hold)).toBeLessThan(1.2);
    expect(Math.max(...renormalized)).toBeGreaterThan(2);
  }
});
it('endpoint impulses remain finite and in-band filtering does not hide interior anti-alias failure', () => {
  const rate = 48000,
    count = 9600,
    m = map(count, rate),
    high = Float32Array.from({ length: count }, (_, i) =>
      Math.sin((2 * Math.PI * 18000 * i) / rate),
    );
  for (const mode of ['edge-hold-v0', 'valid-taps-v0'] as const) {
    const output = render(m, high, rate, 16000, mode),
      interior = output.slice(128, -128);
    expect(Math.sqrt(interior.reduce((n, x) => n + x * x, 0) / interior.length)).toBeLessThan(
      0.001,
    );
    for (const at of [0, count - 1]) {
      const impulse = new Float32Array(count);
      impulse[at] = 1;
      const result = render(m, impulse, rate, 44100, mode);
      expect(result.every(Number.isFinite)).toBe(true);
      expect(Math.max(...result.map(Math.abs))).toBeLessThan(2);
    }
  }
});

it('explicit session policy renders a full one-sample source while the strict default remains opt-in unchanged', async () => {
  const m = map(1, 44100),
    valid = { start: time(0), end: m.end },
    source = new Float32Array([0.3]);
  const decoder = {
    decode: async (plan: { first: number; end: number; rate: number }) => decode(plan, source),
  };
  const strict = new PcmRenderSession(decoder);
  await expect(strict.render(m, 0, 2, 48000, 44100, valid, 1, signal())).rejects.toThrow();
  const candidate = new PcmRenderSession(decoder, 'edge-hold-v0');
  const output = await candidate.render(m, 0, 2, 48000, 44100, valid, 1, signal());
  expect(output.planes[0]).toEqual(new Float32Array([0.3, 0.3]));
  candidate.dispose();
  strict.dispose();
});
