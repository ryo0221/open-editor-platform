import { describe, expect, it } from 'vitest';
import {
  repairShellMesh,
  shellMeshQuality,
  shellRepairNote,
  shellSliverPlaces,
  type ShellMesh,
} from './index';

/** A flat shell mesh (z = 0) from 2-D points, triangles, face tags and chains. */
function meshOf(
  points: [number, number][],
  triangles: [number, number, number][],
  faces: number[],
  chains: number[][],
): ShellMesh {
  const offsets = [0];
  for (const c of chains) offsets.push(offsets[offsets.length - 1]! + c.length);
  return {
    nodes: Float64Array.from(points.flatMap(([x, y]) => [x, y, 0])),
    triangles: Uint32Array.from(triangles.flat()),
    thickness: new Float64Array(triangles.length).fill(1.5),
    faces: Int32Array.from(faces),
    shapeFaces: Math.max(...faces) + 1,
    shapeEdges: chains.length,
    edges: { offsets: Uint32Array.from(offsets), nodes: Uint32Array.from(chains.flat()) },
  };
}

/** Signed areas (+z up) of every triangle. */
function areas(m: ShellMesh) {
  const out: number[] = [];
  for (let e = 0; e < m.triangles.length / 3; e++) {
    const [a, b, c] = [0, 1, 2].map((i) => 3 * m.triangles[3 * e + i]!);
    const ux = m.nodes[b!]! - m.nodes[a!]!,
      uy = m.nodes[b! + 1]! - m.nodes[a! + 1]!;
    const vx = m.nodes[c!]! - m.nodes[a!]!,
      vy = m.nodes[c! + 1]! - m.nodes[a! + 1]!;
    out.push((ux * vy - uy * vx) / 2);
  }
  return out;
}
const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
const chainsOf = (m: ShellMesh) =>
  Array.from({ length: m.shapeEdges }, (_, k) =>
    Array.from(m.edges.nodes.subarray(m.edges.offsets[k]!, m.edges.offsets[k + 1]!)),
  );

