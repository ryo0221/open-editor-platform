import { describe, expect, it } from 'vitest';
import type { CadMesh } from '@editor-platform/cad-kernel-occt';
import type { CadTopologyTable } from '@editor-platform/cad-core';
import {
  applySimulationOperation,
  simulationFixture,
  validateSimulation,
} from '@editor-platform/simulation-core';
import {
  bondCandidates,
  spreadAcross,
  takenBondKey,
  candidateBond,
  displayDeflection,
  displayDeflectionShare,
  exactBondCandidates,
  type BondDistanceMeasure,
} from './bond-candidates';
import { meshDeflection } from '@editor-platform/cad-kernel-occt';

/**
 * TS-1451 (ST-230#3): bond candidates where analysed bodies touch (R3j-4). A box as a display mesh:
 * faces x0, x1, y0, y1, z0, z1 (0–5), two triangles each.
 */
function box(
  bodyId: string,
  min: [number, number, number],
  max: [number, number, number],
): CadMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const faceIds: number[] = [];
  const quad = (face: number, corners: [number, number, number][]) => {
    const base = positions.length / 3;
    for (const c of corners) positions.push(...c);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    faceIds.push(face + 1, face + 1);
  };
  const [x0, y0, z0] = min,
    [x1, y1, z1] = max;
  quad(0, [
    [x0, y0, z0],
    [x0, y0, z1],
    [x0, y1, z1],
    [x0, y1, z0],
  ]);
  quad(1, [
    [x1, y0, z0],
    [x1, y1, z0],
    [x1, y1, z1],
    [x1, y0, z1],
  ]);
  quad(2, [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y0, z1],
    [x0, y0, z1],
  ]);
  quad(3, [
    [x0, y1, z0],
    [x0, y1, z1],
    [x1, y1, z1],
    [x1, y1, z0],
  ]);
  quad(4, [
    [x0, y0, z0],
    [x0, y1, z0],
    [x1, y1, z0],
    [x1, y0, z0],
  ]);
  quad(5, [
    [x0, y0, z1],
    [x1, y0, z1],
    [x1, y1, z1],
    [x0, y1, z1],
  ]);
  return {
    bodyId,
    origin: [0, 0, 0],
    positions: Float32Array.from(positions),
    normals: new Float32Array(positions.length),
    indices: Uint32Array.from(indices),
    faceIds: Uint32Array.from(faceIds),
    vertices: new Float64Array(0),
    faceBase: 0,
    edgeBase: 6,
    edges: new Float32Array(0),
    edgeIds: new Uint32Array(0),
    topology: {
      faces: Array.from({ length: 6 }, () => ({
        name: null,
        centroid: [0, 0, 0] as [number, number, number],
        area: 0,
      })),
      edges: [],
      vertices: [],
    },
  };
}

/** Boxes as one body: box k's faces are 6k…6k + 5. */
function joined(bodyId: string, boxes: [number[], number[]][]): CadMesh {
  const parts = boxes.map(([a, b]) =>
    box(bodyId, a as [number, number, number], b as [number, number, number]),
  );
  const at = (k: number) => parts.slice(0, k).reduce((n, m) => n + m.positions.length / 3, 0);
  return {
    ...parts[0]!,
    positions: Float32Array.from(parts.flatMap((m) => [...m.positions])),
    normals: new Float32Array(parts.reduce((n, m) => n + m.positions.length, 0)),
    indices: Uint32Array.from(parts.flatMap((m, k) => [...m.indices].map((v) => v + at(k)))),
    faceIds: Uint32Array.from(parts.flatMap((m, k) => [...m.faceIds].map((f) => f + 6 * k))),
    edgeBase: 6 * parts.length,
    topology: { ...parts[0]!.topology, faces: parts.flatMap((m) => m.topology.faces) },
  };
}

