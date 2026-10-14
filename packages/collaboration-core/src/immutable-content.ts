import { isDeepFrozen, isImmutableJson } from '@editor-platform/artifact-core';

const immutableProperties = new WeakMap<
  object,
  { prototype: object | null; keys: (string | symbol)[]; descriptors: PropertyDescriptor[] }
>();
const stableTrees = new WeakSet<object>();
const immutableMatches = new WeakMap<object, WeakSet<object>>();

// deepFreeze traverses enumerable values. A cached equality also needs proof
// that symbol/non-enumerable children are immutable and no accessor is involved.
function stableData(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true;
  if (!isDeepFrozen(value)) return false;
  if (stableTrees.has(value)) return true;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null)
    return false;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor) || !stableData(descriptor.value)) return false;
  }
  stableTrees.add(value);
  return true;
}

/** Exact comparison of plain data without serializing a second full tree.
 * Only certified immutable objects have reusable own property descriptors.
 * An exact immutable pair is retained only after checking every nested property.
 * Mutable incoming values are compared again at each synchronous reuse boundary.
 * Non-data objects/accessors are deliberately not considered interchangeable.
 */
export function sameContent(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (immutableMatches.get(left)?.has(right)) return true;
  const result = compare(left, right);
  if (result === 2) {
    // Redelivery reuses the complete tree. Keep one weak pair per comparison,
    // rather than allocating a pair set for every cell/row in a large artifact.
    const matches = immutableMatches.get(left) ?? new WeakSet<object>();
    matches.add(right);
    immutableMatches.set(left, matches);
  }
  return result !== 0;
}
// 0: different, 1: equal with mutable/unverified branches, 2: equal immutable data.
function compare(left: unknown, right: unknown): 0 | 1 | 2 {
  if (Object.is(left, right)) return stableData(left) ? 2 : 1;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return 0;
  const owned = isDeepFrozen(left);
  const cached = owned ? immutableProperties.get(left) : undefined;
  const prototype = cached ? cached.prototype : Object.getPrototypeOf(left);
  if (prototype !== Object.getPrototypeOf(right)) return 0;
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null)
    return 0;
  const keys = cached?.keys ?? Reflect.ownKeys(left);
  const json = isImmutableJson(right),
    array = Array.isArray(right);
  // A privately parsed JSON tree has only own enumerable data properties, plus
  // Array.length. Compare every key/value without allocating a descriptor for
  // every received cell. Arbitrary Host values still take the descriptor path.
  const rightSize = json
    ? array
      ? right.length + 1
      : Object.keys(right).length
    : Reflect.ownKeys(right).length;
  if (keys.length !== rightSize) return 0;
  const descriptors: PropertyDescriptor[] | undefined = owned && !cached ? [] : undefined;
  let stable = owned && isDeepFrozen(right);
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    const a = cached?.descriptors[index] ?? Object.getOwnPropertyDescriptor(left, key)!;
    let value: unknown;
    if (json) {
      if (
        typeof key !== 'string' ||
        !Object.hasOwn(right, key) ||
        a.enumerable !== !(array && key === 'length') ||
        !('value' in a)
      )
        return 0;
      value = (right as Record<string, unknown>)[key];
    } else {
      const b = Object.getOwnPropertyDescriptor(right, key);
      if (!b || a.enumerable !== b.enumerable || !('value' in a) || !('value' in b)) return 0;
      value = b.value;
    }
    const child = compare(a.value, value);
    if (!child) return 0;
    if (child !== 2) stable = false;
    descriptors?.push(a);
  }
  // Cache only successful plain-data comparisons on certified immutable objects.
  // This never marks mutable or merely shallow-frozen branches as stable.
  if (descriptors) immutableProperties.set(left, { prototype, keys, descriptors });
  if (stable) {
    stableTrees.add(left);
    stableTrees.add(right);
  }
  return stable ? 2 : 1;
}
