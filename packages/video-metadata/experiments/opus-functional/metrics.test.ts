import { expect, it } from 'vitest';
import { metrics } from './metrics.mjs';
import { signal } from './signal.mjs';
it('passes exact signals including infinite SNR without offset/gain fitting', () => {
  const input = signal(4800);
  for (const c of [0, 1]) expect(metrics(input, input, c, 0.125, 0.125).pass).toBe(true);
});
it.each(['extra', 'missing', 'tail', 'swap', 'silence', 'timestamp'])(
  'refuses %s rather than hiding it with alignment',
  (kind) => {
    const input = signal(4800);
    let output = Float32Array.from(input),
      timestamp = 0;
    if (kind === 'extra') output = new Float32Array(input.length + 2);
    if (kind === 'missing') output = output.slice(0, -2);
    if (kind === 'tail') output.fill(0, output.length - 480);
    if (kind === 'swap')
      for (let i = 0; i < output.length; i += 2)
        [output[i], output[i + 1]] = [output[i + 1], output[i]];
    if (kind === 'silence') output.fill(0);
    if (kind === 'timestamp') timestamp = 0.007;
    expect([0, 1].every((c) => metrics(input, output, c, timestamp, 0).pass)).toBe(false);
  },
);
it('makes thresholds independent gates: lossless gain error and PCM displacement refuse', () => {
  const input = signal(4800),
    quiet = Float32Array.from(input, (x) => x * 0.5),
    late = new Float32Array(input.length);
  late.set(input.subarray(0, -100), 100);
  expect(metrics(input, quiet, 0).corr).toBeCloseTo(1);
  expect(metrics(input, quiet, 0).pass).toBe(false);
  expect(metrics(input, late, 0).pass).toBe(false);
});
