import { add, compare, isTime, type Time } from '../time';
import type { AudioClipV2 } from './model';
type Fraction = readonly [bigint, bigint];
const fraction = (t: Time): Fraction => [BigInt(t.value), BigInt(t.timescale)];
const minus = (a: Fraction, b: Fraction): Fraction => [a[0] * b[1] - b[0] * a[1], a[1] * b[1]];
/** Validated native Time stays bounded; intermediate amplitude ratios use exact integers. */
export function audioGainAtV2(clip: AudioClipV2, at: Time): number {
  if (!isTime(at)) throw Error('Invalid gain evaluation time');
  if (compare(at, clip.start) < 0 || compare(at, add(clip.start, clip.duration)) >= 0) return 0;
  // source = sourceIn + (at - start). Do not materialize this or anchor distances
  // as serialized Time: valid bounded endpoints may have a wider exact difference.
  const offset = minus(fraction(at), fraction(clip.start));
  const input = fraction(clip.sourceIn);
  const source: Fraction = [input[0] * offset[1] + offset[0] * input[1], input[1] * offset[1]];
  let envelope = 1;
  for (const [anchor, duration, outgoing] of [
    [clip.fade.start, clip.fade.in, false],
    [clip.fade.end, clip.fade.out, true],
  ] as const) {
    if (duration.value === 0) continue;
    const distance = outgoing ? minus(fraction(anchor), source) : minus(source, fraction(anchor));
    const numerator = distance[0] * BigInt(duration.timescale);
    const denominator = distance[1] * BigInt(duration.value);
    // Compare/clamp exactly before converting the bounded amplitude ratio to float.
    const amount =
      numerator <= 0n ? 0 : numerator >= denominator ? 1 : Number(numerator) / Number(denominator);
    envelope = Math.min(envelope, amount);
  }
  return clip.gain * envelope;
}
