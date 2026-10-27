import { describe, expect, it } from 'vitest';
import type { CadCamera, CadNamedView } from '@editor-platform/cad-core';
import { defaultGrid, gridFor, initialView, niceStep, orbitRotateSpeed, viewOf } from './view-math';

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

  it('opens with the first named view whose bodies are all shown (ST-27#9)', () => {
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
  });
});
