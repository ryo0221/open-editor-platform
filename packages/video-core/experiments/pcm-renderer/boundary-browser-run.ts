import { time, add, multiply, compare } from '@editor-platform/video-core';
import {
  planWindow,
  renderPcm,
  sampleSpan,
  type Mapping,
  type BoundaryMode,
} from '../../src/pcm/render';
// @ts-expect-error Isolated fixed-dependency experiment, not a public adapter.
import { decodeWindow } from './native-aac.mjs';
// @ts-expect-error Reviewed saved timing experiment, not a package API.
import { savedTiming } from '../local-codec/browser-aac.mjs';
const need = (ok: unknown, message: string) => {
  if (!ok) throw Error(message);
};
export async function boundaries(bytes: number[], rate: number, count: number) {
  const buffer = new Uint8Array(bytes).buffer,
    timing = savedTiming(buffer, { rationalEdges: true }),
    valid = {
      start: time(timing.validStart, rate),
      end: time(Number(timing.validEnd.n), Number(timing.validEnd.d) * rate),
    };
  const mapping: Mapping = {
      start: time(0),
      end: time(count, rate),
      sourceStart: valid.start,
      speed: time(1),
    },
    outputRate = 48000,
    rows = [];
  for (const mode of ['edge-hold-v0', 'valid-taps-v0'] as const) {
    let calls = 0,
      maxPcm = 0;
    const render = async (m: Mapping, policy: Exclude<BoundaryMode, 'require-support'>) => {
      const span = sampleSpan(m, outputRate),
        output = [new Float32Array(span.end - span.first), new Float32Array(span.end - span.first)];
      for (let first = span.first; first < span.end; first += 4096) {
        const end = Math.min(first + 4096, span.end),
          plan = planWindow(m, first, end, outputRate, rate, valid, 2, policy);
        const pcm = await decodeWindow(buffer, plan, new AbortController().signal);
        calls++;
        maxPcm = Math.max(maxPcm, pcm.evidence.retainedPcmBytes);
        const rendered = renderPcm(m, first, end, outputRate, pcm, new AbortController().signal, {
          mode: policy,
          valid,
        });
        for (let ch = 0; ch < 2; ch++) output[ch].set(rendered.planes[ch], first - span.first);
      }
      return output;
    };
    const output = await render(mapping, mode),
      span = sampleSpan(mapping, outputRate),
      cut = time(1001, 30000);
    need(output[0].length === Math.ceil((count * outputRate) / rate), 'Global sample membership');
    let split = 'not-applicable-shorter-than-cut';
    if (compare(mapping.end, cut) > 0) {
      const a = { ...mapping, end: cut },
        b = { ...mapping, start: cut, sourceStart: add(mapping.sourceStart, cut) };
      const left = await render(a, mode),
        right = await render(b, mode),
        boundary = sampleSpan(a, outputRate).end;
      for (let ch = 0; ch < 2; ch++) {
        const joined = new Float32Array(span.end);
        joined.set(left[ch]);
        joined.set(right[ch], boundary);
        need(
          joined.every((x, i) => Object.is(x, output[ch][i])),
          'Independently decoded split changed PCM',
        );
      }
      split = 'PASS-independent-plans-and-native-decodes';
    }
    need(
      output.every((p) => p.every(Number.isFinite)),
      'Nonfinite boundary result',
    );
    if (count === 1) {
      for (const p of output)
        need(
          p.every((x) => x === p[0]),
          'One actual sample must extend as constant',
        );
    }
    rows.push({
      mode,
      state: 'PASS',
      rate,
      sourceFrames: count,
      sourceDuration: multiply(time(count), time(1, rate)),
      outputFrames: output[0].length,
      maxPcmBytes: maxPcm,
      decodeCalls: calls,
      split,
      maxAmplitude: Math.max(...output.flatMap((p) => Array.from(p, Math.abs))),
    });
  }
  return rows;
}