// TS-1478, ST-245: the slivers a car skin's seams leave, mended before a shell run.
describe('shell mesh repair (CR1a)', () => {
  it('leaves a sound mesh as it is', () => {
    const m = meshOf(
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
      [
        [0, 1, 2],
        [0, 2, 3],
      ],
      [0, 0],
      [[0, 1, 2, 3, 0]],
    );
    const r = repairShellMesh(m);
    expect([r.flips, r.collapses, r.absorbs, r.below]).toEqual([0, 0, 0, []]);
    expect(r.mesh).toEqual(m);
    expect(shellRepairNote(r)).toBe('');
  });

  it('collapses a needle inside a face and keeps the area, winding and chains', () => {
    // Nodes 4 and 5 are 0.05 mm apart in the middle of a square: two needles share edge 4–5.
    const m = meshOf(
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [5, 5],
        [5.05, 5],
      ],
      [
        [0, 1, 5],
        [1, 2, 5],
        [2, 3, 4],
        [3, 0, 4],
        [0, 5, 4],
        [2, 4, 5],
      ],
      [0, 0, 0, 0, 0, 0],
      [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 0],
      ],
    );
    expect(shellMeshQuality(m).below.length).toBe(2);
    const r = repairShellMesh(m);
    expect(r.below).toEqual([]);
    expect(shellMeshQuality(r.mesh).below).toEqual([]);
    expect(r.flips + r.collapses).toBeGreaterThan(0);
    expect(areas(r.mesh).every((a) => a > 0)).toBe(true);
    expect(sum(areas(r.mesh))).toBeCloseTo(100, 9);
    expect(chainsOf(r.mesh)).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 0],
    ]);
    expect([...new Set(r.mesh.thickness)]).toEqual([1.5]);
    expect(shellRepairNote(r)).toMatch(
      /^, mended slivers by \d+ edge flips?, \d+ collapses? and 0 chain absorbs$/,
    );
  });

  it('absorbs a flat sliver into the chain edge it lies on and splits the triangle across', () => {
    // Face 0 above the seam chain 0–1 (y = 0), face 1 below. Apex 2 sits 0.05 mm above the seam;
    // moving it onto node 0 or 1 would turn triangle 3-6-2 or 1-5-2 over, so it joins the chain.
    const m = meshOf(
      [
        [0, 0],
        [10, 0],
        [5, 0.05],
        [5, 5],
        [5, -6],
        [8, 0.2],
        [2, 0.2],
      ],
      [
        [0, 1, 2],
        [1, 5, 2],
        [5, 3, 2],
        [3, 6, 2],
        [6, 0, 2],
        [1, 0, 4],
      ],
      [0, 0, 0, 0, 0, 1],
      [
        [0, 1],
        [1, 5, 3, 6, 0],
        [0, 4, 1],
      ],
    );
    expect(shellMeshQuality(m).below).toEqual([0]);
    const before = sum(areas(m));
    const r = repairShellMesh(m);
    expect([r.absorbs, r.below]).toEqual([1, []]);
    expect(chainsOf(r.mesh)).toEqual([
      [0, 2, 1],
      [1, 5, 3, 6, 0],
      [0, 4, 1],
    ]);
    // Node 2 moved onto the chord; the face below now has two triangles meeting there.
    expect(Array.from(r.mesh.nodes.subarray(6, 9))).toEqual([5, 0, 0]);
    expect(Array.from(r.mesh.faces).filter((f) => f === 1).length).toBe(2);
    expect(areas(r.mesh).every((a) => a > 0)).toBe(true);
    // The sliver's 0.25 mm² goes with it: the outline's area stays.
    expect(sum(areas(r.mesh))).toBeCloseTo(before, 9);
  });

  it('absorbs a flat sliver into an open border chain (a sheet’s free edge, CR5e)', () => {
    // TS-1579, ST-272: as above, but nothing lies below the chain 0–1 (F29's floor flange edge):
    // the apex joins the border chain and the sliver goes, with no triangle to split.
    const m = meshOf(
      [
        [0, 0],
        [10, 0],
        [5, 0.05],
        [5, 5],
        [8, 0.2],
        [2, 0.2],
      ],
      [
        [0, 1, 2],
        [1, 4, 2],
        [4, 3, 2],
        [3, 5, 2],
        [5, 0, 2],
      ],
      [0, 0, 0, 0, 0],
      [
        [0, 1],
        [1, 4, 3, 5, 0],
      ],
    );
    expect(shellMeshQuality(m).below).toEqual([0]);
    const before = sum(areas(m));
    const r = repairShellMesh(m);
    expect([r.absorbs, r.below]).toEqual([1, []]);
    expect(chainsOf(r.mesh)).toEqual([
      [0, 2, 1],
      [1, 4, 3, 5, 0],
    ]);
    expect(Array.from(r.mesh.nodes.subarray(6, 9))).toEqual([5, 0, 0]);
    expect(r.mesh.triangles.length / 3).toBe(4);
    expect(areas(r.mesh).every((a) => a > 0)).toBe(true);
    // The sliver's area goes into the apex's other triangles: the outline's area stays.
    expect(sum(areas(r.mesh))).toBeCloseTo(before, 9);
  });

  it('flips a flat sliver’s long edge inside one face', () => {
    const m = meshOf(
      [
        [0, 0],
        [10, 0],
        [5, 0.05],
        [5, -5],
      ],
      [
        [0, 1, 2],
        [1, 0, 3],
      ],
      [0, 0],
      [
        [0, 3, 1],
        [1, 2, 0],
      ],
    );
    const r = repairShellMesh(m);
    expect([r.flips, r.below]).toEqual([1, []]);
    expect(areas(r.mesh).every((a) => a > 0)).toBe(true);
    expect(sum(areas(r.mesh))).toBeCloseTo(sum(areas(m)), 9);
  });

  it('keeps a closed shell and a thickness border as they are (CR1a review)', () => {
    // A tetrahedron: collapsing its short edge would leave two triangles on the same nodes.
    const tet: ShellMesh = {
      nodes: Float64Array.from([0, 0, 0, 0.01, 0, 0.001, 0, 10, 0, 10, 0, 0]),
      triangles: Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3]),
      thickness: new Float64Array(4).fill(1),
      faces: new Int32Array(4),
      shapeFaces: 1,
      shapeEdges: 0,
      edges: { offsets: Uint32Array.from([0]), nodes: new Uint32Array(0) },
    };
    const closed = repairShellMesh(tet);
    expect(closed.collapses).toBe(0);
    expect(closed.mesh.triangles.length).toBe(12);
    // A lone sliver whose free node sits inside a closed chain: removing it would erase the
    // component, so it stays and is reported.
    const lone = meshOf(
      [
        [0, 0],
        [10, 0],
        [0.01, 0.001],
      ],
      [[0, 1, 2]],
      [0],
      [[0, 1, 2, 0]],
    );
    const kept = repairShellMesh(lone);
    expect([kept.collapses, kept.below]).toEqual([0, [0]]);
    expect(kept.mesh.triangles.length).toBe(3);
    // The flat sliver beside a thicker triangle: a flip would move area between thicknesses.
    const m = meshOf(
      [
        [0, 0],
        [10, 0],
        [5, 0.05],
        [5, -5],
      ],
      [
        [0, 1, 2],
        [1, 0, 3],
      ],
      [0, 0],
      [
        [0, 3, 1],
        [1, 2, 0],
      ],
    );
    m.thickness.set([1, 2]);
    // Instead the sliver's apex (a chain node) goes onto its chain neighbour, taking only the
    // sliver's 0.25 mm² of the 1 mm part; the 2 mm triangle keeps its area.
    const r = repairShellMesh(m);
    expect([r.flips, r.collapses, r.below]).toEqual([0, 1, []]);
    expect(Array.from(r.mesh.thickness)).toEqual([2]);
    expect(sum(areas(r.mesh))).toBeCloseTo(25, 9);
  });

  it('names where a sliver it may not touch lies', () => {
    // Every node is a chain end: nothing may move.
    const m = meshOf(
      [
        [0, 0],
        [10, 0],
        [5, 0.06],
      ],
      [[0, 1, 2]],
      [0],
      [
        [0, 1],
        [1, 2],
        [2, 0],
      ],
    );
    const r = repairShellMesh(m);
    expect([r.flips, r.collapses, r.absorbs, r.below]).toEqual([0, 0, 0, [0]]);
    expect(shellSliverPlaces(r.mesh, r.below)).toBe('(5.0, 0.0, 0.0) mm on face 0');
    expect(shellSliverPlaces(r.mesh, [0, 0, 0, 0, 0])).toMatch(/; 2 more$/);
  });
});
