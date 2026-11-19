import { describe, expect, it } from 'vitest';
import { crashBarrierViews, crashStudyPoints, crashWaveform, pointBounds } from './crash-view';
import { crashFrameId, crashFrameOf } from './crash-panel';
import { crashResult, resultDisplay, autoDeformationScale } from './results';
import type { CrashRunFields } from './run-crash';

/**
 * TS-2226 (ST-620, VS7c-2): what a crash result shows: the barrier and the ground placed as the
 * run placed them, the waveform thinned without losing its peak, a new study's points from the
 * bodies' bounds, and the frames at true size over one colour range.
 */
const box = new Float64Array([0, -300, 100, 4000, 300, 100, 4000, 300, 1300, 0, -300, 1300]);

describe('crash result views (VS7c-2)', () => {
  it('draws the wall across the nose, the ground under the bodies and the pole on its line', () => {
    const views = crashBarrierViews({
      nodes: box,
      walls: [
        { point: [4002, 0, 0], normal: [-1, 0, 0] },
        { point: [0, 0, 99], normal: [0, 0, 1] },
      ],
      poles: [{ point: [2000, -500, 0], axis: [0, 0, 1], radius: 127 }],
    });
    expect(views.map((v) => v.kind)).toEqual(['wall', 'ground', 'pole']);
    const world = (v: (typeof views)[number]) => {
      const m = v.mesh;
      const out: number[] = [];
      for (let i = 0; i < m.positions.length; i += 3)
        out.push(...[0, 1, 2].map((k) => m.positions[i + k]! + m.origin[k]!));
      return pointBounds(out);
    };
    const wall = world(views[0]!);
    expect(wall.lo[0]).toBeCloseTo(4002, 3);
    expect(wall.hi[0]).toBeCloseTo(4002, 3);
    // Wider than the bodies, centred on them.
    expect(wall.lo[1]).toBeLessThan(-300);
    expect(wall.hi[1]).toBeGreaterThan(300);
    expect((wall.lo[2]! + wall.hi[2]!) / 2).toBeCloseTo(700, 3);
    // Two-sided: its back faces are its own triangles.
    expect(views[0]!.mesh.indices.length).toBe(12);
    const ground = world(views[1]!);
    expect(ground.hi[2]).toBeCloseTo(99, 3);
    expect(ground.lo[0]).toBeLessThan(0);
    const pole = world(views[2]!);
    expect(pole.lo[0]).toBeCloseTo(2000 - 127, 0);
    expect(pole.hi[1]).toBeCloseTo(-500 + 127, 0);
    // From the ground to half again the bodies' height above their top.
    expect(pole.lo[2]).toBeCloseTo(99, 3);
    expect(pole.hi[2]).toBeCloseTo(1300 + 600, 3);
  });

  it('thins the waveform keeping its peak, in ms', () => {
    const n = 12_001;
    const time = Float64Array.from({ length: n }, (_, k) => k * 1e-5);
    const g = Float64Array.from({ length: n }, (_, k) => (k === 4321 ? 55 : Math.sin(k / 500)));
    const w = crashWaveform({ time, cfc60: g, cfc180: g, velocity: time }, 600);
    expect(w.time.length).toBeLessThanOrEqual(600);
    expect(w.time.length).toBeGreaterThan(550);
    expect(Math.max(...w.cfc60)).toBe(55);
    expect(w.time.at(-1)).toBeCloseTo(120, 0);
    expect(w.velocity[0]).toBeCloseTo(w.time[0]! / 1000, 9);
  });

  it('places a new study’s accelerometer on the sill and the pole at mid-length', () => {
    const p = crashStudyPoints([0, -800, 100], [4000, 800, 1300]);
    expect(p.accelerometer).toEqual([1600, 640, 220]);
    expect(p.pole).toEqual({ side: 'right', xMm: 2000, zMm: 700 });
  });

  it('shows the frames at true size over the run’s largest plastic strain', () => {
    const frame = (time: number, u: number, strain: number) => ({
      time,
      displacement: new Float64Array([u, 0, 0, u, 0, 0, u, 0, 0]),
      plasticStrain: new Float64Array([strain]),
      erased: new Uint8Array([0]),
    });
    const fields = {
      kind: 'crash',
      nodes: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      triangles: new Uint32Array([0, 1, 2]),
      frames: [frame(0, 0, 0), frame(0.01, -5, 0.2), frame(0.02, -8, 0.3)],
    } as unknown as CrashRunFields;
    const source = crashResult(fields);
    expect(source.crash?.range).toEqual([0, 0.3]);
    expect(autoDeformationScale(source)).toBe(1);
    expect(source.scalars.map((s) => s.id)).toEqual(['frame-2', 'frame-1', 'frame-0']);
    expect(crashFrameOf(crashFrameId(7))).toBe(7);
    expect(crashFrameOf('von-mises')).toBeUndefined();
    const shown = resultDisplay(source, 'frame-1', 1, [0, 0.3]);
    const x = shown.mesh.positions[0]! + shown.mesh.origin[0]!;
    expect(x).toBeCloseTo(-5, 6);
  });
});
