/** Provisional rational seconds. JSON boundaries contain safe integers only. */
export interface Time {
  value: number;
  timescale: number;
}
const MAX = BigInt(Number.MAX_SAFE_INTEGER);
function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  while (b) [a, b] = [b, a % b];
  return a;
}
function reduced(n: bigint, d: bigint): Time {
  if (d <= 0n) throw new Error('Time denominator must be positive');
  const factor = gcd(n, d);
  n /= factor;
  d /= factor;
  if (n > MAX || n < -MAX || d > MAX) throw new Error('Time overflow');
  return { value: Number(n), timescale: Number(d) };
}
export function time(value: number, timescale = 1): Time {
  if (!Number.isSafeInteger(value) || !Number.isSafeInteger(timescale))
    throw new Error('Unsafe time');
  return reduced(BigInt(value), BigInt(timescale));
}
export function isTime(value: unknown): value is Time {
  if (!value || typeof value !== 'object') return false;
  const t = value as Time;
  if (
    Object.keys(t).length !== 2 ||
    !Number.isSafeInteger(t.value) ||
    !Number.isSafeInteger(t.timescale) ||
    t.timescale <= 0 ||
    Object.is(t.value, -0)
  )
    return false;
  const canonical = time(t.value, t.timescale);
  return canonical.value === t.value && canonical.timescale === t.timescale;
}
function check(t: Time) {
  if (!isTime(t)) throw new Error('Noncanonical time');
}
export function add(a: Time, b: Time): Time {
  check(a);
  check(b);
  return reduced(
    BigInt(a.value) * BigInt(b.timescale) + BigInt(b.value) * BigInt(a.timescale),
    BigInt(a.timescale) * BigInt(b.timescale),
  );
}
export function subtract(a: Time, b: Time): Time {
  check(b);
  return add(a, { value: -b.value || 0, timescale: b.timescale });
}
export function multiply(a: Time, b: Time): Time {
  check(a);
  check(b);
  return reduced(BigInt(a.value) * BigInt(b.value), BigInt(a.timescale) * BigInt(b.timescale));
}
export function compare(a: Time, b: Time): number {
  check(a);
  check(b);
  const delta = BigInt(a.value) * BigInt(b.timescale) - BigInt(b.value) * BigInt(a.timescale);
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}
/** Exact sample boundary; never silently rounds source audio edits. */
export function sampleIndex(t: Time, sampleRate: number): number {
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) throw new Error('Invalid sample rate');
  const scaled = multiply(t, time(sampleRate));
  if (scaled.timescale !== 1) throw new Error('Edit is between source samples');
  return scaled.value;
}
/** CFR output timestamps computed from index, never accumulated rounded deltas. */
export function frameTime(index: number, fps: Time): Time {
  if (!Number.isSafeInteger(index) || index < 0 || !isTime(fps) || fps.value <= 0)
    throw new Error('Invalid frame');
  return multiply(time(index), time(fps.timescale, fps.value));
}