describe('bond candidates (R3j-4)', () => {
  it('keeps every face of the other body a follower face spans, corners included', () => {
    // A shell slab whose bottom face (x 0–3) lies on four strips 0.75 mm wide.
    const strips = box('strips', [0, 0, -1], [3, 1, 0]);
    const top = strips.indices.length / 3 - 2;
    const positions = [...strips.positions];
    const indices = [...strips.indices].slice(0, 3 * 10);
    const faceIds = [...strips.faceIds].slice(0, 10);
    for (let k = 0; k < 4; k++) {
      const base = positions.length / 3;
      const [x0, x1] = [0.75 * k, 0.75 * (k + 1)];
      positions.push(x0, 0, 0, x1, 0, 0, x1, 1, 0, x0, 1, 0);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      faceIds.push(6 + k + 1, 6 + k + 1);
    }
    expect(top).toBe(10);
    const sheet: CadMesh = {
      ...strips,
      positions: Float32Array.from(positions),
      normals: new Float32Array(positions.length),
      indices: Uint32Array.from(indices),
      faceIds: Uint32Array.from(faceIds),
      topology: {
        ...strips.topology,
        faces: Array.from({ length: 10 }, () => strips.topology.faces[0]!),
      },
    };
    const r = bondCandidates(
      [
        { bodyId: 'slab', mesh: box('slab', [0, 0, 0], [3, 1, 1]), shell: true },
        { bodyId: 'strips', mesh: sheet, shell: false },
      ],
      0.01,
    );
    const bottom = r.candidates.find((c) => c.follower.bodyId === 'slab');
    expect(bottom?.follower.faces).toEqual([4]);
    expect(bottom?.on.faces).toEqual([6, 7, 8, 9]);
  });
  it('offers the smaller of two touching solid faces to follow the larger', () => {
    const r = bondCandidates(
      [
        { bodyId: 'a', mesh: box('a', [0, 0, 0], [10, 10, 10]), shell: false },
        { bodyId: 'b', mesh: box('b', [10, 2, 2], [20, 8, 8]), shell: false },
      ],
      0.01,
    );
    expect(r.notOffered).toEqual([]);
    expect(r.candidates).toEqual([
      { follower: { bodyId: 'b', faces: [0] }, on: { bodyId: 'a', faces: [1] }, gap: 0, area: 36 },
    ]);
  });
  it('lets a shell plate’s rim follow a solid block, and its skin follow nothing solid', () => {
    const plate = box('plate', [0, 0, 0], [100, 50, 1]);
    const block = box('block', [100, 0, -10], [120, 50, 10]);
    const r = bondCandidates(
      [
        { bodyId: 'plate', mesh: plate, shell: true },
        { bodyId: 'block', mesh: block, shell: false },
      ],
      0.01,
    );
    expect(r.candidates).toEqual([
      {
        follower: { bodyId: 'plate', faces: [1] },
        on: { bodyId: 'block', faces: [0] },
        gap: expect.closeTo(0, 9),
        area: 50,
      },
    ]);
    // A solid pad on the plate's skin is not offered: it cannot follow the shell. CR5f (TS-1584,
    // ST-274): the skin follows the pad as a contact instead, only where it lies under it.
    const pad = box('pad', [10, 10, 1], [20, 20, 5]);
    const s = bondCandidates(
      [
        { bodyId: 'plate', mesh: plate, shell: true },
        { bodyId: 'pad', mesh: pad, shell: false },
      ],
      0.01,
    );
    expect(s.candidates).toEqual([
      {
        follower: { bodyId: 'plate', faces: [5] },
        on: { bodyId: 'pad', faces: [4] },
        gap: expect.closeTo(0, 9),
        area: 5000,
        contact: true,
      },
    ]);
    // A plate meeting the block's side only along a line, or crossing it, is no contact.
    expect(
      bondCandidates(
        [
          { bodyId: 'plate', mesh: plate, shell: true },
          { bodyId: 'post', mesh: box('post', [40, 20, -10], [50, 30, 10]), shell: false },
        ],
        0.01,
      ).candidates,
    ).toEqual([]);
    // Codex on #1022: a 20 mm pad on a 10 m panel of two triangles is sampled at its own step.
    expect(
      bondCandidates(
        [
          { bodyId: 'panel', mesh: box('panel', [0, 0, 0], [10000, 5000, 1]), shell: true },
          { bodyId: 'pad', mesh: box('pad', [2, 2, 1], [22, 22, 10]), shell: false },
        ],
        0.01,
      ).candidates.filter((c) => c.contact),
    ).toEqual([
      {
        follower: { bodyId: 'panel', faces: [5] },
        on: { bodyId: 'pad', faces: [4] },
        // Within the tolerance (a sample at the pad's edge may lie up to it beside the pad).
        gap: expect.toSatisfy((g: number) => g <= 0.01),
        area: 5e7,
        contact: true,
      },
    ]);
    // Codex on #1022: a block on the plate's skin only along its edge (x = 100) is no contact,
    // in whatever direction the two lie (here also turned 45° about z).
    const turned = (m: CadMesh): CadMesh => {
      const positions = Float32Array.from(m.positions);
      const c = Math.SQRT1_2;
      for (let k = 0; k < positions.length; k += 3) {
        const [x, y] = [positions[k]! + m.origin[0], positions[k + 1]! + m.origin[1]];
        positions[k] = c * x - c * y - m.origin[0];
        positions[k + 1] = c * x + c * y - m.origin[1];
      }
      return { ...m, positions };
    };
    const edge = box('edge', [100, 10, 1], [120, 40, 10]);
    for (const t of [(m: CadMesh) => m, turned])
      expect(
        bondCandidates(
          [
            { bodyId: 'plate', mesh: t(plate), shell: true },
            { bodyId: 'edge', mesh: t(edge), shell: false },
          ],
          0.01,
        ).candidates.filter((c) => c.contact),
      ).toEqual([]);
    expect(spreadAcross([0, 0, 0, 1, 1, 0, 2, 2, 0, 3, 3, 0])).toBeLessThan(1e-6);
    // A U of three boxes around the plate's top touches it only along three edges: no area.
    const u: [number[], number[]][] = [
      [
        [-20, 10, 1],
        [0, 60, 10],
      ],
      [
        [100, 10, 1],
        [120, 60, 10],
      ],
      [
        [0, 50, 1],
        [100, 60, 10],
      ],
    ];
    expect(
      bondCandidates(
        [
          { bodyId: 'plate', mesh: plate, shell: true },
          { bodyId: 'u', mesh: joined('u', u), shell: false },
        ],
        0.01,
      ).candidates.filter((c) => c.contact),
    ).toEqual([]);
    // A 0.5 mm pad at 0.001 mm: sampled at its own step.
    expect(
      bondCandidates(
        [
          { bodyId: 'plate', mesh: plate, shell: true },
          { bodyId: 'dot', mesh: box('dot', [12, 12, 1], [12.5, 12.5, 5]), shell: false },
        ],
        0.001,
      ).candidates.filter((c) => c.contact),
    ).toMatchObject([{ follower: { faces: [5] }, on: { bodyId: 'dot', faces: [4] } }]);
    // A 0.5 × 100 mm strip: its narrow side is crossed too, also turned 30° about z.
    const spun = (m: CadMesh): CadMesh => {
      const positions = Float32Array.from(m.positions);
      const [c, n] = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];
      for (let k = 0; k < positions.length; k += 3) {
        const [x, y] = [positions[k]!, positions[k + 1]!];
        positions[k] = c * x - n * y;
        positions[k + 1] = n * x + c * y;
      }
      return { ...m, positions };
    };
    for (const t of [(m: CadMesh) => m, spun])
      expect(
        bondCandidates(
          [
            { bodyId: 'plate', mesh: t(box('plate', [0, 0, 0], [200, 200, 1])), shell: true },
            {
              bodyId: 'strip',
              mesh: t(box('strip', [12, 12, 1], [12.5, 112, 10])),
              shell: false,
            },
          ],
          0.001,
        ).candidates.filter((c) => c.contact),
      ).toMatchObject([{ follower: { faces: [5] }, on: { bodyId: 'strip', faces: [4] } }]);
    expect(spreadAcross([0, 0, 0, 10, 0, 0, 5, 3, 0])).toBeCloseTo(3, 9);
    // Two mounts on one panel face: two contacts of the same follower face, each taken apart;
    // a bond (not a contact) of those faces is one, whatever it lies on.
    const face = [{ bodyId: 'plate', face: 5 }];
    expect(takenBondKey(face, [{ bodyId: 'pad', face: 4 }])).not.toBe(
      takenBondKey(face, [{ bodyId: 'pad2', face: 4 }]),
    );
    expect(takenBondKey(face, [{ bodyId: 'pad', face: 4 }])).toBe(
      takenBondKey(face, [{ bodyId: 'pad', face: 2 }]),
    );
    expect(takenBondKey(face)).toBe(takenBondKey([...face]));
    expect(s.notOffered).toEqual([
      {
        bodyId: 'pad',
        face: 4,
        onBodyId: 'plate',
        reason: expect.stringMatching(/cannot follow a shell/),
      },
    ]);
  });
  it('makes one of two coincident faces follow, offers nothing apart, and keeps the gap', () => {
    const a = box('a', [0, 0, 0], [10, 10, 10]);
    const twin = box('b', [10, 0, 0], [20, 10, 10]);
    const r = bondCandidates(
      [
        { bodyId: 'a', mesh: a, shell: false },
        { bodyId: 'b', mesh: twin, shell: true },
      ],
      0.01,
    );
    expect(r.candidates.map((c) => [c.follower, c.on])).toEqual([
      [
        { bodyId: 'b', faces: [0] },
        { bodyId: 'a', faces: [1] },
      ],
    ]);
    const apart = bondCandidates(
      [
        { bodyId: 'a', mesh: a, shell: false },
        { bodyId: 'b', mesh: box('b', [10.5, 0, 0], [20, 10, 10]), shell: false },
      ],
      0.1,
    );
    expect(apart.candidates).toEqual([]);
    const close = bondCandidates(
      [
        { bodyId: 'a', mesh: a, shell: false },
        { bodyId: 'b', mesh: box('b', [10.05, 2, 2], [20, 8, 8]), shell: false },
      ],
      0.1,
    );
    expect(close.candidates).toHaveLength(1);
    expect(close.candidates[0]!.gap).toBeCloseTo(0.05, 5);
  });
});

