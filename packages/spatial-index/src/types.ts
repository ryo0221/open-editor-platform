/** Internal numeric projection; no domain IDs, content or SDK model crosses the ABI. */
export interface SpatialBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface SpatialIndex {
  readonly backend: 'typescript' | 'wasm';
  /** Inclusive AABB matches, in input order. Zero-area queries are point hits. */
  query(bounds: SpatialBounds): number[];
  dispose(): void;
}
export type WasmFactory = (snapshot: Float64Array) => SpatialIndex | undefined;
export const MAX_SPATIAL_ITEMS = 100_000;

export function endpoints(b: SpatialBounds): [number, number, number, number] {
  const values: [number, number, number, number] = [b.x, b.y, b.x + b.width, b.y + b.height];
  if (!values.every(Number.isFinite) || b.width < 0 || b.height < 0)
    throw new RangeError('Spatial bounds must have finite endpoints and nonnegative dimensions.');
  return values;
}
