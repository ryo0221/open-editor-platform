import { describe, expect, it } from 'vitest';
import { f31BoxBuilding } from './fixtures';
import { applyBimOperation, assertBimOperation } from './operations';
import { bimLimits, type BimCamera } from './model';
import { validateBim } from './validation';

const camera = (id: string, name = id): BimCamera => ({
  id,
  name,
  position: [-12_000, -16_000, 9_000],
  target: [0, 0, 1_500],
  up: [0, 0, 1],
  fovDeg: 45,
});

describe('saved cameras (#19)', () => {
  it('keeps named cameras through a JSON round trip, and an empty list removes them', () => {
    const doc = applyBimOperation(f31BoxBuilding(), {
      type: 'setCameras',
      cameras: [camera('c-1', 'Entrance'), camera('c-2', 'Roof')],
    });
    expect(validateBim(doc)).toEqual([]);
    const back = JSON.parse(JSON.stringify(doc));
    expect(validateBim(back)).toEqual([]);
    expect(back.cameras.map((c: BimCamera) => c.name)).toEqual(['Entrance', 'Roof']);
    const cleared = applyBimOperation(back, { type: 'setCameras', cameras: [] });
    expect(Object.hasOwn(cleared, 'cameras')).toBe(false);
    expect(validateBim(cleared)).toEqual([]);
  });

  it('refuses a broken camera and an operation of the wrong shape', () => {
    const base = f31BoxBuilding();
    const broken: [Partial<BimCamera> & Record<string, unknown>, string][] = [
      [{ up: [0, 0, 0] }, 'camera-up'],
      [{ fovDeg: 0 }, 'camera-fov'],
      [{ fovDeg: 170 }, 'camera-fov'],
      [{ target: [-12_000, -16_000, 9_000] }, 'camera-target'],
      [{ extra: 1 }, ''],
      [{ position: [2e9, 0, 0] }, 'camera-position'],
    ];
    for (const [patch, code] of broken) {
      const diagnostics = validateBim({ ...base, cameras: [{ ...camera('c-1'), ...patch }] });
      expect(diagnostics.length).toBeGreaterThan(0);
      if (code) expect(diagnostics.map((d) => d.code)).toContain(code);
    }
    // A fitted view of a large site stands beyond the model's ±1,000,000 mm (Codex on #30).
    expect(
      validateBim({
        ...base,
        cameras: [{ ...camera('c-1'), position: [-1_981_002, -2_701_366, 1_622_320] }],
      }),
    ).toEqual([]);
    expect(validateBim({ ...base, cameras: [] }).length).toBeGreaterThan(0);
    const many = Array.from({ length: bimLimits.cameras + 1 }, (_, i) => camera(`c-${i}`));
    expect(validateBim({ ...base, cameras: many }).map((d) => d.code)).toContain('limit-count');
    expect(() =>
      applyBimOperation(base, { type: 'setCameras', cameras: [{ ...camera('c'), fovDeg: 0 }] }),
    ).toThrow();
    expect(() => assertBimOperation({ type: 'setCameras' })).toThrow('operation-schema');
    expect(() => assertBimOperation({ type: 'setCameras', cameras: [] })).not.toThrow();
  });
});