describe('a candidate as a bond (R3j-4)', () => {
  it('names each side on its body, the source body by leaving the body out', () => {
    const { doc } = simulationFixture();
    const two = applySimulationOperation(doc, {
      type: 'addBody',
      body: { bodyId: 'rib', materialId: 'steel' },
    });
    const table = (feature: string): CadTopologyTable => ({
      faces: Array.from({ length: 6 }, (_, i) => ({
        name: [feature, `side:${i}`],
        centroid: [i, 0, 0] as [number, number, number],
        area: 10,
      })),
      edges: [],
      vertices: [],
    });
    const bodies = new Map([
      ['plate', { table: table('plate-extrude'), featureId: 'plate-extrude', name: 'Plate' }],
      ['rib', { table: table('rib-extrude'), featureId: 'rib-extrude', name: 'Rib' }],
    ]);
    const bond = candidateBond(
      two,
      {
        follower: { bodyId: 'rib', faces: [0, 2] },
        on: { bodyId: 'plate', faces: [1] },
        gap: 0,
        area: 1,
      },
      bodies,
      0.1,
    );
    expect(bond.name).toBe('Rib to Plate');
    expect(bond.follower.map((t) => [t.body, t.ref.featureId, t.ref.name])).toEqual([
      ['rib', 'rib-extrude', [['rib-extrude', 'side:0']]],
      ['rib', 'rib-extrude', [['rib-extrude', 'side:2']]],
    ]);
    expect(bond.on.map((t) => [t.body, t.ref.featureId])).toEqual([[undefined, 'plate-extrude']]);
    const bonded = applySimulationOperation(two, { type: 'addBond', bond });
    expect(validateSimulation(bonded)).toEqual([]);
    expect(
      candidateBond(
        bonded,
        {
          follower: { bodyId: 'rib', faces: [3] },
          on: { bodyId: 'plate', faces: [1] },
          gap: 0,
          area: 1,
        },
        bodies,
        0.1,
      ).id,
    ).toBe('bond-2');
    // CR5f (TS-1584): a contact stays one, and the document takes it; `contact` is only `true`.
    const contact = candidateBond(
      two,
      {
        follower: { bodyId: 'rib', faces: [3] },
        on: { bodyId: 'plate', faces: [1] },
        gap: 0,
        area: 1,
        contact: true,
      },
      bodies,
      0.1,
    );
    expect(contact.contact).toBe(true);
    expect(
      validateSimulation(applySimulationOperation(two, { type: 'addBond', bond: contact })),
    ).toEqual([]);
    const wrong = { ...contact, contact: false } as unknown as typeof contact;
    expect(validateSimulation({ ...two, bonds: [wrong] }).map((d) => [d.code, d.path])).toEqual([
      ['value', '$.bonds[0].contact'],
    ]);
  });
});

