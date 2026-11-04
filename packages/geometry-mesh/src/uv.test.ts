import { describe, expect, it } from 'vitest';
import { editInput } from './edit';
import { loopCut } from './edit-loops';
import type { EpmMesh } from './epm';
import { boxMesh } from './primitives';
import { edgeKey, edgeOfKey, meshEdges, MeshEditError } from './topology';
import { unwrapMesh, uvDistortion, uvSeams } from './uv';

/** A flat grid of n × n quads, s mm each, in z = 0. */
function grid(n: number, s = 10): EpmMesh {
  const positions: number[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) positions.push(i * s, j * s, 0);
  const idx: number[] = [];
  const at = (i: number, j: number) => j * (n + 1) + i;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) idx.push(at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1));
  return {
    positions: new Float32Array(positions),
    faceSizes: new Uint32Array(n * n).fill(4),
    faceIndices: new Uint32Array(idx),
    faceMaterials: new Uint16Array(n * n),
    boneIds: [],
    morphs: [],
  };
}
/** An open tube: `n` sides around z, radius r, height h. */
function tube(n: number, r = 50, h = 100): EpmMesh {
  const positions: number[] = [];
  for (const z of [0, h])
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      positions.push(r * Math.cos(a), r * Math.sin(a), z);
    }
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    idx.push(i, j, n + j, n + i);
  }
  return {
    positions: new Float32Array(positions),
    faceSizes: new Uint32Array(n).fill(4),
    faceIndices: new Uint32Array(idx),
    faceMaterials: new Uint16Array(n),
    boneIds: [],
    morphs: [],
  };
}
const inUnitSquare = (m: EpmMesh) => [...m.uvs!].every((x) => x >= 0 && x <= 1);

