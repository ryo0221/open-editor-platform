import { describe, expect, it } from 'vitest';
import type { CadCamera, CadNamedView } from '@editor-platform/cad-core';
import {
  compareSizes,
  defaultGrid,
  gridFor,
  initialView,
  niceStep,
  orbitRotateSpeed,
  standardViews,
  viewOf,
} from './view-math';

describe('viewport math', () => {
  it('picks 1, 2 or 5 × 10ⁿ steps', () => {
    expect([0.7, 1, 1.5, 3, 7, 46, 460, 4600].map(niceStep)).toEqual([
      1, 1, 2, 5, 10, 50, 500, 5000,
    ]);
    expect(niceStep(0)).toBe(defaultGrid.step);
  });

  it('sizes the grid to the model so it reaches past it (ST-27#10)', () => {
    // A 4,600 mm car body: 500 mm cells, well beyond the car on every side.
    const car = gridFor([
      [0, -925, 0],
      [4600, 925, 1450],
    ]);
    expect(car.step).toBe(500);
    expect(car.center).toEqual([2500, 0]);
    const half = (car.step * car.divisions) / 2;
    expect(car.center[0] - half).toBeLessThan(0 - 1000);
    expect(car.center[0] + half).toBeGreaterThan(4600 + 1000);
    expect(half).toBeGreaterThan(925 + 1000);
    // An 80 × 50 mm plate keeps a fine grid.
    const plate = gridFor([
      [0, 0, 0],
      [80, 50, 5],
    ]);
    expect(plate.step).toBe(10);
    expect(plate.divisions).toBeLessThanOrEqual(40);
    // Empty bounds fall back to the default grid.
    expect(
      gridFor([
        [0, 0, 0],
        [0, 0, 10],
      ]),
    ).toBe(defaultGrid);
  });

  it('turns half as far per drag as the OrbitControls default (ST-27#10)', () => {
    // OrbitControls turns 2π × rotateSpeed per viewport height: a 120 px vertical drag on a
    // 700 px viewport now tilts about 31°, not 62°, so it stays above a 33° three-quarter view.
    const tilt = (2 * Math.PI * 120 * orbitRotateSpeed) / 700;
    expect((tilt * 180) / Math.PI).toBeLessThan(33);
  });

  it('rounds a saved view to micrometres', () => {
    expect(
      viewOf(
        { position: [1.23456, -0.0000001, 2], target: [0, 0, 0], up: [0, 0, 1] },
        { type: 'orthographic', spanMm: 100.00049 },
      ),
    ).toEqual({
      camera: { position: [1.235, 0, 2], target: [0, 0, 0], up: [0, 0, 1] },
      projection: { type: 'orthographic', spanMm: 100 },
    });
  });

  it('keeps full precision when rounding would make a top view degenerate', () => {
    const top = { position: [0.0001, 0, 100], target: [0, 0, 0], up: [0, 0, 1] } as CadCamera;
    expect(viewOf(top, { type: 'perspective', fovRad: 0.8 }).camera).toEqual(top);
  });

  it('opens with the first named view that shows every body (ST-27#9)', () => {
    const view = (id: string, bodyIds: string[]): CadNamedView => ({
      id,
      name: id,
      bodyIds,
      camera: { position: [0, -1, 0], target: [0, 0, 0], up: [0, 0, 1] },
      projection: { type: 'perspective', fovRad: 0.8 },
    });
    const views = [view('gone', ['old']), view('side', ['body']), view('top', ['body'])];
    expect(initialView(views, new Set(['body']))?.id).toBe('side');
    expect(initialView([], new Set(['body']))).toBeUndefined();
    // An interior view first does not hide the shell on opening: the whole model opens.
    const car = [view('interior', ['seat']), view('exterior', ['shell', 'seat'])];
    expect(initialView(car, new Set(['shell', 'seat']))?.id).toBe('exterior');
    expect(initialView(car.slice(0, 1), new Set(['shell', 'seat']))).toBeUndefined();
  });

  it('standard views look along the axes with a valid up, planar ones orthographic (#538)', () => {
    for (const v of Object.values(standardViews)) {
      expect(Math.hypot(...v.from)).toBeCloseTo(1, 12);
      // The view direction is never parallel to up (validateCad would refuse it saved).
      const [f, u] = [v.from, v.up];
      const cross = [
        f[1] * u[2] - f[2] * u[1],
        f[2] * u[0] - f[0] * u[2],
        f[0] * u[1] - f[1] * u[0],
      ];
      expect(Math.hypot(...cross)).toBeGreaterThan(0.5);
    }
    expect(standardViews.plan).toMatchObject({
      from: [0, 0, 1],
      up: [0, 1, 0],
      orthographic: true,
    });
    expect(standardViews.front.from).toEqual([0, -1, 0]);
    expect(standardViews['three-quarter'].orthographic).toBe(false);
  });

  it('compares two bodies by size along each axis (#538)', () => {
    // A 1,200 mm route against 1,600 mm equipment, then the route widened to 2,000 mm.
    const equipment: [CadCamera['position'], CadCamera['position']] = [
      [200, 0, 0],
      [1800, 2000, 1800],
    ];
    const route = (width: number): typeof equipment => [
      [0, -5000, 0],
      [width, 15000, 2500],
    ];
    expect(compareSizes(route(1200), equipment)).toEqual([
      { axis: 'X', a: 1200, b: 1600, difference: -400 },
      { axis: 'Y', a: 20000, b: 2000, difference: 18000 },
      { axis: 'Z', a: 2500, b: 1800, difference: 700 },
    ]);
    expect(compareSizes(route(2000), equipment)[0]!.difference).toBe(400);
  });
});
