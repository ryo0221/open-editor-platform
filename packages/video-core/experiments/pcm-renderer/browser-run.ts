import { time, add, multiply } from '@editor-platform/video-core';
import { planWindow, renderPcm, sampleSpan } from '../../src/pcm/render';
// Native adapter is an isolated JavaScript experiment with external fixed deps.
// @ts-expect-error No public or product WebCodecs adapter typing is adopted here.
import { decodeWindow } from './native-aac.mjs';
// @ts-expect-error Existing reviewed experiment, intentionally not a package export.
import { savedTiming } from '../local-codec/browser-aac.mjs';
const need = (ok: unknown, message: string) => {
  if (!ok) throw Error(message);
};
const equal = (a: Float32Array, b: Float32Array) =>
  a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
export async function run(bytes: number[], rate: number, count: number) {
  const buffer = new Uint8Array(bytes).buffer,
    timing = savedTiming(buffer, { rationalEdges: true }),
    validStart = timing.validStart;
  const valid = {
    start: time(validStart, rate),
    end: time(Number(timing.validEnd.n), Number(timing.validEnd.d) * rate),
  };
  const sig = () => new AbortController().signal;
  let configured = 0,
    oversized = false;
  try {
    await decodeWindow(
      buffer,
      { first: validStart, end: validStart + 32769, rate, channels: 2 },
      sig(),
      {
        onConfigured: () => {
          configured++;
        },
      },
    );
  } catch (e) {
    oversized = String(e).includes('budget');
  }
  need(oversized && configured === 0, 'Window quota must reject before native allocation');
  const reference = await decodeWindow(
    buffer,
    { first: validStart + 7000, end: validStart + 22000, rate, channels: 2 },
    sig(),
  );
  const seeks = [];
  for (const [lo, hi] of [
    [9000, 14000],
    [12000, 18000],
    [8000, 12000],
  ]) {
    const seek = await decodeWindow(
      buffer,
      { first: validStart + lo, end: validStart + hi, rate, channels: 2 },
      sig(),
    );
    for (let ch = 0; ch < 2; ch++)
      need(
        equal(seek.planes[ch], reference.planes[ch].slice(lo - 7000, hi - 7000)),
        'Seek/preroll PCM differs',
      );
    need(seek.evidence.prerollFromPacket === 0 && seek.evidence.flushes === 1, 'Decode lifetime');
    need(
      seek.evidence.maxQueue <= 8 && seek.evidence.maxOutstanding <= 16,
      'Decode backpressure budget',
    );
    need(seek.evidence.retainedPcmBytes === (hi - lo) * 2 * 4, 'Window memory size');
    seeks.push(seek.evidence);
  }
  let peak = 0;
  for (let i = 0; i < reference.planes[0].length; i++)
    if (Math.abs(reference.planes[0][i]) > Math.abs(reference.planes[0][peak])) peak = i;
  need(Math.abs(peak + 7000 - Math.floor(count / 4)) <= 2, 'Saved fixture impulse moved');
  const cut = time(1001, 30000),
    mapping = {
      start: time(0),
      end: multiply(cut, time(2)),
      sourceStart: time(validStart + 10000, rate),
      speed: time(1),
    },
    outputRate = 48000;
  const span = sampleSpan(mapping, outputRate),
    window = planWindow(mapping, span.first, span.end, outputRate, rate, valid, 2);
  const input = await decodeWindow(buffer, window, sig());
  const whole = renderPcm(mapping, span.first, span.end, outputRate, input, sig());
  const left = { ...mapping, end: cut },
    right = { ...mapping, start: cut, sourceStart: add(mapping.sourceStart, cut) };
  const split = sampleSpan(left, outputRate).end;
  const a = renderPcm(left, 0, split, outputRate, input, sig()),
    b = renderPcm(right, split, span.end, outputRate, input, sig());
  for (let ch = 0; ch < 2; ch++) {
    const joined = new Float32Array(span.end);
    joined.set(a.planes[ch]);
    joined.set(b.planes[ch], split);
    need(equal(joined, whole.planes[ch]), 'Cut changed output phase');
  }
  const abort = new AbortController();
  let cleanup: { decoderClosed: boolean; inputDisposed: boolean } | undefined;
  let submitted = 0,
    cancelled = false;
  try {
    await decodeWindow(buffer, window, abort.signal, {
      onClosed: (value: { decoderClosed: boolean; inputDisposed: boolean }) => {
        cleanup = value;
      },
      onSubmitted: (s: { submitted: number; finalIndex: number }) => {
        submitted = s.submitted;
        need(submitted === 1 && s.finalIndex > 1, 'Cancellation must precede remaining work');
        abort.abort();
      },
    });
  } catch (e) {
    cancelled = e instanceof DOMException && e.name === 'AbortError';
  }
  need(cancelled && submitted === 1, 'Native unfinished decode cancellation');
  need(cleanup?.decoderClosed && cleanup?.inputDisposed, 'Cancel must close native owners');
  const recovered = await decodeWindow(buffer, window, sig());
  need(equal(recovered.planes[0], input.planes[0]), 'Fresh decode after cancel');
  return {
    rate,
    state: 'PASS',
    windowBudgetRejectedBeforeConfigure: oversized,
    seeks,
    split,
    sourceCutSamples: multiply(cut, time(rate)),
    outputFrames: whole.planes[0].length,
    peakAtSource: peak + 7000,
    cancelAfterSubmitted: submitted,
    cancelCleanup: cleanup,
    outputWindow: window,
  };
}
export async function fractional(bytes: number[], rate: number) {
  const buffer = new Uint8Array(bytes).buffer,
    timing = savedTiming(buffer, { rationalEdges: true });
  need(timing.validEnd.d > 1n, 'Fixture must have fractional media end');
  const end = Number((timing.validEnd.n + timing.validEnd.d - 1n) / timing.validEnd.d);
  const result = await decodeWindow(
    buffer,
    { first: timing.validStart, end, rate, channels: 2 },
    new AbortController().signal,
  );
  need(result.planes[0].length === end - timing.validStart, 'Fractional edge sample membership');
  let refused = false;
  try {
    await decodeWindow(
      buffer,
      { first: timing.validStart, end: end + 1, rate, channels: 2 },
      new AbortController().signal,
    );
  } catch {
    refused = true;
  }
  need(refused, 'Sample beyond fractional edge accepted');
  return {
    state: 'PASS',
    rate,
    validStart: timing.validStart,
    validEnd: { n: String(timing.validEnd.n), d: String(timing.validEnd.d) },
    returnedFrames: result.planes[0].length,
    refusedBeyondEdge: refused,
  };
}
