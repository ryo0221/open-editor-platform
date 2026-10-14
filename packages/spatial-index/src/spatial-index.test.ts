import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createSpatialIndex, createTypeScriptSpatialIndex } from './index';
import { initializeSpatialWasm, useTypeScriptSpatialBackend } from './runtime';
import { factoryFromExports } from './wasm';
import type { SpatialBounds } from './types';

const asset = new URL('../../../work/spatial-wasm/spatial.wasm', import.meta.url);
const available = existsSync(asset);
if (process.env.SPATIAL_WASM_REQUIRED && !available)
  throw new Error('Build the real Rust Wasm before spatial verification.');
const wasmIt = available ? it : it.skip;
const bytes = () => Promise.resolve(new Uint8Array(readFileSync(asset)));
afterEach(() => {
  useTypeScriptSpatialBackend();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

wasmIt('frees temporary input on a failed build and rejects corrupt query results', async () => {
  const { instance } = await WebAssembly.instantiate(await bytes());
  const free = vi.fn((ptr: number, count: number) =>
    (instance.exports.spatial_free as (ptr: number, count: number) => void)(ptr, count),
  );
  const data = new Float64Array([0, 0, 10, 10]);
  const refusing = factoryFromExports({
    ...instance.exports,
    spatial_build: () => 0,
    spatial_free: free,
  });
  expect(() => refusing(data)).toThrow('construction failed');
  expect(free).toHaveBeenCalledTimes(1);
  expect(refusing(data)).toBeUndefined();
  for (const count of [-1, 2]) {
    const corrupt = factoryFromExports({ ...instance.exports, spatial_query: () => count });
    const index = corrupt(data)!;
    expect(() => index.query({ x: 0, y: 0, width: 0, height: 0 })).toThrow('result count');
    index.dispose();
    expect(corrupt(data)).toBeUndefined();
  }
  const allocator = factoryFromExports({ ...instance.exports, spatial_alloc: () => 0 });
  expect(() => allocator(data)).toThrow('allocation failed');
});

it('keeps inclusive scan ordering, point hits, snapshots and deterministic disposal', () => {
  const boxes = [
    { x: -10, y: -20, width: 10, height: 20 },
    { x: 0, y: 0, width: 0, height: 0 },
  ];
  const index = createSpatialIndex(boxes);
  boxes[0].x = 1000;
  expect(index.backend).toBe('typescript');
  expect(index.query({ x: 0, y: 0, width: 0, height: 0 })).toEqual([0, 1]);
  expect(index.query({ x: 1, y: 1, width: 0, height: 0 })).toEqual([]);
  index.dispose();
  index.dispose();
  expect(() => index.query(boxes[1])).toThrow('disposed');
  const empty = createSpatialIndex([]);
  expect(empty.query(boxes[1])).toEqual([]);
  empty.dispose();
});
it('rejects invalid numeric projections before passing them across the ABI', () => {
  for (const b of [
    { x: NaN, y: 0, width: 1, height: 1 },
    { x: 0, y: Infinity, width: 1, height: 1 },
    { x: 0, y: 0, width: -1, height: 1 },
    { x: Number.MAX_VALUE, y: 0, width: Number.MAX_VALUE, height: 1 },
  ])
    expect(() => createSpatialIndex([b])).toThrow(RangeError);
  expect(() =>
    createSpatialIndex(Array(100_001).fill({ x: 0, y: 0, width: 1, height: 1 })),
  ).toThrow('100,000');
});
it('falls back for rejected loading, malformed bytes and an unavailable WebAssembly runtime', async () => {
  expect(
    await initializeSpatialWasm(async () => {
      throw new Error('offline');
    }),
  ).toBe(false);
  expect(await initializeSpatialWasm(async () => new Uint8Array([0, 1]))).toBe(false);
  vi.stubGlobal('WebAssembly', undefined);
  const loader = vi.fn(bytes);
  expect(await initializeSpatialWasm(loader)).toBe(false);
  expect(loader).not.toHaveBeenCalled();
  const i = createSpatialIndex([{ x: 0, y: 0, width: 10, height: 10 }]);
  expect(i.query({ x: 10, y: 10, width: 0, height: 0 })).toEqual([0]);
  i.dispose();
});

wasmIt(
  'real Rust BVH matches TS for deterministic mixed-size data, edge hits and empty data',
  async () => {
    expect(await initializeSpatialWasm(bytes)).toBe(true);
    let seed = 247;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const boxes: SpatialBounds[] = Array.from({ length: 2048 }, () => ({
      x: random() * 20000 - 10000,
      y: random() * 20000 - 10000,
      width: random() * 700,
      height: random() * 500,
    }));
    boxes.push(
      { x: 0, y: 0, width: 0, height: 0 },
      { x: -1e12, y: -1e12, width: 2e12, height: 2e12 },
    );
    const wasm = createSpatialIndex(boxes),
      ts = createTypeScriptSpatialIndex(boxes);
    expect(wasm.backend).toBe('wasm');
    for (let n = 0; n < 120; n++) {
      const query =
        n < 10
          ? { x: boxes[n].x + boxes[n].width, y: boxes[n].y, width: 0, height: 0 }
          : {
              x: random() * 20000 - 10000,
              y: random() * 20000 - 10000,
              width: random() * 1500,
              height: random() * 1500,
            };
      expect(wasm.query(query)).toEqual(ts.query(query));
    }
    expect(() => wasm.query({ x: 0, y: 0, width: -1, height: 0 })).toThrow(RangeError);
    expect(wasm.backend).toBe('wasm');
    wasm.dispose();
    ts.dispose();
    const empty = createSpatialIndex([]);
    expect(empty.backend).toBe('wasm');
    expect(empty.query({ x: 0, y: 0, width: 0, height: 0 })).toEqual([]);
    empty.dispose();
  },
);
wasmIt(
  'owns results through subsequent allocations, memory growth, multiple handles and disposal',
  async () => {
    expect(await initializeSpatialWasm(bytes)).toBe(true);
    const first = createSpatialIndex([{ x: 0, y: 0, width: 10, height: 10 }]);
    const point = { x: 5, y: 5, width: 0, height: 0 };
    const retained = first.query(point);
    const big = createSpatialIndex(
      Array.from({ length: 100_000 }, (_, i) => ({ x: i, y: i, width: 1, height: 1 })),
    );
    expect(big.backend).toBe('wasm');
    expect(big.query(point)).toEqual([4, 5]);
    expect(first.query(point)).toEqual([0]);
    big.dispose();
    first.dispose();
    expect(retained).toEqual([0]);
    expect(() => first.query(point)).toThrow('disposed');
    for (let n = 0; n < 30; n++) {
      const index = createSpatialIndex([point]);
      expect(index.query(point)).toEqual([0]);
      index.dispose();
    }
  },
);
wasmIt(
  'retires a trapped backend and preserves the current query through the TS fallback',
  async () => {
    const { instance } = await WebAssembly.instantiate(await bytes());
    const drop = vi.fn((handle: number) =>
      (instance.exports.spatial_drop as (handle: number) => void)(handle),
    );
    const factory = factoryFromExports({
      ...instance.exports,
      spatial_drop: drop,
      spatial_query: () => {
        throw new WebAssembly.RuntimeError('injected trap');
      },
    });
    // Inject into the existing initialization seam, so the normal wrapper owns fallback.
    const instantiate = vi.spyOn(WebAssembly, 'instantiate').mockResolvedValue({
      exports: {
        ...instance.exports,
        spatial_drop: drop,
        spatial_query: () => {
          throw new WebAssembly.RuntimeError('injected trap');
        },
      },
    } as WebAssembly.Instance);
    expect(await initializeSpatialWasm(bytes)).toBe(true);
    instantiate.mockRestore();
    const index = createSpatialIndex([{ x: 0, y: 0, width: 10, height: 10 }]);
    expect(index.backend).toBe('wasm');
    expect(index.query({ x: 10, y: 10, width: 0, height: 0 })).toEqual([0]);
    expect(index.backend).toBe('typescript');
    index.dispose();
    expect(drop).toHaveBeenCalledTimes(1);
    const next = createSpatialIndex([]);
    expect(next.backend).toBe('typescript');
    next.dispose();
    const raw = factory(new Float64Array([0, 0, 1, 1]))!;
    expect(() => raw.query({ x: 0, y: 0, width: 0, height: 0 })).toThrow('injected trap');
    raw.dispose();
    expect(factory(new Float64Array())).toBeUndefined();
  },
);
wasmIt(
  'rejects unknown ABI and prevents a stale initialization from replacing a newer choice',
  async () => {
    const { instance } = await WebAssembly.instantiate(await bytes());
    expect(() => factoryFromExports({ ...instance.exports, spatial_version: () => 99 })).toThrow(
      'ABI',
    );
    let resolve!: (v: Uint8Array) => void;
    const pending = initializeSpatialWasm(
      () =>
        new Promise<Uint8Array>((r) => {
          resolve = r;
        }),
    );
    useTypeScriptSpatialBackend();
    resolve(await bytes());
    expect(await pending).toBe(false);
    const index = createSpatialIndex([]);
    expect(index.backend).toBe('typescript');
    index.dispose();
  },
);
