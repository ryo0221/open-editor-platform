import { expect, it } from 'vitest';
import { createDesign, isDesignWithPaths, makeDesignElement } from './model';
import { designPathLimits, validDesignPath, type DesignEditablePath } from './path';
import { presetDesignPath } from './path-commands';
function line(count: number, padding = 0): DesignEditablePath {
  const path = presetDesignPath('line'),
    s = path.subpaths[0];
  s.anchors = Array.from({ length: count }, (_, i) => ({
    id: `a${i}${'x'.repeat(padding)}`,
    x: i,
    y: 0,
    mode: 'corner',
  }));
  s.segments = s.anchors.slice(1).map((a, i) => ({
    id: `e${i}${'y'.repeat(padding)}`,
    type: 'line',
    from: s.anchors[i].id,
    to: a.id,
  }));
  return path;
}
it('enforces coordinate, subpath, per-shape and whole-document limits independently', () => {
  const valid = line(4096);
  expect(validDesignPath(valid)).toBe(true);
  expect(validDesignPath(line(4097))).toBe(false);
  const coordinate = presetDesignPath('line');
  coordinate.subpaths[0].anchors[0].x = 1_000_000;
  expect(validDesignPath(coordinate)).toBe(true);
  coordinate.subpaths[0].anchors[0].x++;
  expect(validDesignPath(coordinate)).toBe(false);
  const subpaths = presetDesignPath('line');
  subpaths.subpaths = Array.from({ length: 128 }, () => presetDesignPath('line').subpaths[0]);
  expect(validDesignPath(subpaths)).toBe(true);
  subpaths.subpaths.push(presetDesignPath('line').subpaths[0]);
  expect(validDesignPath(subpaths)).toBe(false);
  // 全体の点の上限は 4096 点の path で 48 個（漫画 24 ページ分）
  const elements = Array.from({ length: designPathLimits.totalAnchors / 4096 }, () => ({
    ...makeDesignElement('shape'),
    path: valid,
  }));
  const d = { ...createDesign(), schemaVersion: 3 as const, elements };
  expect(isDesignWithPaths(d)).toBe(true);
  expect(
    isDesignWithPaths({
      ...d,
      elements: [...elements, { ...makeDesignElement('shape'), path: valid }],
    }),
  ).toBe(false);
  const bytes = line(1024, 600);
  expect(validDesignPath(bytes)).toBe(true);
  const size = new TextEncoder().encode(JSON.stringify(bytes)).length;
  const fit = Math.floor(designPathLimits.totalBytes / size);
  expect(fit * 1024).toBeLessThanOrEqual(designPathLimits.totalAnchors);
  const ofBytes = (n: number) => ({
    ...createDesign(),
    schemaVersion: 3 as const,
    elements: Array.from({ length: n }, () => ({ ...makeDesignElement('shape'), path: bytes })),
  });
  expect(isDesignWithPaths(ofBytes(fit))).toBe(true);
  expect(isDesignWithPaths(ofBytes(fit + 1))).toBe(false);
  // 1 要素の path JSON は 8 MiB まで
  expect(validDesignPath(line(4096, 1100))).toBe(false);
}, 60_000);
it('refuses accessors and sparse native arrays without invoking imported code', () => {
  const path = presetDesignPath('line');
  let invoked = 0;
  Object.defineProperty(path.subpaths[0].anchors[0], 'x', {
    enumerable: true,
    get() {
      invoked++;
      return 0;
    },
  });
  expect(validDesignPath(path)).toBe(false);
  expect(invoked).toBe(0);
  const sparse = presetDesignPath('line');
  delete (sparse.subpaths[0].anchors as unknown[])[0];
  expect(validDesignPath(sparse)).toBe(false);
  const extra = presetDesignPath('line');
  Object.assign(extra.subpaths[0].anchors, { note: 1 });
  expect(validDesignPath(extra)).toBe(false);
  const symbol = presetDesignPath('line');
  Object.assign(symbol.subpaths[0].anchors[0], { [Symbol('s')]: 1 });
  expect(validDesignPath(symbol)).toBe(false);
  const hidden = presetDesignPath('line');
  Object.defineProperty(hidden.frame, 'x', { value: 0, enumerable: false });
  expect(validDesignPath(hidden)).toBe(false);
});

it('rejects finite native coordinates that overflow or exceed the supported projected range', () => {
  const path = presetDesignPath('line');
  path.frame.width = 1e-300;
  expect(validDesignPath(path)).toBe(true);
  const element = { ...makeDesignElement('shape'), path };
  expect(isDesignWithPaths({ ...createDesign(), schemaVersion: 3, elements: [element] })).toBe(
    false,
  );
  path.frame.width = 220;
  element.bounds.width = 1e308;
  expect(isDesignWithPaths({ ...createDesign(), schemaVersion: 3, elements: [element] })).toBe(
    false,
  );
});

it('rejects overflowing paint extents including inherited strokes', () => {
  const path = presetDesignPath('line'),
    element = { ...makeDesignElement('shape'), path, strokeWidth: 1e308 };
  expect(isDesignWithPaths({ ...createDesign(), schemaVersion: 3, elements: [element] })).toBe(
    false,
  );
  const inherited = { ...element, strokeWidth: undefined, styleId: 'huge' };
  expect(
    isDesignWithPaths({
      ...createDesign(),
      schemaVersion: 3,
      styles: [{ id: 'huge', name: 'huge', appearance: { strokeWidth: 1e308 } }],
      elements: [inherited],
    }),
  ).toBe(false);
});
