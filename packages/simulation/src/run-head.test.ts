import { describe, expect, it } from 'vitest';
import type { ShellMesh } from '@editor-platform/geometry-fem';
import { headImpactStudy, type SimulationMaterial } from '@editor-platform/simulation-core';
import { crashResult } from './results';
import { explicitMaterial, runCrashLevel } from './run-crash';

/**
 * TS-2233 (ST-623, VS8b-2): a head impact run of a shell body: a 320 mm steel plate (16 mm
 * triangles) at z = 0, held beyond 140 mm of its centre, struck there by the adult headform.
 */
function plate(per = 20, side = 320): ShellMesh {
  const n = per + 1;
  const nodes = new Float64Array(3 * n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++)
      nodes.set([(side * i) / per - side / 2, (side * j) / per - side / 2, 0], 3 * (j * n + i));
  const triangles = new Uint32Array(6 * per * per);
  for (let j = 0; j < per; j++)
    for (let i = 0; i < per; i++) {
      const a = j * n + i;
      triangles.set([a, a + 1, a + n + 1, a, a + n + 1, a + n], 6 * (j * per + i));
    }
  return {
    nodes,
    triangles,
    thickness: new Float64Array(2 * per * per).fill(0.8),
    faces: new Int32Array(2 * per * per),
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
  plasticity: { strain: [0, 0.2], stress: [200, 340] },
};

describe('head impact run (VS8b-2)', () => {
  it('aims the headform at the target and reads HIC15, its peak and the deflection', async () => {
    const settings = headImpactStudy('head', [0, 0, 0], 140).crash;
    const body = {
      bodyId: 'hood',
      part: { mesh: plate(), material: explicitMaterial(steel), masses: [] },
    };
    const out = await runCrashLevel({ settings, bodies: [body], welds: [] });
    if ('failure' in out) throw new Error(out.failure.detail);
    expect(out.metrics.hic15).toBeGreaterThan(100);
    expect(out.metrics['head-peak-acceleration']).toBeGreaterThan(50);
    expect(out.metrics['head-deflection']).toBeGreaterThan(5);
    expect(out.metrics['occupant-load-criterion']).toBeUndefined();
    expect(out.checks.find((c) => c.name === 'energy-balance')!.pass).toBe(true);
    const f = out.fields;
    expect(f.measures).toBeNull();
    const head = f.head!;
    // The plate's edge rows are beyond 140 mm of the centre (some corners of the inner rows too).
    expect(head.held).toBeGreaterThanOrEqual(4 * 20);
    expect(head.direction[2]).toBeLessThan(0);
    // The plate's 800 triangles and the headform's 384 quads as two each; frames per triangle.
    expect(f.triangles.length / 3).toBe(800 + 2 * 384);
    for (const fr of f.frames) expect(fr.plasticStrain.length).toBe(800 + 2 * 384);
    expect(f.walls).toEqual([]);
    // The result view takes it as any crash run's frames.
    const view = crashResult(f);
    expect(view.scalars.length).toBe(f.frames.length);
    // A target the line misses is refused with its reason.
    const off = await runCrashLevel({
      settings: { ...settings, head: { ...settings.head!, targetMm: [0, 2000, 0] } },
      bodies: [body],
      welds: [],
    });
    expect(off).toMatchObject({ failure: { code: 'solve' } });
    expect('failure' in off && off.failure.detail).toMatch(/misses the vehicle/);
  }, 120_000);

  it('leaves the nodes a spot weld ties free when it holds the rest', async () => {
    // A second plate 10 mm under the first, welded to it at a corner beyond the hold distance.
    const under = plate();
    for (let i = 2; i < under.nodes.length; i += 3) under.nodes[i] = -10;
    const part = (mesh: ShellMesh) => ({ mesh, material: explicitMaterial(steel), masses: [] });
    const out = await runCrashLevel({
      settings: { ...headImpactStudy('head', [0, 0, 0], 140).crash, endTimeMs: 2 },
      bodies: [
        { bodyId: 'hood', part: part(plate()) },
        { bodyId: 'inner', part: part(under) },
      ],
      welds: [{ parts: [0, 1], points: [150, 150, -5], radius: 6 }],
    });
    // Not refused for a held weld node: the first 2 ms of the strike run.
    if ('failure' in out) throw new Error(out.failure.detail);
    expect(out.metrics.hic15).toBeGreaterThan(0);
  }, 120_000);

  it('keeps both nodes of a held tie held (VS8c)', async () => {
    // TS-2235 (Codex on #1225): a second plate 10 mm under the first, each node tied to the
    // one above it (a bond's seam): beyond the hold distance both plates stay held, as the
    // plate alone is.
    const under = plate();
    for (let i = 2; i < under.nodes.length; i += 3) under.nodes[i] = -10;
    const part = (mesh: ShellMesh) => ({ mesh, material: explicitMaterial(steel), masses: [] });
    const settings = { ...headImpactStudy('head', [0, 0, 0], 140).crash, endTimeMs: 0.5 };
    const alone = await runCrashLevel({
      settings,
      bodies: [{ bodyId: 'hood', part: part(plate()) }],
      welds: [],
    });
    const n = under.nodes.length / 3;
    const tied = await runCrashLevel({
      settings,
      bodies: [
        { bodyId: 'hood', part: part(plate()) },
        { bodyId: 'inner', part: part(under) },
      ],
      welds: [
        {
          parts: [1, 0],
          points: [],
          radius: 0,
          ties: [...Array(n).keys()].flatMap((k) => [k, k]),
        },
      ],
    });
    for (const out of [alone, tied]) if ('failure' in out) throw new Error(out.failure.detail);
    if ('failure' in alone || 'failure' in tied) return;
    const held = (out: typeof alone) => out.fields.head!.held;
    expect(held(alone)).toBeGreaterThan(0);
    expect(held(tied)).toBe(2 * held(alone));
  }, 120_000);
});
