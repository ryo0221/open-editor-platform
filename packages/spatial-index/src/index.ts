import { getWasmFactory } from './runtime';
import { endpoints, MAX_SPATIAL_ITEMS, type SpatialBounds, type SpatialIndex } from './types';
export type { SpatialBounds, SpatialIndex } from './types';

/** Existing scan semantics; also the fallback oracle for an optional Wasm index. */
export function createTypeScriptSpatialIndex(boxes: readonly SpatialBounds[]): SpatialIndex {
  return scan(pack(boxes));
}
function pack(boxes: readonly SpatialBounds[]) {
  if (boxes.length > MAX_SPATIAL_ITEMS)
    throw new RangeError('Spatial snapshot exceeds 100,000 items.');
  const data = new Float64Array(boxes.length * 4);
  boxes.forEach((box, i) => data.set(endpoints(box), i * 4));
  return data;
}
function scan(data: Float64Array): SpatialIndex {
  let disposed = false;
  return {
    backend: 'typescript',
    query(bounds) {
      if (disposed) throw new Error('Spatial index is disposed.');
      const [x, y, right, bottom] = endpoints(bounds),
        result: number[] = [];
      for (let i = 0; i < data.length; i += 4)
        if (data[i] <= right && data[i + 2] >= x && data[i + 1] <= bottom && data[i + 3] >= y)
          result.push(i / 4);
      return result;
    },
    dispose() {
      disposed = true;
      data = new Float64Array();
    },
  };
}
export function createSpatialIndex(boxes: readonly SpatialBounds[]): SpatialIndex {
  const data = pack(boxes),
    fallback = scan(data);
  let wasm: SpatialIndex | undefined;
  try {
    wasm = getWasmFactory()?.(data);
  } catch {
    /* Initialization cannot break selection. */
  }
  let disposed = false;
  return {
    get backend() {
      return wasm?.backend ?? 'typescript';
    },
    query(bounds) {
      if (disposed) throw new Error('Spatial index is disposed.');
      endpoints(bounds); // Invalid callers receive the same error on both backends.
      if (wasm) {
        try {
          return wasm.query(bounds);
        } catch {
          wasm.dispose();
          wasm = undefined;
        }
      }
      return fallback.query(bounds);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      wasm?.dispose();
      wasm = undefined;
      fallback.dispose();
    },
  };
}
