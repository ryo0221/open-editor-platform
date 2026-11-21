import { easingProgress } from '@editor-platform/easing';
import { requireAnimation as check, type Rational, type TimeMapping, type Keyframe } from './model';
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
export { easingProgress };
const ease = easingProgress;
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
