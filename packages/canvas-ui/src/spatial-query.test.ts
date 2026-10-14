import { afterEach, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { intersectsRotated, type GeometryItem } from '@editor-platform/editor-core';
import {
  initializeSpatialWasm,
  getWasmFactory,
  useTypeScriptSpatialBackend,
} from '@editor-platform/spatial-index/experimental';
import { CanvasSpatialQuery } from './spatial-query';
const asset = new URL('../../../work/spatial-wasm/spatial.wasm', import.meta.url);
if (process.env.SPATIAL_WASM_REQUIRED && !existsSync(asset))
  throw new Error('Build the real Rust Wasm before Canvas fallback verification.');
afterEach(useTypeScriptSpatialBackend);
for (const backend of ['typescript', 'wasm'] as const)
  it.skipIf(backend === 'wasm' && !existsSync(asset))(
    `${backend} preserves rotated marquee/point hits, visibility, order and geometry replacement`,
    async () => {
      if (backend === 'wasm')
        expect(await initializeSpatialWasm(async () => new Uint8Array(readFileSync(asset)))).toBe(
          true,
        );
      const items: GeometryItem[] = Array.from({ length: 64 }, (_, n) => ({
        id: `shape-${n}`,
        bounds: { x: n * 11 - 100, y: n * 7 - 200, width: 80, height: 23 },
        rotation: n * 13 - 420,
        locked: n % 11 === 0,
        hidden: n % 7 === 0,
      }));
      items.push({ id: 'flat', bounds: { x: -20, y: -10, width: 30, height: 40 } });
      const query = new CanvasSpatialQuery();
      for (let n = 0; n < 80; n++) {
        const b = { x: n * 7 - 100, y: n * 4 - 200, width: n % 2 ? 0 : 50, height: n % 2 ? 0 : 50 };
        expect(query.query(items, b)).toEqual(
          items.filter((i) => !i.hidden && !i.locked && intersectsRotated(b, i.bounds, i.rotation)),
        );
      }
      expect(query.backend).toBe(backend);
      const changed = items.map((i) => ({ ...i, bounds: { ...i.bounds, x: 5000 } }));
      expect(query.query(changed, { x: 0, y: 0, width: 1, height: 1 })).toEqual([]);
      query.dispose();
      query.dispose();
    },
  );
it('retains the legacy path for unsupported large/invalid projections', () => {
  const q = new CanvasSpatialQuery();
  const item = { id: 'wide', bounds: { x: 0, y: 0, width: Number.MAX_VALUE, height: 20 } };
  const items = Array(100_001).fill(item);
  expect(q.query(items, { x: 1, y: 1, width: 0, height: 0 })).toHaveLength(items.length);
  expect(q.backend).toBe('typescript');
  q.dispose();
});

for (const unsupported of ['oversize', 'overflowed-hull', 'nonfinite-rotation'] as const)
  it.skipIf(!existsSync(asset))(
    `enabled Wasm preserves legacy IDs/order for ${unsupported}`,
    async () => {
      expect(await initializeSpatialWasm(async () => new Uint8Array(readFileSync(asset)))).toBe(
        true,
      );
      const factory = getWasmFactory();
      expect(factory).toBeDefined();
      const q = new CanvasSpatialQuery();
      const bounds = { x: 0, y: 0, width: 3, height: 3 };
      const warm = [{ id: 'warm', bounds }];
      try {
        expect(q.query(warm, bounds).map((i) => i.id)).toEqual(['warm']);
        expect(q.backend).toBe('wasm'); // Actual compiled ABI, not the normal disabled path.
        const items: GeometryItem[] =
          unsupported === 'oversize'
            ? Array.from({ length: 100_003 }, (_, n) => ({
                id: `item-${100_003 - n}`,
                bounds: { x: (n % 7) - 2, y: 0, width: 1, height: 1 },
                hidden: n === 0,
                locked: n === 1,
              }))
            : [
                { id: 'last-id-first', bounds },
                {
                  id: 'unsupported',
                  bounds: {
                    x: 0,
                    y: 0,
                    width: unsupported === 'overflowed-hull' ? Number.MAX_VALUE : 2,
                    height: 2,
                  },
                  rotation: unsupported === 'nonfinite-rotation' ? NaN : 0,
                },
                { id: 'hidden', bounds, hidden: true },
                { id: 'locked', bounds, locked: true },
                { id: 'first-id-last', bounds },
              ];
        if (unsupported === 'oversize')
          expect(items.filter((i) => !i.hidden && !i.locked)).toHaveLength(100_001);
        const legacy = items
          .filter((i) => !i.hidden && !i.locked && intersectsRotated(bounds, i.bounds, i.rotation))
          .map((i) => i.id);
        expect(legacy.length).toBeGreaterThan(0);
        expect(q.query(items, bounds).map((i) => i.id)).toEqual(legacy);
        expect(q.backend).toBe('typescript');
        expect(getWasmFactory()).toBe(factory); // Still enabled; unsupported projection alone fell back.
        expect(q.query(warm, bounds).map((i) => i.id)).toEqual(['warm']);
        expect(q.backend).toBe('wasm'); // Unsupported snapshot did not retire a healthy backend.
      } finally {
        q.dispose();
      }
    },
  );
