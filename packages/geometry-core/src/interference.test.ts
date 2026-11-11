import { describe, expect, it } from 'vitest';
import {
  checkInterference,
  interferenceLimits,
  trianglesPenetrate,
  type InterferenceBody,
  type InterferenceMesh,
  type InterferencePose,
  type InterferenceVec3,
} from './interference';

const still: InterferencePose = { rotation: [0, 0, 0, 1], translationMm: [0, 0, 0] };
/**
 * An axis-aligned box as a kernel meshes it: each face on its own vertices (so shells are found
 * only after welding), each face cut into cells of about `cell` mm. `inward` flips the faces
 * (a cavity's walls); `skip` leaves a face out (a mesh hole).
 */
function box(
  lo: InterferenceVec3,
  hi: InterferenceVec3,
  cell = Infinity,
  skip?: number,
): InterferenceMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let axis = 0; axis < 3; axis++)
    for (const side of [0, 1]) {
      if (skip === axis * 2 + side) continue;
      const u = (axis + 1) % 3;
      const v = (axis + 2) % 3;
      const nu = Math.max(1, Math.ceil((hi[u]! - lo[u]!) / cell));
      const nv = Math.max(1, Math.ceil((hi[v]! - lo[v]!) / cell));
      const base = positions.length / 3;
      for (let i = 0; i <= nu; i++)
        for (let j = 0; j <= nv; j++) {
          const p: InterferenceVec3 = [0, 0, 0];
          p[axis] = side ? hi[axis]! : lo[axis]!;
          p[u] = lo[u]! + ((hi[u]! - lo[u]!) * i) / nu;
          p[v] = lo[v]! + ((hi[v]! - lo[v]!) * j) / nv;
          positions.push(...p);
        }
      for (let i = 0; i < nu; i++)
        for (let j = 0; j < nv; j++) {
          const a = base + i * (nv + 1) + j;
          const b = a + nv + 1;
          indices.push(a, b, b + 1, a, b + 1, a + 1);
        }
    }
  return { positions: Float64Array.from(positions), indices: Uint32Array.from(indices) };
}
/** A watertight mesh of 1 mm voxels' outer faces, two triangles per face, vertices shared. */
function voxels(
  filled: (x: number, y: number, z: number) => boolean,
  size: number,
): InterferenceMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const ids = new Map<string, number>();
  const at = (p: InterferenceVec3) => {
    const key = p.join(',');
    let i = ids.get(key);
    if (i === undefined) {
      i = positions.length / 3;
      positions.push(...p);
      ids.set(key, i);
    }
    return i;
  };
  for (let x = 0; x < size; x++)
    for (let y = 0; y < size; y++)
      for (let z = 0; z < size; z++) {
        if (!filled(x, y, z)) continue;
        for (let axis = 0; axis < 3; axis++)
          for (const side of [0, 1]) {
            const n: InterferenceVec3 = [x, y, z];
            n[axis] = n[axis]! + (side ? 1 : -1);
            if (filled(n[0], n[1], n[2])) continue;
            const u = (axis + 1) % 3;
            const v = (axis + 2) % 3;
            const corner = (du: number, dv: number) => {
              const p: InterferenceVec3 = [x, y, z];
              p[axis] = p[axis]! + side;
              p[u] = p[u]! + du;
              p[v] = p[v]! + dv;
              return at(p);
            };
            const [a, b, c, d] = [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)];
            // Outward: (u, v, axis) is right-handed, so the +side face winds u→v.
            if (side) indices.push(a, b, c, a, c, d);
            else indices.push(a, c, b, a, d, c);
          }
      }
  return { positions: Float64Array.from(positions), indices: Uint32Array.from(indices) };
}
const body = (
  id: string,
  meshes: InterferenceMesh[],
  pose: InterferencePose = still,
): InterferenceBody => ({ id, meshes, pose });
const kinds = (bodies: InterferenceBody[], ...rest: Parameters<typeof checkInterference>[1][]) => {
  const r = checkInterference(bodies, rest[0]);
  if (r.status !== 'ok') return r.code;
  return r.findings.map((f) => `${f.a}/${f.b}:${f.kind}`);
};

