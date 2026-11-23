/**
 * Values that must never go down when local history is restored (for example the highest number
 * already issued for an ID prefix). Undo and Redo still restore the earlier content as one history
 * step, but at each declared place the larger of the current and the restored value is kept, so an
 * ID that was issued once is never issued again for something else.
 *
 * A place is a JSON Pointer (RFC 6901) such as `/lastIssued` or `/groups/0/lastIssued` (array
 * steps are indexes). At that place a number keeps the
 * larger value; a plain object keeps, key by key, the larger number (keys from either side are
 * kept; nested objects are walked the same way). Any other shape, or a place missing on one side,
 * leaves the restored value as it is.
 */
export const KEEP_HIGHEST_LIMIT = 16;
const POINTER_MAX = 256;

/** Problems of a list of places, or an empty list. */
export function keepHighestProblems(paths: unknown): string[] {
  if (!Array.isArray(paths)) return ['keepHighest must be an array'];
  if (paths.length === 0) return ['keepHighest must name at least one place'];
  if (paths.length > KEEP_HIGHEST_LIMIT)
    return [`keepHighest has more than ${KEEP_HIGHEST_LIMIT} places`];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    if (typeof p !== 'string' || !p.startsWith('/') || p.length > POINTER_MAX) {
      out.push(`keepHighest place must be a JSON Pointer of at most ${POINTER_MAX} characters`);
      continue;
    }
    if (/~(?![01])/.test(p)) out.push(`keepHighest place ${p} has an invalid escape`);
    if (seen.has(p)) out.push(`keepHighest place ${p} is repeated`);
    seen.add(p);
  }
  return out;
}

const segments = (pointer: string) =>
  pointer
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
const plain = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function higher(restored: unknown, current: unknown): unknown {
  if (finite(restored) && finite(current)) return Math.max(restored, current);
  if (plain(restored) && plain(current)) {
    const out: Record<string, unknown> = { ...restored };
    for (const [k, v] of Object.entries(current)) {
      if (!Object.hasOwn(out, k)) {
        // A key only the current side has (a prefix first issued after the restored version):
        // keep it only when it holds numbers, so other data is never carried across history.
        if (finite(v) || (plain(v) && onlyNumbers(v))) own(out, k, structuredClone(v));
      } else own(out, k, higher(out[k], v));
    }
    return out;
  }
  return restored;
}
/** Sets an own data property, so a JSON key such as `__proto__` stays an ordinary key. */
function own(obj: Record<string, unknown>, k: string, v: unknown) {
  Object.defineProperty(obj, k, { value: v, writable: true, enumerable: true, configurable: true });
}
function onlyNumbers(v: Record<string, unknown>): boolean {
  return Object.values(v).every((x) => finite(x) || (plain(x) && onlyNumbers(x)));
}

/**
 * The restored content with the declared places raised to the current values. Returns `restored`
 * itself when nothing changes; otherwise a new object (the inputs are not mutated).
 */
export function keepHighest<T>(restored: T, current: T, paths: readonly string[]): T {
  let result: unknown = restored;
  for (const pointer of paths) {
    const keys = segments(pointer);
    let r: unknown = result;
    let c: unknown = current;
    for (const k of keys) {
      if (!has(r, k) || !has(c, k)) {
        r = undefined;
        break;
      }
      r = (r as Record<string, unknown>)[k];
      c = (c as Record<string, unknown>)[k];
    }
    if (r === undefined) continue;
    const next = higher(r, c);
    if (JSON.stringify(next) === JSON.stringify(r)) continue;
    result = setAt(result, keys, next);
  }
  return result as T;
}
/** Whether a step of the pointer exists: an own key of a plain object, or an index of an array. */
function has(v: unknown, k: string): boolean {
  if (Array.isArray(v)) return /^(0|[1-9]\d*)$/.test(k) && Number(k) < v.length;
  return plain(v) && Object.hasOwn(v, k);
}
function setAt(root: unknown, keys: string[], value: unknown): unknown {
  if (!keys.length) return value;
  const [k, ...rest] = keys;
  if (Array.isArray(root)) {
    const copy = [...root];
    copy[Number(k)] = setAt(root[Number(k)], rest, value);
    return copy;
  }
  const obj = root as Record<string, unknown>;
  const copy = { ...obj };
  own(copy, k, setAt(obj[k], rest, value));
  return copy;
}
