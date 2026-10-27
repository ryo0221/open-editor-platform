import { CalculationError } from './decimal';
/** Reject getters, prototypes, cycles, sparse arrays and non-JSON without evaluating accessors. */
export function assertJson(value: unknown, maxBytes = 2 * 1024 * 1024): void {
  const seen = new Set<object>();
  let nodes = 0;
  function walk(v: unknown, depth: number): void {
    if (++nodes > 500000 || depth > 64) throw new CalculationError('json-limit');
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return;
    if (typeof v === 'number' && Number.isFinite(v)) return;
    if (!v || typeof v !== 'object' || seen.has(v)) throw new CalculationError('non-json');
    if (
      Object.getPrototypeOf(v) !== (Array.isArray(v) ? Array.prototype : Object.prototype) &&
      Object.getPrototypeOf(v) !== null
    )
      throw new CalculationError('non-json');
    seen.add(v);
    if (Object.getOwnPropertySymbols(v).length) throw new CalculationError('non-json');
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
      if (Array.isArray(v) && key === 'length') continue;
      if (!descriptor.enumerable || !('value' in descriptor))
        throw new CalculationError('non-json');
    }
    const keys = Object.keys(v);
    if (Array.isArray(v) && (keys.length !== v.length || keys.some((k, i) => k !== String(i))))
      throw new CalculationError('non-json');
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
      if (!('value' in descriptor)) throw new CalculationError('non-json');
      walk(descriptor.value, depth + 1);
    }
    seen.delete(v);
  }
  walk(value, 0);
  if (new TextEncoder().encode(JSON.stringify(value)).length > maxBytes)
    throw new CalculationError('content-limit');
}
export function record(
  v: unknown,
  required: string[],
  optional: string[] = [],
): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new CalculationError('invalid-object');
  const r = v as Record<string, unknown>;
  if (
    required.some((k) => !Object.hasOwn(r, k)) ||
    Object.keys(r).some((k) => ![...required, ...optional].includes(k))
  )
    throw new CalculationError('unknown-or-missing-property');
  return r;
}
export function identifier(v: unknown): asserts v is string {
  if (typeof v !== 'string' || !v.length || v.length > 512)
    throw new CalculationError('invalid-id');
}
export function textValue(v: unknown): asserts v is string {
  if (typeof v !== 'string' || new TextEncoder().encode(v).length > 16384)
    throw new CalculationError('invalid-text');
}
