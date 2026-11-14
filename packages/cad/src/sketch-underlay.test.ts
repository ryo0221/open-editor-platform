import { describe, expect, it } from 'vitest';
import { f81TwoView, type CadSketch } from '@editor-platform/cad-core';
import type { CadMesh } from '@editor-platform/cad-kernel-occt';
import { sketchUnderlay } from './sketch-underlay';

// One triangle at x 0–80, y 40, z 10–30 (origin moved), as a display mesh of `bodyId`.
const mesh = (bodyId: string, extra: Partial<CadMesh> = {}) =>
  ({
    bodyId,
    origin: [10, 40, 10],
    positions: new Float32Array([-10, 0, 0, 70, 0, 0, 30, 0, 20]),
    indices: new Uint32Array([0, 1, 2]),
    ...extra,
  }) as unknown as CadMesh;

// CLF1a (docs/cad/car-look-process.md). ST-501, TS-2005.
describe('sketchUnderlay (CLF1a)', () => {
  const doc = f81TwoView();
  const side = doc.sketches.find((s) => s.id === 'u1')!;

  it('projects the shown bodies and the other sketches into the sketch plane', () => {
    const under = sketchUnderlay(doc, side, [mesh('roof'), mesh('hidden')], new Set(['roof']))!;
    // u1 is parallel to XZ: u = x, v = z.
    expect(under.shadows.map((s) => s.bodyId)).toEqual(['roof']);
    expect(Array.from(under.shadows[0]!.triangles, (x) => Math.round(x * 1e9) / 1e9)).toEqual([
      0, 10, 80, 10, 40, 30,
    ]);
    // u0, u2, v0–v2 (one arc each) and plan's three lines; never u1's own.
    expect(under.lines.map((l) => `${l.sketchId}/${l.element}`)).toEqual([
      'u0/arc',
      'u2/arc',
      'v0/arc',
      'v1/arc',
      'v2/arc',
      'plan/l0',
      'plan/l1',
      'plan/l2',
    ]);
    // The plan lines lie on z = 0, seen edge-on from the side: v = 0 from x 0 to 80.
    const l0 = under.lines.find((l) => l.element === 'l0')!.points;
    expect(l0.map(([u, v]) => [Math.round(u * 1e6) / 1e6, Math.round(v * 1e6) / 1e6 || 0])).toEqual(
      [
        [0, 0],
        [80, 0],
      ],
    );
    expect(under.bounds![0]).toBeCloseTo(0, 6);
    expect(under.bounds![2]).toBeCloseTo(80, 6);
  });

  it('leaves out coarse and failed meshes, and draws nothing under a sketch on a face', () => {
    const under = sketchUnderlay(
      doc,
      side,
      [mesh('roof', { lod: 'coarse' }), mesh('roof', { beforeFailure: 'net' })],
      new Set(['roof']),
    )!;
    expect(under.shadows).toEqual([]);
    const onFace: CadSketch = {
      ...side,
      plane: {
        face: { featureId: 'net', kind: 'face', name: ['surface'] },
        offset: { literalMm: 0 },
      },
    } as unknown as CadSketch;
    expect(sketchUnderlay(doc, onFace, [mesh('roof')], new Set(['roof']))).toBeUndefined();
  });

  it('turns every triangle one way, so a closed solid fills, and keeps far triangles apart', () => {
    // A closed tetrahedron: seen from the side, its faces project both ways round.
    const solid = {
      bodyId: 'roof',
      origin: [9_000_000, 0, 0],
      positions: new Float32Array([0, 0, 0, 0.25, 0, 0, 0, 0, 0.25, 0, 0.25, 0]),
      indices: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
    } as unknown as CadMesh;
    const t = sketchUnderlay(doc, side, [solid], new Set(['roof']))!.shadows[0]!.triangles;
    for (let i = 0; i < t.length; i += 6) {
      const area =
        (t[i + 2]! - t[i]!) * (t[i + 5]! - t[i + 1]!) -
        (t[i + 4]! - t[i]!) * (t[i + 3]! - t[i + 1]!);
      expect(area).toBeGreaterThanOrEqual(0);
    }
    // 0.25 mm apart at u = 9,000,000 mm (#1112 review): not rounded together.
    expect(
      Math.max(...t.filter((_, i) => i % 2 === 0)) - Math.min(...t.filter((_, i) => i % 2 === 0)),
    ).toBe(0.25);
  });
});