describe('UV unwrap (C4a, TS-1236)', () => {
  it('flattens a flat grid without distortion, inside the unit square', () => {
    const out = unwrapMesh(editInput(grid(4)), []);
    const d = uvDistortion(out);
    expect(d.conformal).toBeLessThan(1 + 1e-6);
    expect(d.area[0]).toBeGreaterThan(1 - 1e-6);
    expect(d.area[1]).toBeLessThan(1 + 1e-6);
    expect(inUnitSquare(out)).toBe(true);
    // Everything else is the same mesh.
    expect(out.positions).toEqual(grid(4).positions);
    expect(uvSeams(editInput(out))).toEqual([]);
  });
  it('opens a tube along one seam with no distortion (it is developable)', () => {
    const m = tube(8);
    const out = unwrapMesh(editInput(m), [edgeKey(0, 8)]);
    const d = uvDistortion(out);
    expect(d.conformal).toBeLessThan(1 + 1e-4);
    expect(d.area[1] / d.area[0]).toBeLessThan(1 + 1e-4);
    expect(uvSeams(editInput(out))).toEqual([edgeKey(0, 8)]);
    // An edit keeps the UVs, so the seam: a loop cut around the tube splits it in two.
    const cut = editInput(loopCut(editInput(out), [0, 8], 1));
    const seams = uvSeams(cut);
    expect(seams).toHaveLength(2);
    // The two halves run from the old ends to one new vertex between them.
    const ends = seams.flatMap(edgeOfKey);
    expect(ends).toContain(0);
    expect(ends).toContain(8);
    expect(new Set(ends).size).toBe(3);
    expect(uvDistortion(cut.mesh).conformal).toBeLessThan(1 + 1e-4);
  });
  it('refuses a closed surface with no seam, and unwraps a cube cut along a net', () => {
    const cube = editInput(boxMesh([200, 200, 200]));
    expect(() => unwrapMesh(cube, [])).toThrow(MeshEditError);
    expect(() => unwrapMesh(cube, [])).toThrow(/no seam/);
    // A spanning tree of the cube's 8 corners (7 edges) opens it into one flat net.
    const tree = [
      edgeKey(0, 1),
      edgeKey(0, 2),
      edgeKey(0, 4),
      edgeKey(1, 3),
      edgeKey(1, 5),
      edgeKey(2, 6),
      edgeKey(3, 7),
    ].filter((k) => meshEdges(cube.mesh, cube.topology).includes(k));
    expect(tree).toHaveLength(7);
    const out = unwrapMesh(cube, tree);
    const d = uvDistortion(out);
    expect(d.conformal).toBeLessThan(1 + 1e-4);
    expect(d.area[1] / d.area[0]).toBeLessThan(1 + 1e-4);
    expect(inUnitSquare(out)).toBe(true);
    expect(uvSeams(editInput(out)).sort()).toEqual([...tree].sort());
  });
  it('packs separate charts without overlap and with one texel density', () => {
    const cube = editInput(boxMesh([200, 100, 50]));
    const all = meshEdges(cube.mesh, cube.topology);
    const out = unwrapMesh(cube, all);
    expect(uvSeams(editInput(out)).sort()).toEqual([...all].sort());
    const d = uvDistortion(out);
    expect(d.conformal).toBeLessThan(1 + 1e-6);
    expect(d.area[1] / d.area[0]).toBeLessThan(1 + 1e-6);
    // Six face boxes, none overlapping another.
    const boxes = [...Array(6).keys()].map((f) => {
      const u = [0, 1, 2, 3].map((k) => out.uvs![2 * (4 * f + k)]!);
      const v = [0, 1, 2, 3].map((k) => out.uvs![2 * (4 * f + k) + 1]!);
      return [Math.min(...u), Math.min(...v), Math.max(...u), Math.max(...v)];
    });
    for (let a = 0; a < 6; a++)
      for (let b = a + 1; b < 6; b++) {
        const [x0, y0, x1, y1] = boxes[a]!;
        const [X0, Y0, X1, Y1] = boxes[b]!;
        expect(x1 <= X0 || X1 <= x0 || y1 <= Y0 || Y1 <= y0).toBe(true);
      }
    expect(inUnitSquare(out)).toBe(true);
  });
  it('pins a curved chart on its boundary, so it does not fold (a pyramid with no base)', () => {
    // Base corners (±1, ±1, 0) in mm×100, apex high above: the apex is the farthest point.
    const positions = [-100, -100, 0, 100, -100, 0, 100, 100, 0, -100, 100, 0, 0, 0, 1000];
    const pyramid = editInput({
      positions: new Float32Array(positions),
      faceSizes: new Uint32Array(4).fill(3),
      faceIndices: new Uint32Array([0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4]),
      faceMaterials: new Uint16Array(4),
      boneIds: [],
      morphs: [],
    });
    const uv = unwrapMesh(pyramid, []).uvs!;
    const signs = [0, 1, 2, 3].map((f) => {
      const [a, b, c] = [0, 1, 2].map((k) => 3 * f + k);
      return Math.sign(
        (uv[2 * b!]! - uv[2 * a!]!) * (uv[2 * c! + 1]! - uv[2 * a! + 1]!) -
          (uv[2 * c!]! - uv[2 * a!]!) * (uv[2 * b! + 1]! - uv[2 * a! + 1]!),
      );
    });
    expect(signs).toEqual([1, 1, 1, 1]);
  });
  it('turns each chart square to the texture axes (its smallest bounding box)', () => {
    // A flat grid and every face of a box: every UV edge runs along u or v.
    for (const m of [editInput(grid(3)), editInput(boxMesh([200, 100, 50]))]) {
      const out = unwrapMesh(m, meshEdges(m.mesh, m.topology));
      const t = editInput(out).topology;
      for (let f = 0; f < out.faceSizes.length; f++) {
        const s = t.faceStart[f]!,
          n = t.faceSizes[f]!;
        for (let k = 0; k < n; k++) {
          const a = s + k,
            b = s + ((k + 1) % n);
          const du = Math.abs(out.uvs![2 * b]! - out.uvs![2 * a]!);
          const dv = Math.abs(out.uvs![2 * b + 1]! - out.uvs![2 * a + 1]!);
          expect(Math.min(du, dv)).toBeLessThan(1e-5);
        }
      }
    }
    // One chart (no seams on the grid): its edges run along the axes too.
    const g = editInput(grid(4));
    const one = unwrapMesh(g, []);
    const du = Math.abs(one.uvs![2]! - one.uvs![0]!),
      dv = Math.abs(one.uvs![3]! - one.uvs![1]!);
    expect(Math.min(du, dv)).toBeLessThan(1e-5);
  });
  it('refuses a chart that only flattens onto a line (too few seams)', () => {
    const cube = editInput(boxMesh([200, 200, 200]));
    const one = meshEdges(cube.mesh, cube.topology).slice(0, 1);
    expect(() => unwrapMesh(cube, one)).toThrow(/mark more seams/);
    // Partly collapsed and folded (three seams meeting at corners 0 and 7): refused too.
    const three = [edgeKey(0, 2), edgeKey(0, 1), edgeKey(5, 7)];
    expect(() => unwrapMesh(cube, three)).toThrow(/mark more seams/);
  });
  it('packs more charts than a call takes arguments', () => {
    // A 370 × 370 grid with every edge a seam: 136,900 one-face charts.
    const g = editInput(grid(370));
    const out = unwrapMesh(g, meshEdges(g.mesh, g.topology));
    expect(inUnitSquare(out)).toBe(true);
  }, 60000);
});
