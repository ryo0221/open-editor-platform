import { describe, expect, it } from 'vitest';
import { f97SquareTube, type ShellMesh } from '@editor-platform/geometry-fem';
import {
  crashStudy,
  type SimulationCrashSettings,
  type SimulationMaterial,
} from '@editor-platform/simulation-core';
import { crashResult, resultDisplay, resultVtu } from './results';
import type { CrashRunFields } from './run-crash';
import { explicitMaterial, runCrashLevel } from './run-crash';

/**
 * TS-2224 (ST-619, VS7c): a crash run of shell bodies: two coarse square tubes along x (F97's,
 * as triangle meshes), welded to nothing, each carrying an added mass, into the wall at 20 km/h.
 */
function tube(y0: number): ShellMesh {
  const { model } = f97SquareTube({ perSide: 4, length: 100 });
  const n = model.nodes.length / 3;
  const nodes = new Float64Array(3 * n);
  for (let i = 0; i < n; i++) {
    const [x, y, z] = [0, 1, 2].map((q) => model.nodes[3 * i + q]!);
    nodes.set([z!, x! + y0, y! + 300], 3 * i);
  }
  const quads = model.shells.length / 4;
  const triangles = new Uint32Array(6 * quads);
  for (let e = 0; e < quads; e++) {
    const [a, b, c, d] = [0, 1, 2, 3].map((k) => model.shells[4 * e + k]!);
    triangles.set([a!, b!, c!, a!, c!, d!], 6 * e);
  }
  return {
    nodes,
    triangles,
    thickness: new Float64Array(2 * quads).fill(1.5),
    faces: new Int32Array(2 * quads),
    shapeFaces: 1,
    shapeEdges: 0,
    edges: { offsets: new Uint32Array([0]), nodes: new Uint32Array(0) },
  };
}
const steel: SimulationMaterial = {
  id: 'steel',
  name: 'Steel',
  model: 'linear-elastic-isotropic',
  youngsModulus: 210_000,
  poissonsRatio: 0.3,
  density: 7.85e-9,
  plasticity: { strain: [0], stress: [300] },
};

describe('crash run of shell bodies (VS7c)', () => {
  const bodies = (material: SimulationMaterial) =>
    [-200, 200].map((y0, k) => ({
      bodyId: `rail-${k}`,
      part: {
        mesh: tube(y0),
        material: explicitMaterial(material),
        masses: [{ faces: [0], mass: 0.01 }],
      },
    }));
  const settings = (endTimeMs: number): SimulationCrashSettings => ({
    ...crashStudy('front', [0, -200, 300]).crash,
    speedKmh: 20,
    gravity: false,
    endTimeMs,
    intrusions: [{ name: 'rail', point: [100, -200, 325], reference: [0, -200, 325] }],
  });

  it('runs to the end time and reads the deceleration, OLC, crush and intrusion', async () => {
    const steps: number[] = [];
    const out = await runCrashLevel({
      settings: settings(120),
      bodies: bodies(steel),
      welds: [],
      explicit: { hourglass: 0.05 },
      progress: (t) => void steps.push(t),
    });
    if ('failure' in out) throw new Error(out.failure.detail);
    expect(steps.length).toBeGreaterThan(1);
    expect(out.metrics['occupant-load-criterion']).toBeGreaterThan(0);
    expect(out.metrics['peak-deceleration']).toBeGreaterThan(0);
    expect(out.metrics.crush).toBeGreaterThan(0);
    expect(out.metrics.crush).toBeLessThan(100);
    expect(out.metrics['max-intrusion']).toBeGreaterThan(0);
    expect(out.checks.map((c) => c.name)).toEqual([
      'energy-balance',
      'hourglass-energy',
      'mass-scaling',
    ]);
    expect(out.checks[0]!.pass, out.checks[0]!.detail).toBe(true);
    const f = out.fields;
    expect(f.bodies.map((b) => [b.nodeOffset, b.shellOffset])).toEqual([
      [0, 0],
      [f.bodies[0]!.nodes, f.bodies[0]!.shells],
    ]);
    expect(f.triangles.length / 3).toBe(f.bodies[0]!.shells * 2);
    expect(f.walls).toHaveLength(1);
    expect(f.frames.length).toBeGreaterThan(10);
    // The view: one field per frame (the last first), each moved by its frame; and a VTU.
    const view = crashResult(f);
    expect(view.scalars).toHaveLength(f.frames.length);
    expect(view.scalars[0]!.label).toMatch(/120\.0 ms/);
    expect(view.displacement).toEqual(view.scalars[0]!.displacement);
    expect(resultVtu(f)).toContain('Plastic strain');
  }, 300_000);

  it('refuses an elastic material and an end time too short for the OLC', async () => {
    const elastic = await runCrashLevel({
      settings: settings(120),
      bodies: bodies({ ...steel, plasticity: undefined }),
      welds: [],
    });
    expect(elastic).toMatchObject({ failure: { code: 'material-missing' } });
    const short = await runCrashLevel({ settings: settings(2), bodies: bodies(steel), welds: [] });
    expect(short).toMatchObject({ failure: { code: 'solve' } });
    expect('failure' in short && short.failure.detail).toMatch(/OLC/);
  }, 60_000);

  it('leaves the shells erased by a frame out of that frame', () => {
    // Two triangles of a square; the second erased in the last frame.
    const frame = (time: number, erased: number[]) => ({
      time,
      displacement: new Float32Array(12),
      plasticStrain: new Float32Array([0.1, 0.4]),
      erased: Uint8Array.from(erased),
    });
    const fields = {
      kind: 'crash',
      nodes: new Float64Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
      triangles: new Uint32Array([0, 1, 2, 0, 2, 3]),
      frames: [frame(0, [0, 0]), frame(0.01, [0, 1])],
    } as unknown as CrashRunFields;
    const view = crashResult(fields);
    const [last, first] = view.scalars;
    expect(last!.hidden).toEqual(Uint8Array.from([0, 1]));
    expect(first!.hidden).toBeUndefined();
    // The erased triangle's strain does not reach its nodes; each shown triangle both sides.
    expect(Array.from(last!.values)).toEqual([
      0.10000000149011612, 0.10000000149011612, 0.10000000149011612, 0,
    ]);
    expect(resultDisplay(view, last!.id, 1, [0, 1]).mesh.indices.length).toBe(2 * 3);
    expect(resultDisplay(view, first!.id, 1, [0, 1]).mesh.indices.length).toBe(4 * 3);
  });
});
