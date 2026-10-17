import type { Budgets } from './model';

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
  function visit(v: unknown, depth: number, key = '', coordinateRank = 0) {
    if (depth > limits.depth) return fail();
    if (v === null) {
      emit('null');
      return;
    }
    if (typeof v === 'string') {
      string(v);
      return;
    }
    if (typeof v === 'boolean') {
      emit(String(v));
      return;
    }
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return fail();
      emit(Object.is(v, -0) ? '0' : String(v));
      return;
    }
    if (typeof v !== 'object' || seen.has(v)) return fail();
    const array = Array.isArray(v);
    if (Object.getPrototypeOf(v) !== (array ? Array.prototype : Object.prototype)) return fail();
    seen.add(v);
    if (array) {
      // Length budgets precede enumeration, element descriptors, and cloning.
      const length = Object.getOwnPropertyDescriptor(v, 'length')!.value as number;
      if (key === 'actions' && length > limits.actions) throw new Error('action-limit');
      if (key === 'layers') {
        layers += length;
        if (layers > limits.layers) throw new Error('layer-limit');
      }
      if (key === 'features' || key === 'candidates') {
        features += length;
        if (features > limits.features) throw new Error('feature-limit');
      }
      if (coordinateRank === 1) {
        vertices++;
        if (vertices > limits.vertices) throw new Error('vertex-limit');
      }
      if (coordinateRank === 2 && length > limits.vertices - vertices)
        throw new Error('vertex-limit');
      if (length > Math.floor((limits.bytes - bytes - 1) / 2)) throw new Error('byte-limit');
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
    } else {
      // Command payloads can contain many singular addFeature/importLayer actions.
      // Native/import candidate envelopes count their arrays instead.
      if (commandPayload && key === 'feature' && ++features > limits.features)
        throw new Error('feature-limit');
      if (commandPayload && key === 'layer' && ++layers > limits.layers)
        throw new Error('layer-limit');
      emit('{');
      let first = true;
      for (const k of Reflect.ownKeys(v)) {
        if (
          typeof k !== 'string' ||
          ['__proto__', 'constructor', 'prototype', 'toJSON'].includes(k)
        )
          return fail();
        const child = data(v, k);
        if (!first) emit(',');
        first = false;
        string(k);
        emit(':');
        let rank = 0;
        if (k === 'coordinates') {
          const type = Object.getOwnPropertyDescriptor(v, 'type');
          if (type && 'value' in type && typeof type.value === 'string')
            rank =
              (
                {
                  Point: 1,
                  LineString: 2,
                  MultiPoint: 2,
                  Polygon: 3,
                  MultiLineString: 3,
                  MultiPolygon: 4,
                } as Record<string, number>
              )[type.value] ?? 0;
        }
        visit(child, depth + 1, k, rank);
      }
      emit('}');
    }
    seen.delete(v);
  }
  visit(value, 0);
  return chunks.join('');
}
