import { clone, deepFreeze } from '@editor-platform/artifact-core';
import { assertReuseJson, record, reuseLimits } from '@editor-platform/reuse-core';

export class DesignCommandError extends Error {
  readonly name = 'DesignCommandError';
  constructor(
    readonly code: string,
    message: string,
    readonly path?: string,
  ) {
    super(message);
  }
}
export function rejectDesign(code: string, message: string, path?: string): never {
  throw new DesignCommandError(code, message, path);
}
/** Own fields of a plain object/array; symbols, holes and named array fields are rejected. */
function plainFields(v: object): [string, PropertyDescriptor][] {
  const descriptors = Object.getOwnPropertyDescriptors(v);
  if (Object.getOwnPropertySymbols(v).length)
    rejectDesign('design-json', 'Symbol fields are not portable Design data');
  const entries = Object.entries(descriptors).filter(
    ([key]) => !(Array.isArray(v) && key === 'length'),
  );
  if (
    Array.isArray(v) &&
    (entries.length !== v.length || entries.some(([key], i) => key !== String(i)))
  )
    rejectDesign('design-json', 'Sparse or named Design array fields are not supported');
  return entries;
}
/** A data field's value, read without running accessors; reserved keys are rejected. */
function fieldValue(key: string, descriptor: PropertyDescriptor): unknown {
  if (
    !descriptor.enumerable ||
    !('value' in descriptor) ||
    ['__proto__', 'prototype', 'constructor', 'toJSON'].includes(key)
  )
    rejectDesign('design-json', 'Executable or reserved Design data field', key);
  return descriptor.value;
}
/** Inspect descriptors before cloning/hashing: untrusted data must not run accessors. */
export function captureDesignData<T>(value: T, jsonOnly = false): T {
  let count = 0;
  const active = new Set<object>();
  const walk = (v: unknown, depth: number): void => {
    if (++count > reuseLimits.values || depth > reuseLimits.jsonDepth)
      rejectDesign('design-limit', 'Design data exceeds the value/depth budget');
    if (v === undefined && !jsonOnly) return;
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number' && Number.isFinite(v)) return;
    if (!v || typeof v !== 'object' || (!Array.isArray(v) && !record(v)))
      rejectDesign('design-json', 'Expected finite, plain Design JSON data');
    if (active.has(v)) rejectDesign('design-json', 'Cyclic Design data');
    active.add(v);
    for (const [key, descriptor] of plainFields(v)) walk(fieldValue(key, descriptor), depth + 1);
    active.delete(v);
  };
  walk(value, 0);
  if (value === undefined) return value;
  assertReuseJson(value);
  return deepFreeze(clone(value));
}
export function designId(value: unknown, path = 'id'): asserts value is string {
  // Native Design IDs are opaque strings, including Unicode and scoped IDs.
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 4096 ||
    ['__proto__', 'constructor', 'prototype'].includes(value)
  )
    rejectDesign('design-id', 'Expected a nonempty bounded Design ID', path);
}
