import type { Budgets } from './model';

const reservedKeys = ['__proto__', 'constructor', 'prototype', 'toJSON'];
const coordinateRanks: Record<string, number> = {
  Point: 1,
  LineString: 2,
  MultiPoint: 2,
  Polygon: 3,
  MultiLineString: 3,
  MultiPolygon: 4,
};
/** In-process data boundary, not a sandbox for Proxy traps or modified JS intrinsics. */
export function checkedJson(value: unknown, limits: Budgets, commandPayload = false): string {
  if (
    !['bytes', 'depth', 'layers', 'features', 'vertices', 'actions'].every((k) => {
      const n = limits[k as keyof Budgets];
      return Number.isSafeInteger(n) && n > 0;
    })
  )
    throw new Error('invalid-budget');
  let bytes = 0,
    layers = 0,
    features = 0,
    vertices = 0;
  const chunks: string[] = [];
  const seen = new Set<object>();
  const fail = () => {
    throw new Error('unsafe-json-or-depth');
  };
  function emit(text: string, size = text.length) {
    bytes += size;
    if (bytes > limits.bytes) throw new Error('byte-limit');
    chunks.push(text);
  }
  function string(text: string) {
    // Every UTF-16 code unit requires at least one serialized UTF-8 byte.
    if (text.length > limits.bytes - bytes - 2) throw new Error('byte-limit');
    emit('"');
    for (let i = 0; i < text.length; i++) {
      const n = text.charCodeAt(i);
      if (n === 34 || n === 92 || n < 32) emit(JSON.stringify(text[i]).slice(1, -1));
      else if (
        n >= 0xd800 &&
        n <= 0xdbff &&
        i + 1 < text.length &&
        text.charCodeAt(i + 1) >= 0xdc00 &&
        text.charCodeAt(i + 1) <= 0xdfff
      )
        emit(text[i] + text[++i], 4);
      else if (n >= 0xd800 && n <= 0xdfff) emit(`\\u${n.toString(16).padStart(4, '0')}`);
      else emit(text[i], n < 128 ? 1 : n < 2048 ? 2 : 3);
    }
    emit('"');
  }
  function data(object: object, key: PropertyKey): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return fail();
    return descriptor.value;
  }
  function scalar(v: unknown): boolean {
    if (v === null || typeof v === 'boolean') emit(String(v));
    else if (typeof v === 'string') string(v);
    else if (typeof v === 'number') {
      if (!Number.isFinite(v)) return fail();
      emit(Object.is(v, -0) ? '0' : String(v));
    } else return false;
    return true;
  }
  /** Length budgets precede enumeration, element descriptors, and cloning. */
  function chargeArray(length: number, key: string, coordinateRank: number) {
    if (key === 'actions' && length > limits.actions) throw new Error('action-limit');
    if (key === 'layers' && (layers += length) > limits.layers) throw new Error('layer-limit');
    if ((key === 'features' || key === 'candidates') && (features += length) > limits.features)
      throw new Error('feature-limit');
    if (coordinateRank === 1 && ++vertices > limits.vertices) throw new Error('vertex-limit');
    if (coordinateRank === 2 && length > limits.vertices - vertices)
      throw new Error('vertex-limit');
    if (length > Math.floor((limits.bytes - bytes - 1) / 2)) throw new Error('byte-limit');
  }
  function array(v: unknown[], depth: number, key: string, coordinateRank: number) {
    const length = Object.getOwnPropertyDescriptor(v, 'length')!.value as number;
    chargeArray(length, key, coordinateRank);
    const keys = Reflect.ownKeys(v);
    if (
      keys.length !== length + 1 ||
      keys.some(
        (k) =>
          k !== 'length' &&
          (typeof k !== 'string' || !/^(0|[1-9][0-9]*)$/.test(k) || Number(k) >= length),
      )
    )
      return fail();
    emit('[');
    for (let i = 0; i < length; i++) {
      if (i) emit(',');
      visit(data(v, String(i)), depth + 1, '', Math.max(0, coordinateRank - 1));
    }
    emit(']');
  }
  /** Nesting rank of a GeoJSON-shaped `coordinates` member, from its sibling `type`. */
  function coordinatesRank(object: object): number {
    const type = Object.getOwnPropertyDescriptor(object, 'type');
    if (!type || !('value' in type) || typeof type.value !== 'string') return 0;
    return Object.hasOwn(coordinateRanks, type.value) ? coordinateRanks[type.value] : 0;
  }
  function object(v: object, depth: number, key: string) {
    // Command payloads can contain many singular addFeature/importLayer actions.
    // Native/import candidate envelopes count their arrays instead.
    if (commandPayload && key === 'feature' && ++features > limits.features)
      throw new Error('feature-limit');
    if (commandPayload && key === 'layer' && ++layers > limits.layers)
      throw new Error('layer-limit');
    emit('{');
    let first = true;
    for (const k of Reflect.ownKeys(v)) {
      if (typeof k !== 'string' || reservedKeys.includes(k)) return fail();
      const child = data(v, k);
      if (!first) emit(',');
      first = false;
      string(k);
      emit(':');
      visit(child, depth + 1, k, k === 'coordinates' ? coordinatesRank(v) : 0);
    }
    emit('}');
  }
  function visit(v: unknown, depth: number, key = '', coordinateRank = 0) {
    if (depth > limits.depth) return fail();
    if (scalar(v)) return;
    if (typeof v !== 'object' || v === null || seen.has(v)) return fail();
    const isArray = Array.isArray(v);
    if (Object.getPrototypeOf(v) !== (isArray ? Array.prototype : Object.prototype)) return fail();
    seen.add(v);
    if (isArray) array(v, depth, key, coordinateRank);
    else object(v, depth, key);
    seen.delete(v);
  }
  visit(value, 0);
  return chunks.join('');
}
