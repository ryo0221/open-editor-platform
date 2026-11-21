import type { CadUnderlay } from '@editor-platform/cad-core';
import type { CadMesh } from '@editor-platform/cad-kernel-occt';
import { describe, expect, it } from 'vitest';
import {
  distanceTransform,
  underlayDeviation,
  underlayHeatImage,
  underlayLineMask,
  type CadUnderlayImage,
} from './underlay-deviation';

/** An axis-aligned box's display mesh (12 triangles), as the kernel gives one. */
function boxMesh(bodyId: string, min: [number, number, number], max: [number, number, number]) {
  const [x0, y0, z0] = min,
    [x1, y1, z1] = max;
  const positions = new Float32Array([
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ]); // prettier-ignore
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
    2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7,
  ]); // prettier-ignore
  return { bodyId, origin: [0, 0, 0], positions, indices } as unknown as CadMesh;
}
/** A white image with a 1-pixel black rectangle outline from (x0, y0) to (x1, y1) inclusive. */
function outline(w: number, h: number, x0: number, y0: number, x1: number, y1: number) {
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  const ink = (x: number, y: number) => data.fill(0, 4 * (y * w + x), 4 * (y * w + x) + 3);
  for (let x = x0; x <= x1; x++) {
    ink(x, y0);
    ink(x, y1);
  }
  for (let y = y0; y <= y1; y++) {
    ink(x0, y);
    ink(x1, y);
  }
  return { width: w, height: h, data } satisfies CadUnderlayImage;
}
const underlay = (over: Partial<CadUnderlay> = {}): CadUnderlay => ({
  id: 'u-front',
  name: 'Front',
  view: 'front',
  assetId: 'a',
  pixels: [200, 100],
  mmPerPixel: 1,
  // Pixel (0, 0) at u = −100, v = 50: the image spans u −100…100, v −50…50.
  originMm: [-100, 50],
  opacity: 0.5,
  ...over,
});

describe('#15 deviation of the model from an underlay, headless', () => {
  it('measures each silhouette cell to the nearest line exactly', () => {
    const mask = new Uint8Array(25);
    mask[12] = 1;
    const d = distanceTransform(mask, 5, 5);
    expect(d[12]).toBe(0);
    expect(d[0]).toBe(8);
    expect(d[2]).toBe(4);
    expect(distanceTransform(new Uint8Array(4), 2, 2).every((x) => x === Infinity)).toBe(true);
  });

  it('reports zero on a matching drawing and the offset on a shifted one, reproducibly', () => {
    // A box 80 wide (x −40…40) and 40 tall (z −20…20); its front silhouette spans pixels
    // x 60…139, y 30…69.
    const meshes = [boxMesh('body-a', [-40, -10, -20], [40, 10, 20])];
    const shown = new Set(['body-a']);
    const same = underlayDeviation(underlay(), outline(200, 100, 60, 30, 139, 69), meshes, shown);
    expect(same.bodies).toHaveLength(1);
    expect(same.bodies[0]).toMatchObject({ bodyId: 'body-a' });
    expect(same.bodies[0]!.maxMm).toBe(0);
    // The drawing 5 px (5 mm) wider on the right: that side is 5 mm off, the others not.
    const wide = underlayDeviation(underlay(), outline(200, 100, 60, 30, 144, 69), meshes, shown);
    expect(wide.bodies[0]!.maxMm).toBe(5);
    expect(wide.bodies[0]!.meanMm).toBeGreaterThan(0);
    expect(wide.bodies[0]!.meanMm).toBeLessThan(5);
    // Twice the mm a pixel: twice the deviation.
    const coarse = underlayDeviation(
      underlay({ mmPerPixel: 2, originMm: [-200, 100] }),
      outline(200, 100, 80, 40, 122, 59),
      meshes,
      shown,
    );
    expect(coarse.cellMm).toBe(2);
    // Same inputs, same numbers.
    const again = underlayDeviation(underlay(), outline(200, 100, 60, 30, 144, 69), meshes, shown);
    expect(again.bodies).toEqual(wide.bodies);
    expect(Array.from(again.heat)).toEqual(Array.from(wide.heat));
    // The heat overlay paints only silhouette cells.
    const rgba = underlayHeatImage(wide, 1);
    let painted = 0;
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i]) painted++;
    expect(painted).toBe(wide.bodies[0]!.cells);
  });

  it('measures each shown body apart, in its own view, and skips hidden ones', () => {
    const meshes = [
      boxMesh('body-a', [-40, -10, -20], [40, 10, 20]),
      boxMesh('body-b', [-90, -10, -40], [-70, 10, 40]),
    ];
    const image = outline(200, 100, 60, 30, 139, 69);
    const both = underlayDeviation(underlay(), image, meshes, new Set(['body-a', 'body-b']));
    expect(both.bodies.map((b) => b.bodyId)).toEqual(['body-a', 'body-b']);
    expect(both.bodies[0]!.maxMm).toBe(0);
    expect(both.bodies[1]!.meanMm).toBeGreaterThan(20);
    const one = underlayDeviation(underlay(), image, meshes, new Set(['body-a']));
    expect(one.bodies.map((b) => b.bodyId)).toEqual(['body-a']);
    // From the top, the box spans y −10…10: a drawing of that matches.
    const top = underlayDeviation(
      underlay({ view: 'top' }),
      outline(200, 100, 60, 40, 139, 59),
      meshes.slice(0, 1),
      new Set(['body-a']),
    );
    expect(top.bodies[0]!.maxMm).toBe(0);
    expect(() =>
      underlayDeviation(underlay(), outline(10, 10, 0, 0, 9, 9), meshes, new Set(['body-a'])),
    ).toThrow('underlay-image-size');
  });

  it('coarsens a large image to the grid limit and reads dark opaque pixels as lines', () => {
    const image = outline(200, 100, 60, 30, 139, 69);
    const lines = underlayLineMask(image, 4);
    expect([lines.width, lines.height]).toEqual([50, 25]);
    const d = underlayDeviation(
      underlay(),
      image,
      [boxMesh('body-a', [-40, -10, -20], [40, 10, 20])],
      new Set(['body-a']),
      50,
    );
    expect(d.cellMm).toBe(4);
    expect(d.bodies[0]!.maxMm).toBeLessThanOrEqual(4);
    // A transparent dark pixel is not a line.
    const clear = outline(4, 4, 0, 0, 3, 3);
    clear.data.fill(0);
    expect(underlayLineMask(clear).mask.every((m) => m === 0)).toBe(true);
  });
});
