/** R1-a internals only. Not exported by any package entrypoint. */
export type Point = readonly [number, number];
export type PointCheck =
  | { readonly ok: true; readonly value: Point }
  | { readonly ok: false; readonly code: 'invalid-input' | 'coordinate-not-finite' };

/** Copy own numeric data slots; never coerce values or invoke coordinate getters. */
export function readFinitePoint(value: unknown): PointCheck {
  if (!Array.isArray(value) || value.length !== 2) return { ok: false, code: 'invalid-input' };
  const x = Object.getOwnPropertyDescriptor(value, '0');
  const y = Object.getOwnPropertyDescriptor(value, '1');
  if (!x || !y || !('value' in x) || !('value' in y)) return { ok: false, code: 'invalid-input' };
  if (typeof x.value !== 'number' || typeof y.value !== 'number')
    return { ok: false, code: 'invalid-input' };
  if (!Number.isFinite(x.value) || !Number.isFinite(y.value))
    return { ok: false, code: 'coordinate-not-finite' };
  return { ok: true, value: [x.value, y.value] };
}