describe('MR3 static interference on meshes (TS-1707)', () => {
  it('crosses only where triangles penetrate, not where they touch', () => {
    const t: InterferenceVec3[] = [
      [0, 0, 0],
      [10, 0, 0],
      [0, 10, 0],
    ];
    expect(
      trianglesPenetrate(t, [
        [2, 2, -1],
        [2, 2, 1],
        [4, 4, 1],
      ]),
    ).toBeGreaterThan(0);
    // Where they cross: the shared span on the common line.
    const segment: InterferenceVec3[] = [];
    trianglesPenetrate(
      t,
      [
        [2, 2, -1],
        [2, 2, 1],
        [4, 4, 1],
      ],
      undefined,
      segment,
    );
    expect(segment.map((p) => p.map((v) => +v.toFixed(9))).sort((p, q) => p[0]! - q[0]!)).toEqual([
      [2, 2, 0],
      [3, 3, 0],
    ]);
    // Coplanar, or meeting along an edge or a vertex: contact.
    expect(
      trianglesPenetrate(t, [
        [1, 1, 0],
        [5, 1, 0],
        [1, 5, 0],
      ]),
    ).toBe(-1);
    expect(
      trianglesPenetrate(t, [
        [1, 1, 0],
        [5, 1, 0],
        [1, 1, 5],
      ]),
    ).toBe(-1);
  });
  it('reports two boxes that cross, and not two that rest on each other', () => {
    const a = box([0, 0, 0], [10, 10, 10]);
    expect(kinds([body('a', [a]), body('b', [box([5, 5, 5], [15, 15, 15])])])).toEqual([
      'a/b:intersect',
    ]);
    expect(kinds([body('a', [a]), body('b', [box([2, 2, 10], [8, 8, 20])])])).toEqual([]);
    expect(kinds([body('a', [a]), body('b', [box([10, 0, 0], [20, 10, 10])])])).toEqual([]);
  });
  it('keeps flush contact clear and finds a crossing along a mesh line, with fine meshes', () => {
    const a = box([0, 0, 0], [10, 10, 10], 1);
    // Stacked on the same footprint, and side by side: their meshes meet on shared lines.
    expect(kinds([body('a', [a]), body('b', [box([0, 0, 10], [10, 10, 20], 1)])])).toEqual([]);
    expect(kinds([body('a', [a]), body('b', [box([10, 0, 0], [20, 10, 10], 1)])])).toEqual([]);
    // A bar through the face at x = 10 whose mesh has a line exactly on that face.
    expect(kinds([body('a', [a]), body('b', [box([9, 4, 4], [20, 6, 6], 1)])])).toEqual([
      'a/b:intersect',
    ]);
  });
  it('finds volumes that overlap where their faces only meet in planes (Codex #1006)', () => {
    const a = box([0, 0, 0], [10, 10, 10]);
    expect(kinds([body('a', [a]), body('b', [box([5, 0, 0], [15, 10, 10])])])).toEqual([
      'a/b:intersect',
    ]);
    expect(kinds([body('a', [a]), body('b', [a])])).toEqual(['a/b:intersect']);
    // Without crossings to measure, the depth is the overlap's smallest extent.
    const depth = (b: InterferenceMesh) => {
      const r = checkInterference([body('a', [a]), body('b', [b])]);
      return r.status === 'ok' ? r.findings[0]?.depthMm : r.code;
    };
    expect(depth(box([5, 0, 0], [15, 10, 10]))).toBeCloseTo(5, 6);
    expect(depth(a)).toBeCloseTo(10, 6);

    // Thin: 0.005 mm, five times the contact tolerance.
    expect(kinds([body('a', [a]), body('b', [box([9.995, 0, 0], [20, 10, 10])])])).toEqual([
      'a/b:intersect',
    ]);
    // Resting on each other stays clear.
    expect(kinds([body('a', [a]), body('b', [box([0, 0, 10], [10, 10, 20])])])).toEqual([]);
  });
  it('gathers a finely meshed overlap’s evidence without overflowing the stack (Codex #1006)', () => {
    // 290,400 triangles, no strict crossings: every vertex and probe is evidence.
    const fine = box([0, 0, 0], [10, 10, 10], 10 / 110);
    expect(kinds([body('a', [fine]), body('b', [fine])])).toEqual(['a/b:intersect']);
  }, 120_000);
  it('bounds an allowed overlap only by the surface next to it (Codex #1006)', () => {
    // A stepped part: a block resting on the torso's face x = 10, with a peg into the torso.
    const stepped = voxels(
      (x, y, z) =>
        x >= 9 &&
        x < 12 &&
        y >= 0 &&
        y < 10 &&
        z >= 0 &&
        z < 10 &&
        (x >= 10 || (y >= 4 && y < 6 && z >= 4 && z < 6)),
      12,
    );
    const torso = body('torso', [box([0, 0, 0], [10, 10, 10], 1)]);
    const sphere = {
      a: 'torso',
      b: 'part',
      region: { kind: 'sphere' as const, centerMm: [10, 5, 5] as InterferenceVec3, radiusMm: 3 },
    };
    expect(kinds([torso, body('part', [stepped])])).toEqual(['torso/part:intersect']);
    expect(kinds([torso, body('part', [stepped])], [sphere])).toEqual([]);
  });
  it('checks grouped bodies as separate volumes and never against each other (Codex #1007)', () => {
    // One part's two nested solid bodies: together they would cancel as a cavity.
    const part = (id: string, lo: number, hi: number) => ({
      ...body(id, [box([lo, lo, lo], [hi, hi, hi])]),
      group: 'P',
    });
    const r = checkInterference([
      part('P#outer', 0, 10),
      part('P#inner', 1, 9),
      body('Q', [box([2, 2, 2], [3, 3, 3])]),
    ]);
    expect(r.status === 'ok' && r.findings.map((f) => `${f.a}/${f.b}:${f.kind}`)).toEqual([
      'P#outer/Q:contain',
      'P#inner/Q:contain',
    ]);
    // Allowances name the group.
    const allowed = checkInterference(
      [part('P#outer', 0, 10), part('P#inner', 1, 9), body('Q', [box([2, 2, 2], [3, 3, 3])])],
      [{ a: 'Q', b: 'P', region: { kind: 'pair' } }],
    );
    expect(allowed.status === 'ok' && allowed.findings).toEqual([]);
  });
  it('measures disconnected overlaps apart (Codex #1006)', () => {
    const two = () => [box([0, 0, 0], [1, 1, 1]), box([100, 100, 100], [101, 101, 101])];
    const r = checkInterference([body('a', two()), body('b', two())]);
    expect(r.status === 'ok' && r.findings[0]?.depthMm).toBeCloseTo(1, 6);
  });
  it('welds a kernel mesh’s repeated vertices across rounding boundaries (Codex #1006)', () => {
    // Each face's copies of a corner differ by ±1e-10 mm around a weld-grid boundary.
    const outer = box([0.00005, 0.00005, 0.00005], [10.00005, 10.00005, 10.00005]);
    const p = Float64Array.from(outer.positions);
    for (let i = 0; i < p.length; i++) p[i] = p[i]! + (Math.floor(i / 12) % 2 ? 1e-10 : -1e-10);
    const r = checkInterference([
      body('O', [{ positions: p, indices: outer.indices }]),
      body('I', [box([4, 4, 4], [6, 6, 6])]),
    ]);
    expect(r.status === 'ok' && r.findings.map((f) => f.kind)).toEqual(['contain']);
  });
  it('counts a large contained shell without overflowing (Codex #1006)', () => {
    const r = checkInterference([
      body('big', [box([0, 0, 0], [10, 10, 10])]),
      body('fine', [box([4, 4, 4], [6, 6, 6], 2 / 150)]),
    ]);
    expect(r.status === 'ok' && r.findings.map((f) => [f.kind, f.depthMm])).toEqual([
      ['contain', 2],
    ]);
  });
  it('(a) finds a part wholly inside a solid', () => {
    const r = checkInterference([
      body('big', [box([0, 0, 0], [10, 10, 10])]),
      body('small', [box([4, 4, 4], [6, 6, 6])]),
    ]);
    expect(r.status === 'ok' && r.findings).toEqual([
      { a: 'big', b: 'small', kind: 'contain', depthMm: 2, crossings: 0, contained: 1 },
    ]);
  });
  it('(b) leaves a part in a hollow part’s cavity alone', () => {
    // A shelled box: the outer walls and the cavity's walls are two closed shells of one body.
    const hollow = [box([0, 0, 0], [10, 10, 10]), box([2, 2, 2], [8, 8, 8])];
    expect(kinds([body('shell', hollow), body('core', [box([4, 4, 4], [6, 6, 6])])])).toEqual([]);
    // Fitting the cavity exactly, or 0.0005 mm short of its walls: contact (Codex #1006).
    expect(kinds([body('shell', hollow), body('core', [box([2, 2, 2], [8, 8, 8])])])).toEqual([]);
    expect(
      kinds([
        body('shell', hollow),
        body('core', [box([2.0005, 2.0005, 2.0005], [7.9995, 7.9995, 7.9995])]),
      ]),
    ).toEqual([]);
    // 0.0009 mm into a cavity wall is contact too, though a slanted ray meets the wall further
    // off than that (Codex #1006).
    expect(kinds([body('shell', hollow), body('core', [box([4, 4, 4], [8.0009, 6, 6])])])).toEqual(
      [],
    );
    // The same, finely meshed: the wall's nearest triangles lie behind the parity rays.
    const fineHollow = [box([0, 0, 0], [10, 10, 10], 1), box([2, 2, 2], [8, 8, 8], 1)];
    expect(
      kinds([body('shell', fineHollow), body('core', [box([4, 4, 4], [8.0009, 6, 6], 1)])]),
    ).toEqual([]);
    // In the wall itself it is contained.
    expect(kinds([body('shell', hollow), body('pin', [box([0.5, 4, 4], [1.5, 6, 6])])])).toEqual([
      'shell/pin:contain',
    ]);
  });
  it('(c) finds one of a body’s two solids inside another part', () => {
    const r = checkInterference([
      body('A', [box([20, 20, 20], [21, 21, 21]), box([2, 2, 2], [3, 3, 3])]),
      body('B', [box([0, 0, 0], [10, 10, 10])]),
    ]);
    expect(r.status === 'ok' && r.findings).toEqual([
      { a: 'A', b: 'B', kind: 'contain', depthMm: 1, crossings: 0, contained: 1 },
    ]);
  });
  it('(d) allows a joint sphere only where everything lies inside it', () => {
    // An upper arm entering the torso at its shoulder joint (10, 5, 5).
    const torso = body('torso', [box([0, 0, 0], [10, 10, 10], 1)]);
    const arm = body('arm', [box([9, 4, 4], [20, 6, 6], 1)]);
    const sphere = {
      a: 'torso',
      b: 'arm',
      region: { kind: 'sphere' as const, centerMm: [10, 5, 5] as InterferenceVec3, radiusMm: 3 },
    };
    expect(kinds([torso, arm])).toEqual(['torso/arm:intersect']);
    expect(kinds([torso, arm], [sphere])).toEqual([]);
    // Turned about the joint so it also cuts into the torso away from it: reported.
    const turned = body('arm', arm.meshes as InterferenceMesh[], {
      rotation: [0, 0, Math.sin(-Math.PI / 8), Math.cos(-Math.PI / 8)],
      translationMm: [0, 0, 0],
    });
    const pivot = (p: InterferencePose): InterferencePose => {
      // Turn about (10, 5, 5): t = c − R c.
      const [x, y, z, w] = p.rotation;
      const c: InterferenceVec3 = [10, 5, 5];
      const tx = 2 * (y * c[2] - z * c[1]);
      const ty = 2 * (z * c[0] - x * c[2]);
      const tz = 2 * (x * c[1] - y * c[0]);
      const r = [
        c[0] + w * tx + (y * tz - z * ty),
        c[1] + w * ty + (z * tx - x * tz),
        c[2] + w * tz + (x * ty - y * tx),
      ];
      return { rotation: p.rotation, translationMm: [c[0] - r[0]!, c[1] - r[1]!, c[2] - r[2]!] };
    };
    const deep = body('arm', [box([0, 4, 4], [20, 6, 6], 1)], pivot(turned.pose));
    expect(kinds([torso, deep], [sphere])).toEqual(['torso/arm:intersect']);
    // Pushed straight in to the far side: it crosses the torso only at the joint, yet most of it
    // lies inside, out of the sphere.
    const pushed = body('arm', [box([1.5, 4.3, 4.3], [20, 5.7, 5.7], 1)]);
    expect(kinds([torso, pushed], [sphere])).toEqual(['torso/arm:intersect']);
    // Through the torso and out of its far side along a mesh line (Codex #1006).
    const coarse = body('torso', [box([0, 0, 0], [10, 10, 10], 10 / 9)]);
    const through = body('arm', [box([-6, 4, 4], [15, 6, 6], 3)]);
    expect(
      kinds([coarse, through], [{ ...sphere, region: { ...sphere.region, radiusMm: 4 } }]),
    ).toEqual(['torso/arm:intersect']);
    // The overlap reaches the torso's face beyond a small sphere at the arm's end (Codex #1006).
    const end = {
      ...sphere,
      region: { ...sphere.region, centerMm: [9, 5, 5] as InterferenceVec3, radiusMm: 1.5 },
    };
    expect(kinds([torso, arm], [end])).toEqual(['torso/arm:intersect']);
    // Meshed as a kernel meshes flat faces (two triangles each), a bar pinned 2 mm in is
    // allowed by a small sphere: where the triangles cross counts, not their far corners.
    const coarseTorso = body('torso', [box([0, 0, 0], [10, 10, 10])]);
    const pin = body('arm', [box([8, 4, 4], [40, 6, 6])]);
    expect(kinds([coarseTorso, pin])).toEqual(['torso/arm:intersect']);
    expect(kinds([coarseTorso, pin], [sphere])).toEqual([]);
    // A pair allowance removes it whatever the region.
    expect(kinds([torso, deep], [{ a: 'arm', b: 'torso', region: { kind: 'pair' } }])).toEqual([]);
  });
  it('(e) reports a contained shell that runs out of the joint sphere', () => {
    const A = body('A', [box([0.1, 0.1, 0.1], [10, 0.2, 0.2])]);
    const B = body('B', [box([-1, -1, -1], [11, 1, 1])]);
    const near = {
      a: 'A',
      b: 'B',
      region: { kind: 'sphere' as const, centerMm: [0, 0, 0] as InterferenceVec3, radiusMm: 1 },
    };
    expect(kinds([A, B], [near])).toEqual(['A/B:contain']);
    // Wholly inside a larger sphere: allowed.
    expect(kinds([A, B], [{ ...near, region: { ...near.region, radiusMm: 11 } }])).toEqual([]);
  });
  it('calls a pair unknown when a solid has a mesh hole, never clear', () => {
    const holed = body('B', [box([0, 0, 0], [10, 10, 10], Infinity, 1)]);
    const r = checkInterference([holed, body('A', [box([4, 4, 4], [6, 6, 6])])]);
    expect(r.status === 'ok' && r.findings).toEqual([
      { a: 'B', b: 'A', kind: 'unknown', depthMm: 0, crossings: 0, contained: 0, unknownBody: 'B' },
    ]);
    // A holed solid inside a closed one, or two holed solids nested: never clear (Codex #1006).
    const inner = body('I', [box([4, 4, 4], [6, 6, 6], Infinity, 1)]);
    expect(kinds([body('O', [box([0, 0, 0], [10, 10, 10])]), inner])).toEqual(['O/I:unknown']);
    expect(kinds([holed, inner])).toEqual(['B/I:unknown']);
    // A sheet's open shells have no inside: nothing to judge.
    const sheet = body('S', [{ ...box([0, 0, 0], [10, 10, 10], Infinity, 1), sheet: true }]);
    expect(kinds([sheet, body('A', [box([4, 4, 4], [6, 6, 6])])])).toEqual([]);
    // A sheet sharing an edge with a solid of the same body does not open that solid.
    const flap: InterferenceMesh = {
      positions: Float64Array.from([0, 0, 0, 10, 0, 0, 5, -5, 0]),
      indices: Uint32Array.from([0, 1, 2]),
      sheet: true,
    };
    expect(
      kinds([
        body('S', [box([0, 0, 0], [10, 10, 10]), flap]),
        body('A', [box([4, 4, 4], [6, 6, 6])]),
      ]),
    ).toEqual(['S/A:contain']);
    // A sheet through a finely meshed solid, along its mesh lines; one lying on its face is
    // contact.
    const wall = (x: number, lo: number, hi: number): InterferenceMesh => ({
      positions: Float64Array.from([x, lo, lo, x, hi, lo, x, hi, hi, x, lo, hi]),
      indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
      sheet: true,
    });
    const fine = body('F', [box([0, 0, 0], [10, 10, 10], 1)]);
    expect(kinds([fine, body('W', [wall(5, -5, 15)])])).toEqual(['F/W:intersect']);
    expect(kinds([fine, body('W', [wall(10, 2, 8)])])).toEqual([]);
    // Nor its closed ones (Codex #1006).
    const closedSheet = body('S', [{ ...box([0, 0, 0], [10, 10, 10]), sheet: true }]);
    expect(kinds([closedSheet, body('A', [box([4, 4, 4], [6, 6, 6])])])).toEqual([]);
  });
  it('follows poses: the same meshes moved apart, then together', () => {
    const mesh = [box([0, 0, 0], [10, 10, 10])];
    const apart = {
      rotation: [0, 0, 0, 1] as const,
      translationMm: [30, 0, 0] as InterferenceVec3,
    };
    expect(kinds([body('a', mesh), body('b', mesh, { ...apart, rotation: [0, 0, 0, 1] })])).toEqual(
      [],
    );
    // Turned 45° about z around its own corner and moved into the first.
    const q = Math.sin(Math.PI / 8);
    const turned: InterferencePose = {
      rotation: [0, 0, q, Math.cos(Math.PI / 8)],
      translationMm: [8, 2, 0],
    };
    expect(kinds([body('a', mesh), body('b', mesh, turned)])).toEqual(['a/b:intersect']);
  });
  it('refuses past the candidate pair limit', () => {
    const mesh = [box([0, 0, 0], [1, 1, 1])];
    const n = Math.ceil(Math.sqrt(2 * interferenceLimits.candidatePairs)) + 2;
    const many = Array.from({ length: n }, (_, i) => body(`b${i}`, mesh));
    expect(kinds(many)).toBe('interference-limit');
  });
});
