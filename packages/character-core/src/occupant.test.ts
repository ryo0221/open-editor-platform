import { describe, expect, it } from 'vitest';
import { boxMesh, type EpmMesh } from '@editor-platform/geometry-mesh';
import {
  composeMat4,
  emptyCharacter,
  identityTransform,
  occupantCheck,
  occupantFigure,
  occupantSightLengthMm,
  poseAt,
  seatedFigure,
  type OccupantPiece,
} from './index';

/** A box as one piece (fanned to triangles), optionally moved by a matrix. */
function box(id: string, size: [number, number, number], center: [number, number, number]) {
  const m = boxMesh(size, center);
  const indices: number[] = [];
  for (let f = 0; f < 6; f++) {
    const q = [...m.faceIndices.subarray(4 * f, 4 * f + 4)];
    indices.push(q[0]!, q[1]!, q[2]!, q[0]!, q[2]!, q[3]!);
  }
  return { id, meshes: [{ positions: m.positions, indices }] } satisfies OccupantPiece;
}

describe('the occupant check (CR7d, TS-1817)', () => {
  const f = seatedFigure();
  const pose = poseAt(f.doc, f.doc.actions.find((a) => a.id === 'sit')!, 0);
  const side = occupantFigure(f.doc, f.meshes, pose, {
    headBone: 'head',
    hipBone: 'hip',
    eye: { offset: [0, -110, 150], direction: [0, -1, 0] },
  });

  it('reads the posed figure: the head top, the hip and the eye', () => {
    expect(side.figure).toHaveLength(1);
    expect(side.figure[0]!.indices.length).toBe(11 * 6 * 2 * 3);
    expect(side.headTop![2]).toBeCloseTo(1690, 3);
    expect(side.hip).toEqual([0, 0, 950]);
    expect(side.eye!.origin.map((v) => Math.round(v))).toEqual([0, -110, 1600]);
    expect(side.eye!.direction.map((v) => Math.round(v))).toEqual([0, -1, 0]);
    // The thighs point forward (−y): their far end is ahead of the hip.
    const P = side.figure[0]!.positions;
    let front = 0;
    for (let i = 1; i < P.length; i += 3) front = Math.min(front, P[i]!);
    expect(front).toBeLessThan(-700);
  });

  it('measures headroom, the H-point, the sight line and lists the parts the figure overlaps', () => {
    const r = occupantCheck({
      ...side,
      hPoint: [0, 0, 940],
      pieces: [
        box('roof', [1000, 1000, 20], [0, 0, 1800]),
        box('seat', [500, 500, 100], [0, 100, 750]),
        // Across both thighs, 300 mm ahead of the hip.
        box('bar', [1000, 40, 40], [0, -300, 900]),
        box('wall', [1000, 20, 1000], [0, -1000, 1600]),
      ],
    });
    expect(r.interference.status).toBe('ok');
    if (r.interference.status !== 'ok') return;
    expect(r.interference.findings.map((x) => [x.piece, x.kind])).toEqual([['bar', 'intersect']]);
    expect(r.headroom!.hit!.piece).toBe('roof');
    expect(r.headroom!.hit!.distanceMm).toBeCloseTo(100, 3);
    expect(r.hPoint!.distanceMm).toBeCloseTo(10, 6);
    expect(r.hPoint!.offsetMm).toEqual([0, 0, 10]);
    expect(r.sight!.hit!.piece).toBe('wall');
    expect(r.sight!.hit!.distanceMm).toBeCloseTo(880, 3);
    expect(r.sight!.to.map((v) => Math.round(v))).toEqual([0, -990, 1600]);
  });

  it('reads pieces through their matrices, and says when nothing is above or ahead', () => {
    // The roof 500 mm to the side: nothing over the head; the sight line runs its whole length.
    const roof = box('roof', [1000, 1000, 20], [0, 0, 0]);
    const moved = {
      id: 'roof',
      meshes: roof.meshes.map((m) => ({
        ...m,
        matrix: composeMat4({ ...identityTransform(), translation: [1200, 0, 1800] }),
      })),
    };
    const r = occupantCheck({ ...side, pieces: [moved] });
    expect(r.interference).toEqual({ status: 'ok', findings: [] });
    expect(r.headroom).toEqual({ from: side.headTop });
    expect(r.hPoint).toBeUndefined();
    expect(r.sight!.hit).toBeUndefined();
    expect(r.sight!.to[1]).toBeCloseTo(-110 - occupantSightLengthMm, 3);
    // Moved over the head, the same piece is 100 mm above it.
    const over = {
      id: 'roof',
      meshes: roof.meshes.map((m) => ({
        ...m,
        matrix: composeMat4({ ...identityTransform(), translation: [0, 0, 1800] }),
      })),
    };
    expect(occupantCheck({ ...side, pieces: [over] }).headroom!.hit!.distanceMm).toBeCloseTo(
      100,
      3,
    );
  });

  it('reads a sheet as a surface: a figure inside an open sheet box is not contained', () => {
    const shell = box('shell', [3000, 3000, 3000], [0, 0, 1000]);
    const solid = occupantCheck({ ...side, pieces: [shell] });
    expect(solid.interference.status === 'ok' && solid.interference.findings[0]?.kind).toBe(
      'contain',
    );
    const sheet = { ...shell, meshes: shell.meshes.map((m) => ({ ...m, sheet: true })) };
    expect(occupantCheck({ ...side, pieces: [sheet] }).interference).toEqual({
      status: 'ok',
      findings: [],
    });
  });

  it('keeps the shells of the figure apart: a piece inside two overlapping limbs is contained', () => {
    // Two overlapping 10 mm boxes as one mesh, and a 1 mm piece inside their shared volume.
    const a = box('a', [10, 10, 10], [0, 0, 0]).meshes[0]!;
    const b = box('b', [10, 10, 10], [4, 0, 0]).meshes[0]!;
    const positions = new Float32Array([...a.positions, ...b.positions]);
    const indices = [...a.indices, ...b.indices.map((i) => i + 8)];
    const r = occupantCheck({
      figure: [{ positions, indices }],
      pieces: [box('inner', [1, 1, 1], [2, 0, 0])],
    });
    expect(r.interference).toEqual({
      status: 'ok',
      findings: [{ piece: 'inner', kind: 'contain', depthMm: expect.any(Number) }],
    });
  });

  it('triangulates concave faces as the view does, and leaves unweighted skinned vertices in place', () => {
    // An arrow-head pentagon (area 2.5, a reflex corner at (1, 0.5)) on an unskinned part.
    const pentagon: EpmMesh = {
      positions: new Float32Array([0, 0, 0, 2, 0, 0, 2, 2, 0, 1, 0.5, 0, 0, 2, 0]),
      faceSizes: new Uint32Array([5]),
      faceIndices: new Uint32Array([0, 1, 2, 3, 4]),
      faceMaterials: new Uint16Array([0]),
      boneIds: [],
      morphs: [],
    };
    const doc = emptyCharacter('Plate');
    doc.parts.push({
      id: 'plate',
      name: 'Plate',
      parentId: null,
      transform: identityTransform(),
      mesh: 'm',
      materials: [],
      visible: true,
    });
    const flat = occupantFigure(doc, new Map([['m', pentagon]]), poseAt(doc, null, 0), {
      headBone: 'none',
      hipBone: 'none',
    });
    const P = flat.figure[0]!.positions;
    const I = flat.figure[0]!.indices;
    const areas: number[] = [];
    for (let t = 0; t < I.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => 3 * I[t + k]!);
      areas.push(
        ((P[b]! - P[a]!) * (P[c + 1]! - P[a + 1]!) - (P[b + 1]! - P[a + 1]!) * (P[c]! - P[a]!)) / 2,
      );
    }
    expect(areas).toHaveLength(3);
    expect(areas.every((x) => x > 0)).toBe(true);
    expect(areas.reduce((x, y) => x + y, 0)).toBeCloseTo(2.5, 6);
    // The figure's first vertex left without weights, its part moved: the vertex stays put.
    const g = seatedFigure();
    const m = g.meshes.get('mesh-body')!;
    const w = m.weights!;
    const n = m.positions.length / 3;
    const weights = {
      offsets: Uint32Array.from({ length: n + 1 }, (_, i) => Math.max(0, i - 1)),
      bones: w.bones.slice(1),
      values: w.values.slice(1),
    };
    g.doc.parts[0]!.transform = { ...identityTransform(), translation: [100, 0, 0] };
    const moved = occupantFigure(
      g.doc,
      new Map([['mesh-body', { ...m, weights }]]),
      poseAt(g.doc, null, 0),
      { headBone: 'head', hipBone: 'hip' },
    );
    const p0 = moved.figure[0]!.positions;
    expect([p0[0], p0[1], p0[2]]).toEqual([...m.positions.slice(0, 3)]);
  });

  it('welds repeated corners: a box with hard edges stays one closed shell', () => {
    // A 10 mm box whose faces each have their own four corners, and a 1 mm piece inside it.
    const b = boxMesh([10, 10, 10]);
    const positions: number[] = [];
    const indices: number[] = [];
    for (let f = 0; f < 6; f++) {
      const q = [...b.faceIndices.subarray(4 * f, 4 * f + 4)];
      const base = positions.length / 3;
      // Each face's own corners, off by a rounding (well within the weld size).
      for (const v of q)
        positions.push(...[...b.positions.subarray(3 * v, 3 * v + 3)].map((x) => x + f * 1e-5));
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const r = occupantCheck({
      figure: [{ positions: new Float32Array(positions), indices }],
      pieces: [box('inner', [1, 1, 1], [0, 0, 0])],
    });
    expect(r.interference).toEqual({
      status: 'ok',
      findings: [{ piece: 'inner', kind: 'contain', depthMm: expect.any(Number) }],
    });
  });

  it('reads the bodies of a piece apart: a figure inside two overlapping bodies is contained', () => {
    // One piece of two overlapping 10 mm bodies, and a 1 mm figure inside their shared volume.
    const a = box('a', [10, 10, 10], [0, 0, 0]).meshes[0]!;
    const b = box('b', [10, 10, 10], [4, 0, 0]).meshes[0]!;
    const inner = box('figure', [1, 1, 1], [2, 0, 0]).meshes[0]!;
    const check = (bodies: boolean) =>
      occupantCheck({
        figure: [inner],
        pieces: [
          {
            id: 'part',
            meshes: [
              { ...a, ...(bodies ? { body: 'a' } : {}) },
              { ...b, ...(bodies ? { body: 'b' } : {}) },
            ],
          },
        ],
      }).interference;
    expect(check(true)).toEqual({
      status: 'ok',
      findings: [{ piece: 'part', kind: 'contain', depthMm: expect.any(Number) }],
    });
    // Without body IDs the piece is one body, whose shared volume cancels under ray parity.
    expect(check(false)).toEqual({ status: 'ok', findings: [] });
  });

  it('bounds each figure shell by its own vertices: far shells do not pair with every piece', () => {
    // Eleven 10 mm shells 100 mm apart in one mesh, and 910 small pieces in the gaps between
    // them: none overlaps, and the check is not refused for candidate pairs.
    const positions: number[] = [];
    const indices: number[] = [];
    for (let k = 0; k <= 10; k++) {
      const m = box('s', [10, 10, 10], [100 * k, 0, 0]).meshes[0]!;
      const base = positions.length / 3;
      positions.push(...m.positions);
      indices.push(...m.indices.map((i) => i + base));
    }
    const pieces: OccupantPiece[] = [];
    for (let k = 0; k < 10; k++)
      for (let j = 0; j < 91; j++)
        pieces.push(box(`p${k}-${j}`, [0.4, 0.4, 0.4], [100 * k + 20 + (j * 60) / 90, 0, 0]));
    const r = occupantCheck({
      figure: [{ positions: new Float32Array(positions), indices }],
      pieces,
    });
    expect(r.interference).toEqual({ status: 'ok', findings: [] });
  });

  it('bounds each prop mesh by its own vertices: bodies sharing a buffer do not pair with all', () => {
    // 912 small bodies of one part in one shared vertex buffer, 100 mm apart from eleven far
    // figure shells: none overlaps, and the check is not refused for candidate pairs.
    const positions: number[] = [];
    const meshes: { body: string; indices: number[] }[] = [];
    for (let k = 0; k < 912; k++) {
      const m = box('b', [0.4, 0.4, 0.4], [20 + (k % 10) * 100 + Math.floor(k / 10) * 0.6, 0, 0])
        .meshes[0]!;
      const base = positions.length / 3;
      positions.push(...m.positions);
      meshes.push({ body: `b${k}`, indices: m.indices.map((i) => i + base) });
    }
    const shared = new Float32Array(positions);
    const figure: number[] = [];
    const indices: number[] = [];
    for (let k = 0; k <= 10; k++) {
      const m = box('s', [10, 10, 10], [100 * k, 0, 0]).meshes[0]!;
      const base = figure.length / 3;
      figure.push(...m.positions);
      indices.push(...m.indices.map((i) => i + base));
    }
    const r = occupantCheck({
      figure: [{ positions: new Float32Array(figure), indices }],
      pieces: [{ id: 'part', meshes: meshes.map((m) => ({ ...m, positions: shared })) }],
    });
    expect(r.interference).toEqual({ status: 'ok', findings: [] });
  });
});
