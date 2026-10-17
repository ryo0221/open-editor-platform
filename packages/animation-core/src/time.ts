import {
  requireAnimation as check,
  type Rational,
  type TimeMapping,
  type Easing,
  type Keyframe,
} from './model';
import { tick } from './validate';
export function frameTick(frame: number, timebase: number, fps: Rational): number {
  tick(frame);
  tick(timebase);
  tick(fps.numerator);
  tick(fps.denominator);
  check(timebase > 0 && fps.numerator > 0 && fps.denominator > 0, 'frame-grid', 'frame');
  const step = BigInt(timebase) * BigInt(fps.denominator);
  check(step % BigInt(fps.numerator) === 0n, 'frame-grid', 'frame');
  const result = (step / BigInt(fps.numerator)) * BigInt(frame);
  check(result <= BigInt(Number.MAX_SAFE_INTEGER), 'overflow', 'frame');
  return Number(result);
}
export function mapNestedTick(
  elapsed: number,
  parentTimebase: number,
  childTimebase: number,
  time: TimeMapping,
): number | null {
  for (const n of [
    elapsed,
    parentTimebase,
    childTimebase,
    time.sourceIn,
    time.sourceOut,
    time.rate.numerator,
    time.rate.denominator,
  ])
    tick(n);
  check(
    parentTimebase > 0 &&
      childTimebase > 0 &&
      time.rate.numerator > 0 &&
      time.rate.denominator > 0 &&
      time.sourceOut > time.sourceIn,
    'time-mapping',
    'nested',
  );
  check(['hold', 'loop', 'hide'].includes(time.after), 'time-mapping', 'after');
  const offset =
    (BigInt(elapsed) * BigInt(time.rate.numerator) * BigInt(childTimebase)) /
    (BigInt(time.rate.denominator) * BigInt(parentTimebase));
  const length = BigInt(time.sourceOut - time.sourceIn);
  if (offset < length) return time.sourceIn + Number(offset);
  if (time.after === 'hide') return null;
  if (time.after === 'hold') return time.sourceOut - 1;
  return time.sourceIn + Number(offset % length);
}
function curve(t: number, a: number, b: number) {
  return 3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
}
function ease(e: Easing, t: number): number {
  if (e.type === 'hold') return 0;
  if (e.type === 'linear' || t === 0 || t === 1) return t;
  let low = 0,
    high = 1;
  for (let i = 0; i < 52; i++) {
    const mid = (low + high) / 2;
    if (curve(mid, e.x1, e.x2) < t) low = mid;
    else high = mid;
  }
  return curve((low + high) / 2, e.y1, e.y2);
}
/** Called only on validator-owned, nonempty sorted tracks. */
export function sampleKeys(keys: readonly Keyframe[], tick: number): number {
  if (tick <= keys[0].tick) return keys[0].value;
  for (let i = 1; i < keys.length; i++) {
    const right = keys[i],
      left = keys[i - 1];
    if (tick === right.tick) return right.value;
    if (tick < right.tick)
      return (
        left.value +
        (right.value - left.value) *
          ease(left.easing, (tick - left.tick) / (right.tick - left.tick))
      );
  }
  return keys[keys.length - 1].value;
}
