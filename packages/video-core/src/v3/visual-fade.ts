import { add, compare, isTime, type Time } from '../time';
import type { ClipV3 } from './model';
type Fraction = readonly [bigint, bigint];
const fraction = (t: Time): Fraction => [BigInt(t.value), BigInt(t.timescale)];
const minus = (a: Fraction, b: Fraction): Fraction => [a[0] * b[1] - b[0] * a[1], a[1] * b[1]];

/** Valid native endpoints are bounded; intermediate source/envelope fractions need not be. */
export function visualOpacityV3(
  clip: ClipV3,
  sequenceTime: Time,
  outsidePlacement = false,
): number {
  if (!isTime(sequenceTime)) throw Error('Invalid visual evaluation time');
  if (
    !outsidePlacement &&
    (compare(sequenceTime, clip.start) < 0 ||
      compare(sequenceTime, add(clip.start, clip.duration)) >= 0)
  )
    return 0;
  if (clip.kind === 'audio' || !clip.visualFade) return 1;
  const offset = minus(fraction(sequenceTime), fraction(clip.start));
  const rate = fraction(clip.rate);
  const scaled: Fraction = [offset[0] * rate[0], offset[1] * rate[1]];
  const input = fraction(clip.sourceIn);
  const source: Fraction = [input[0] * scaled[1] + scaled[0] * input[1], input[1] * scaled[1]];
  const incoming = minus(source, fraction(clip.visualFade.start));
  const outgoing = minus(fraction(clip.visualFade.end), source);
  if (
    (incoming[0] < 0n && (!outsidePlacement || clip.visualFade.in.value > 0)) ||
    (outgoing[0] <= 0n && (!outsidePlacement || clip.visualFade.out.value > 0))
  )
    return 0;
  let opacity = 1;
  for (const [distance, duration] of [
    [incoming, clip.visualFade.in],
    [outgoing, clip.visualFade.out],
  ] as const) {
    if (duration.value === 0) continue;
    const numerator = distance[0] * BigInt(duration.timescale);
    const denominator = distance[1] * BigInt(duration.value);
    const amount =
      numerator <= 0n ? 0 : numerator >= denominator ? 1 : Number(numerator) / Number(denominator);
    opacity = Math.min(opacity, amount);
  }
  return opacity;
}
