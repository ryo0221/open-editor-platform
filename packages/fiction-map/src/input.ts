import { fictionMapLimits as limits } from './limits';
import { fail, pointer } from './result';
import type { FictionMapCode } from './types';

export interface DataBudget {
  depth: number;
  values: number;
  bytes: number;
  byteCode: FictionMapCode;
  request?: boolean;
}
/** Counts canonical JSON UTF-8 incrementally; never allocates an oversized encoding. */
export function jsonStringBytes(value: string): number {
  let bytes = 2;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 34 || c === 92 || [8, 9, 10, 12, 13].includes(c)) bytes += 2;
    else if (c < 32) bytes += 6;
    else if (c < 128) bytes++;
    else if (c < 2048) bytes += 2;
    else if (
      c >= 0xd800 &&
      c <= 0xdbff &&
      value.charCodeAt(i + 1) >= 0xdc00 &&
      value.charCodeAt(i + 1) <= 0xdfff
    ) {
      bytes += 4;
      i++;
    } else if (c >= 0xd800 && c <= 0xdfff) bytes += 6;
    else bytes += 3;
  }
  return bytes;
}
function arrayGuard(path: string, length: number, request: boolean) {
  let max: number | undefined,
    code: FictionMapCode = 'input-structure-limit';
  if (/\/outer$/.test(path)) {
    max = 65;
    code = 'geometry-vertex-limit';
  } else if (/\/coordinates$/.test(path)) {
    max = 64;
    code = 'geometry-vertex-limit';
  } else if (path === '/features') {
    max = 200;
    code = 'feature-limit';
  } else if (path === '/layers') {
    max = 10;
    code = 'layer-limit';
  } else if (path === '/namedViews') {
    max = 10;
    code = 'view-limit';
  } else if (request && /^\/(create|update|delete)$/.test(path)) {
    max = 400;
    code = 'operation-feature-limit';
  }
  if (max !== undefined && length > max) fail(code, path, { limit: max, actual: length });
}
export const nativeBudget: DataBudget = {
  depth: limits.depth,
  values: limits.values,
  bytes: limits.nativeBytes,
  byteCode: 'native-byte-limit',
};
export const requestBudget: DataBudget = {
  depth: limits.requestDepth,
  values: limits.requestValues,
  bytes: limits.requestBytes,
  byteCode: 'operation-byte-limit',
  request: true,
};
export function copyData(input: unknown, budget: DataBudget = nativeBudget): unknown {
  const ancestors = new Set<object>();
  let count = 0,
    bytes = 0;
  const add = (n: number, path: string) => {
    bytes += n;
    if (bytes > budget.bytes) fail(budget.byteCode, path, { limit: budget.bytes, actual: bytes });
  };
  const visit = (v: unknown, path: string, depth: number): unknown => {
    if (++count > budget.values)
      fail('input-structure-limit', path, { limit: budget.values, actual: count });
    if (v === null) {
      add(4, path);
      return null;
    }
    if (typeof v === 'string') {
      if (v.length + 2 > budget.bytes - bytes)
        fail(budget.byteCode, path, { limit: budget.bytes, actual: bytes + v.length + 2 });
      add(jsonStringBytes(v), path);
      return v;
    }
    if (typeof v === 'number') {
      add(Number.isFinite(v) ? String(JSON.stringify(v)).length : 4, path);
      return v;
    }
    if (typeof v === 'boolean') {
      add(v ? 4 : 5, path);
      return v;
    }
    if (typeof v !== 'object') fail('invalid-data', path);
    if (depth > budget.depth)
      fail('input-structure-limit', path, { limit: budget.depth, actual: depth });
    if (ancestors.has(v)) fail('invalid-data', path);
    const array = Array.isArray(v);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(v)))
      fail('invalid-data', path);
    const keys = Reflect.ownKeys(v);
    if (keys.length > budget.values + 1) fail('input-structure-limit', path);
    if (array) arrayGuard(path, v.length, !!budget.request);
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') fail('invalid-data', path);
      const d = Object.getOwnPropertyDescriptor(v, key)!;
      if (!d.enumerable || !('value' in d)) fail('invalid-data', pointer(path, key));
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= v.length))
        fail('invalid-data', pointer(path, key));
    }
    ancestors.add(v);
    add(2, path);
    let out: unknown;
    if (array) {
      const a: unknown[] = [];
      for (let i = 0; i < v.length; i++) {
        const d = Object.getOwnPropertyDescriptor(v, String(i));
        if (!d) fail('invalid-data', pointer(path, i));
        if (i) add(1, path);
        a.push(visit(d.value, pointer(path, i), depth + 1));
      }
      out = a;
    } else {
      const o: Record<string, unknown> = {};
      let i = 0;
      for (const key of keys as string[]) {
        if (key.length + 2 > budget.bytes - bytes)
          fail(budget.byteCode, pointer(path, key), {
            limit: budget.bytes,
            actual: bytes + key.length + 2,
          });
        add(jsonStringBytes(key) + 1 + (i++ ? 1 : 0), pointer(path, key));
        Object.defineProperty(o, key, {
          value: visit(
            Object.getOwnPropertyDescriptor(v, key)!.value,
            pointer(path, key),
            depth + 1,
          ),
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      out = o;
    }
    ancestors.delete(v);
    return out;
  };
  return visit(input, '', 1);
}