describe('bond candidates on the exact surfaces (CR4a)', () => {
  // TS-1528, ST-260: two 1 m boxes, 3 mm apart in the triangles; the kernel says how far apart
  // the exact surfaces are (a curved skin's triangles lie up to 0.1% of its size off it).
  const bodies = [
    { bodyId: 'lower', mesh: box('lower', [0, 0, -1000], [1000, 1000, 0]), shell: true },
    { bodyId: 'upper', mesh: box('upper', [0, 0, 3], [1000, 1000, 1003]), shell: true },
  ];
  // The kernel's answer: d to the face across (the lower top 5, the upper bottom 4), 5 mm more
  // to the others in reach.
  const across = (q: { bodyId: string; faces: number[] }) =>
    q.faces[0] === (q.bodyId === 'lower' ? 5 : 4);
  const fixed =
    (d: number): BondDistanceMeasure =>
    async (queries) =>
      queries.map((q) => ({
        distances: new Float64Array(q.points.length / 3).fill(across(q) ? d : d + 5),
      }));
  it('keeps the faces the kernel measures within the tolerance, with its gap', async () => {
    expect(displayDeflectionShare).toBe(meshDeflection.relative);
    // On the triangles alone, nothing touches within 0.5 mm.
    expect(bondCandidates(bodies, 0.5).candidates).toEqual([]);
    const queries: Parameters<BondDistanceMeasure>[0][] = [];
    const measure: BondDistanceMeasure = (q) => (queries.push(q), fixed(0.3)(q));
    const r = await exactBondCandidates(bodies, 0.5, measure);
    expect(r.candidates).toHaveLength(1);
    const [c] = r.candidates;
    // The upper box's bottom (z0, face 4) follows the lower's top (z1, face 5): the smaller of
    // two equal faces, or the first.
    expect([c!.follower, c!.on].map((s) => s.faces.length)).toEqual([1, 1]);
    expect(c!.gap).toBe(0.3);
    expect(c!.area).toBeCloseTo(1e6, 3);
    // Each follower face's own nodes, and its triangles' centres taken onto it, measured to
    // each face of the other body within the widened bounds (the top and its 4 sides).
    expect(queries).toHaveLength(1);
    const sent = queries[0]!;
    // Both ways (each box's face lies on the other's): the exact measure picks one to follow.
    expect(sent.length).toBe(2 * 2 * 5);
    expect(sent.filter((x) => !x.via).every((x) => x.points.length === 3 * 4)).toBe(true);
    expect(sent.filter((x) => x.via).every((x) => x.points.length === 3 * 2)).toBe(true);
    expect(sent.filter((x) => x.via).map((x) => x.via)).toContainEqual({
      bodyId: c!.follower.bodyId,
      faces: [c!.follower.faces[0]],
    });
    // It follows the faces nearest its points: here all at 0.3 mm, the first measured.
    expect(c!.on.faces).toHaveLength(1);
    expect(c).not.toHaveProperty('reach');
    expect((await exactBondCandidates(bodies, 0.5, fixed(0.8))).candidates).toEqual([]);
    await expect(
      exactBondCandidates(bodies, 0.5, async () => [{ code: 'face-distance-no-mesh' }]),
    ).rejects.toThrow('face-distance-no-mesh');
  });

  it('keeps a contact where the exact measure refuses the whole face (Codex on #1022)', async () => {
    // TS-1584, ST-274: a pad over all of a plate's top but a 0.1 mm strip at x = 0. The widened
    // search takes the top as lying wholly on the pad; the exact distances (to the pad's bottom,
    // its face 4) say the strip lies 0.1 mm off it, so the face is no bond: it is a contact.
    const plate = box('plate', [0, 0, 0], [100, 50, 1]);
    const pad = box('pad', [0.1, 0, 1], [100, 50, 5]);
    const two = [
      { bodyId: 'plate', mesh: plate, shell: true },
      { bodyId: 'pad', mesh: pad, shell: false },
    ];
    expect(
      bondCandidates(two, 0.01, (b) => displayDeflection(b.mesh)).candidates.some(
        (c) => c.follower.bodyId === 'plate' && c.follower.faces.includes(5) && !c.contact,
      ),
    ).toBe(true);
    const toBottom: BondDistanceMeasure = async (queries) =>
      queries.map((q) => ({
        distances: Float64Array.from({ length: q.points.length / 3 }, (_, k) => {
          const [x, y, z] = [0, 1, 2].map((a) => q.points[3 * k + a]!);
          if (q.bodyId !== 'pad' || q.faces[0] !== 4) return 100;
          const dx = Math.max(0.1 - x!, 0, x! - 100);
          const dy = Math.max(-y!, 0, y! - 50);
          return Math.hypot(dx, dy, z! - 1);
        }),
      }));
    const r = await exactBondCandidates(two, 0.01, toBottom);
    expect(r.candidates.filter((c) => c.follower.bodyId === 'plate')).toEqual([
      {
        follower: { bodyId: 'plate', faces: [5] },
        on: { bodyId: 'pad', faces: [4] },
        // Measured on the exact surfaces: the samples lying on the pad, the strip's left out.
        gap: expect.toSatisfy((g: number) => g <= 0.01),
        area: 5000,
        contact: true,
      },
    ]);
  });

  it('measures a contact on the exact surfaces before offering it (Codex on #1022)', async () => {
    // TS-1584, ST-274: the distance to a box's face (0–5: x0, x1, y0, y1, z0, z1) as the kernel
    // would measure it.
    const boxes: Record<string, [number[], number[]][]> = {};
    const sent: Parameters<BondDistanceMeasure>[0] = [];
    const toFace: BondDistanceMeasure = async (queries) =>
      queries.map((q) => {
        sent.push(q);
        const [min, max] = boxes[q.bodyId]![Math.floor(q.faces[0]! / 6)]!;
        const a = Math.floor((q.faces[0]! % 6) / 2);
        const at = q.faces[0]! % 2 ? max[a]! : min[a]!;
        return {
          distances: Float64Array.from({ length: q.points.length / 3 }, (_, k) => {
            const p = [0, 1, 2].map((b) => q.points[3 * k + b]!);
            const off = [0, 1, 2].map((b) =>
              b === a ? p[b]! - at : Math.max(min[b]! - p[b]!, 0, p[b]! - max[b]!),
            );
            return Math.hypot(...off);
          }),
        };
      });
    const run = (panel: [number, number, number], ...pad: [number[], number[]][]) => {
      boxes.panel = [[[0, 0, 0], panel]];
      boxes.pad = pad;
      return exactBondCandidates(
        [
          { bodyId: 'panel', mesh: box('panel', [0, 0, 0], panel), shell: true },
          { bodyId: 'pad', mesh: joined('pad', pad), shell: false },
        ],
        0.01,
        toFace,
      );
    };
    // 1 mm above a 1 m panel: within the display allowance, not on the exact surfaces.
    expect(
      (
        await run(
          [1000, 500, 1],
          [
            [10, 10, 2],
            [30, 30, 10],
          ],
        )
      ).candidates,
    ).toEqual([]);
    // On a 30 m panel (an allowance of 33 mm), the 20 mm pad is still a contact.
    const big = await run(
      [30000, 15000, 1],
      [
        [2, 2, 1],
        [22, 22, 10],
      ],
    );
    expect(big.candidates).toEqual([
      {
        follower: { bodyId: 'panel', faces: [5] },
        on: { bodyId: 'pad', faces: [4] },
        gap: expect.toSatisfy((g: number) => g <= 0.01),
        area: 4.5e8,
        contact: true,
      },
    ]);
    // Each sample is taken onto the panel's exact face first.
    expect(sent.at(-1)!.via).toEqual({ bodyId: 'panel', faces: [5] });
    // A U around a 100 × 50 panel's top: three edge contacts, no area.
    expect(
      (
        await run(
          [100, 50, 1],
          [
            [-20, 10, 1],
            [0, 60, 10],
          ],
          [
            [100, 10, 1],
            [120, 60, 10],
          ],
          [
            [0, 50, 1],
            [100, 60, 10],
          ],
        )
      ).candidates.filter((c) => c.contact),
    ).toEqual([]);
  });

  it('measures a follower against every face in reach, and its interior (Codex on #960)', async () => {
    // The face nearest on the triangles is 2 mm off on the exact surfaces; another face in
    // reach is 0.2 mm away, and is the one followed.
    const [coarse] = bondCandidates(bodies, 0.5, (b) => displayDeflection(b.mesh)).candidates;
    const nearestOnTriangles = coarse!.on.faces[0];
    const other = coarse!.reach!.find((g) => g !== nearestOnTriangles)!;
    const byFace: BondDistanceMeasure = async (queries) =>
      queries.map((q) => ({
        distances: new Float64Array(q.points.length / 3).fill(q.faces[0] === other ? 0.2 : 2),
      }));
    const [c] = (await exactBondCandidates(bodies, 0.5, byFace)).candidates;
    expect(c!.gap).toBe(0.2);
    expect(c!.on.faces).toEqual([other]);
    // An interior that leaves the other face (a flat chord of a curved face) refuses it.
    const interior: BondDistanceMeasure = async (queries) =>
      queries.map((q) => ({
        distances: new Float64Array(q.points.length / 3).fill(q.via ? 0.8 : 0),
      }));
    expect((await exactBondCandidates(bodies, 0.5, interior)).candidates).toEqual([]);
  });

  it('picks which face follows after the exact measure (Codex on #960)', async () => {
    // The lower top would follow (the first of two equal faces) but leaves the upper bottom by
    // 0.8 mm somewhere; the upper bottom lies within 0.3 mm of the lower top: it follows.
    const oneWay: BondDistanceMeasure = async (queries) =>
      queries.map((q) => ({
        distances: new Float64Array(q.points.length / 3).fill(
          !across(q) ? 9 : q.bodyId === 'upper' ? 0.8 : 0.3,
        ),
      }));
    const [c, more] = (await exactBondCandidates(bodies, 0.5, oneWay)).candidates;
    expect(more).toBeUndefined();
    expect([c!.follower.bodyId, c!.on.bodyId, c!.gap]).toEqual(['upper', 'lower', 0.3]);
    // Both within: the first of two equal faces follows, as on the triangles.
    const [d] = (await exactBondCandidates(bodies, 0.5, fixed(0.3))).candidates;
    expect(d!.follower.bodyId).toBe('lower');
  });

  it('widens by at least the kernel’s least deflection', () => {
    const tiny = box('tiny', [0, 0, 0], [0.1, 0.1, 0.1]);
    expect(displayDeflection(tiny)).toBe(0.001);
  });
});
