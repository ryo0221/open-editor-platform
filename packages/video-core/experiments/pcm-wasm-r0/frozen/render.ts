/** Private renderer plan; not a second native model or a public Core export. */
import {
  add,
  subtract,
  multiply,
  compare,
  isTime,
  time,
  frameTime,
  type Time,
} from './time';
export interface Mapping {
  start: Time;
  end: Time;
  sourceStart: Time;
  speed: Time;
}
export interface PcmWindow {
  first: number;
  rate: number;
  planes: Float32Array[];
}
export interface WindowPlan {
  first: number;
  end: number;
  rate: number;
  channels: number;
}
export const LIMITS = Object.freeze({
  outputFrames: 4096,
  windowFrames: 32768,
  channels: 2,
  filterRadius: 256,
});
function need(ok: unknown, message: string): asserts ok {
  if (!ok) throw Error(message);
}
function rate(r: number) {
  need(Number.isSafeInteger(r) && r >= 8000 && r <= 96000, 'Sample rate profile');
}
function rationalParts(t: Time) {
  need(isTime(t), 'Noncanonical time');
  return [BigInt(t.value), BigInt(t.timescale)] as const;
}
export function floorTime(t: Time) {
  const [n, d] = rationalParts(t);
  const q = n / d;
  return Number(q - (n < 0n && n % d !== 0n ? 1n : 0n));
}
export function ceilTime(t: Time) {
  const [n, d] = rationalParts(t);
  const q = n / d;
  return Number(q + (n > 0n && n % d !== 0n ? 1n : 0n));
}
export function validateMapping(m: Mapping) {
  need([m.start, m.end, m.sourceStart, m.speed].every(isTime), 'Invalid mapping');
  need(
    compare(m.start, time(0)) >= 0 &&
      compare(m.end, m.start) > 0 &&
      compare(m.speed, time(1, 4)) >= 0 &&
      compare(m.speed, time(4)) <= 0,
    'Mapping profile',
  );
}
export function sourceAt(m: Mapping, at: Time): Time {
  validateMapping(m);
  need(compare(at, m.start) >= 0 && compare(at, m.end) < 0, 'Outside clip');
  return add(m.sourceStart, multiply(subtract(at, m.start), m.speed));
}
export function sampleSpan(m: Mapping, outputRate: number) {
  validateMapping(m);
  rate(outputRate);
  return {
    first: ceilTime(multiply(m.start, time(outputRate))),
    end: ceilTime(multiply(m.end, time(outputRate))),
  };
}
/** Video frame queries and PCM use precisely the same rational mapping. No media-element clock. */
export function frameSource(m: Mapping, index: number, fps: Time) {
  return sourceAt(m, frameTime(index, fps));
}
function filter(sourceRate: number, outputRate: number, speed: Time) {
  rate(sourceRate);
  rate(outputRate);
  const cutoff = Math.min(1, outputRate / (sourceRate * (speed.value / speed.timescale))) * 0.95;
  const radius = Math.ceil(32 / cutoff);
  need(radius <= LIMITS.filterRadius, 'Resampling ratio exceeds filter budget');
  return { cutoff, radius };
}
function checkRange(m: Mapping, first: number, end: number, outputRate: number) {
  const span = sampleSpan(m, outputRate);
  need(
    Number.isSafeInteger(first) &&
      Number.isSafeInteger(end) &&
      first >= span.first &&
      end <= span.end &&
      end > first &&
      end - first <= LIMITS.outputFrames,
    'Output frame budget/range',
  );
}
function sourcePosition(m: Mapping, k: number, outputRate: number, sourceRate: number) {
  return multiply(sourceAt(m, time(k, outputRate)), time(sourceRate));
}
export type BoundaryMode = 'require-support' | 'edge-hold-v0' | 'valid-taps-v0';
export interface SourceBoundary {
  mode: Exclude<BoundaryMode, 'require-support'>;
  valid: { start: Time; end: Time };
}
function domain(m: Mapping, valid: { start: Time; end: Time }, sourceRate: number) {
  need(
    isTime(valid.start) &&
      isTime(valid.end) &&
      compare(valid.start, time(0)) >= 0 &&
      compare(valid.end, valid.start) > 0,
    'Source validity',
  );
  need(
    compare(m.sourceStart, valid.start) >= 0 &&
      compare(add(m.sourceStart, multiply(subtract(m.end, m.start), m.speed)), valid.end) <= 0,
    'Clip outside original validity',
  );
  const first = ceilTime(multiply(valid.start, time(sourceRate))),
    end = ceilTime(multiply(valid.end, time(sourceRate)));
  need(end > first, 'No valid source sample points');
  return { first, end };
}
export function planWindow(
  m: Mapping,
  first: number,
  end: number,
  outputRate: number,
  sourceRate: number,
  valid: { start: Time; end: Time },
  channels: number,
  boundary: BoundaryMode = 'require-support',
): WindowPlan {
  checkRange(m, first, end, outputRate);
  need(
    Number.isInteger(channels) && channels >= 1 && channels <= LIMITS.channels,
    'Channel budget',
  );
  need(
    isTime(valid.start) && isTime(valid.end) && compare(valid.end, valid.start) > 0,
    'Source validity',
  );
  const { radius } = filter(sourceRate, outputRate, m.speed);
  let lo = floorTime(sourcePosition(m, first, outputRate, sourceRate)) - radius;
  let hi = floorTime(sourcePosition(m, end - 1, outputRate, sourceRate)) + radius + 1;
  need(
    ['require-support', 'edge-hold-v0', 'valid-taps-v0'].includes(boundary),
    'Unknown boundary policy',
  );
  const source = domain(m, valid, sourceRate);
  if (boundary !== 'require-support') {
    lo = Math.max(lo, source.first);
    hi = Math.min(hi, source.end);
  }
  need(lo >= 0 && hi > lo && hi - lo <= LIMITS.windowFrames, 'PCM window budget');
  // Conservative full kernel support is required. There is no implicit endpoint extension.
  need(
    compare(time(lo, sourceRate), valid.start) >= 0 &&
      compare(time(hi - 1, sourceRate), valid.end) < 0,
    'Insufficient original filter support',
  );
  return { first: lo, end: hi, rate: sourceRate, channels };
}
export class WindowCollector {
  private planes: Float32Array[];
  private seen: Uint8Array;
  private received = 0;
  private closed = false;
  constructor(readonly plan: WindowPlan) {
    rate(plan.rate);
    need(
      Number.isSafeInteger(plan.first) &&
        Number.isSafeInteger(plan.end) &&
        plan.first >= 0 &&
        plan.end > plan.first &&
        plan.end - plan.first <= LIMITS.windowFrames,
      'PCM window budget',
    );
    need(
      Number.isInteger(plan.channels) && plan.channels >= 1 && plan.channels <= LIMITS.channels,
      'Channel budget',
    );
    this.planes = Array.from(
      { length: plan.channels },
      () => new Float32Array(plan.end - plan.first),
    );
    this.seen = new Uint8Array(plan.end - plan.first);
  }
  push(block: PcmWindow) {
    need(!this.closed, 'Collector closed');
    const frames = block.planes[0]?.length;
    need(
      block.rate === this.plan.rate &&
        block.planes.length === this.plan.channels &&
        Number.isSafeInteger(block.first) &&
        frames > 0 &&
        frames <= 4096 &&
        block.planes.every((p) => p instanceof Float32Array && p.length === frames),
      'Decoded block shape',
    );
    const lo = Math.max(block.first, this.plan.first),
      hi = Math.min(block.first + frames, this.plan.end);
    for (let i = lo; i < hi; i++) {
      const out = i - this.plan.first,
        offset = i - block.first;
      need(!this.seen[out], 'Overlapping decoded coverage');
      for (let ch = 0; ch < this.planes.length; ch++) {
        const value = block.planes[ch][offset];
        need(Number.isFinite(value), 'Nonfinite PCM');
        this.planes[ch][out] = value;
      }
      this.seen[out] = 1;
      this.received++;
    }
  }
  finish(): PcmWindow {
    need(!this.closed, 'Collector closed');
    need(this.received === this.seen.length, 'Missing decoded coverage');
    this.closed = true;
    const planes = this.planes;
    this.planes = [];
    this.seen = new Uint8Array();
    return { first: this.plan.first, rate: this.plan.rate, planes };
  }
  release() {
    this.closed = true;
    this.planes = [];
    this.seen = new Uint8Array();
  }
}
const sinc = (x: number) => (Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
/** Windowed-sinc prototype; Float32 amplitudes, exact rational timing and cut membership. */
export function renderPcm(
  m: Mapping,
  first: number,
  end: number,
  outputRate: number,
  pcm: PcmWindow,
  signal: AbortSignal,
  boundary?: SourceBoundary,
) {
  signal.throwIfAborted();
  checkRange(m, first, end, outputRate);
  const { cutoff, radius } = filter(pcm.rate, outputRate, m.speed),
    channels = pcm.planes.length,
    frames = pcm.planes[0]?.length;
  need(
    channels >= 1 &&
      channels <= LIMITS.channels &&
      frames > 0 &&
      frames <= LIMITS.windowFrames &&
      pcm.planes.every((p) => p.length === frames),
    'PCM shape',
  );
  if (boundary)
    need(['edge-hold-v0', 'valid-taps-v0'].includes(boundary.mode), 'Unknown boundary policy');
  const source = boundary ? domain(m, boundary.valid, pcm.rate) : undefined;
  const output = Array.from({ length: channels }, () => new Float32Array(end - first));
  for (let k = first; k < end; k++) {
    signal.throwIfAborted();
    const exact = sourcePosition(m, k, outputRate, pcm.rate),
      center = floorTime(exact);
    // Convert only the bounded fractional phase, never a large absolute clock, to float.
    const phase =
      Number(BigInt(exact.value) - BigInt(center) * BigInt(exact.timescale)) / exact.timescale;
    need(
      source || (center - radius >= pcm.first && center + radius < pcm.first + frames),
      'Missing filter support',
    );
    let total = 0;
    const sums = new Float64Array(channels);
    for (let tap = -radius; tap <= radius; tap++) {
      const distance = tap - phase;
      if (Math.abs(distance) >= radius) continue;
      const window =
        0.42 +
        0.5 * Math.cos((Math.PI * distance) / radius) +
        0.08 * Math.cos((2 * Math.PI * distance) / radius);
      const rawIndex = center + tap;
      if (
        source &&
        boundary!.mode === 'valid-taps-v0' &&
        (rawIndex < source.first || rawIndex >= source.end)
      )
        continue;
      const sample =
        source && boundary!.mode === 'edge-hold-v0'
          ? Math.max(source.first, Math.min(source.end - 1, rawIndex))
          : rawIndex;
      // Clamp only outside the declared physical source domain, never to this
      // decoder window. A missing in-domain/endpoint sample remains an error.
      need(sample >= pcm.first && sample < pcm.first + frames, 'Missing filter support');
      const weight = cutoff * sinc(cutoff * distance) * window,
        index = sample - pcm.first;
      total += weight;
      for (let ch = 0; ch < channels; ch++) {
        const value = pcm.planes[ch][index];
        need(Number.isFinite(value), 'Nonfinite PCM');
        sums[ch] += value * weight;
      }
    }
    need(Math.abs(total) > 1e-9, 'Degenerate filter');
    for (let ch = 0; ch < channels; ch++) output[ch][k - first] = sums[ch] / total;
  }
  return { first, rate: outputRate, planes: output };
}

/** Prefix preroll is bounded; no random-access AAC recovery distance is assumed. */
export function prefixEnd(
  samples: readonly { pts: number; duration: number }[],
  end: number,
): number {
  need(
    Number.isSafeInteger(end) && end > 0 && samples.length > 0 && samples.length <= 10000,
    'Sample index budget',
  );
  let cursor = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    need(
      Number.isSafeInteger(s.pts) &&
        Number.isSafeInteger(s.duration) &&
        s.duration > 0 &&
        s.pts === cursor,
      'Raw sample coverage',
    );
    cursor += s.duration;
    need(Number.isSafeInteger(cursor), 'Raw sample overflow');
    if (cursor >= end) {
      need(i < 2048, 'Seek/preroll packet budget');
      return i;
    }
    need(i < 2047, 'Seek/preroll packet budget');
  }
  throw Error('Missing raw sample coverage');
}
