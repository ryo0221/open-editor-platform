import { describe, expect, it } from 'vitest';
import { boneHeatWeights, boneWeightsOf, MeshEditError, paintWeights, type EpmMesh } from './index';

/** A closed tube along z: `rings` rings of 8 vertices from z = 0 to 1000, capped. */
function tube(rings = 11): EpmMesh {
  const pos: number[] = [];
  for (let r = 0; r < rings; r++)
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * 2 * Math.PI;
      pos.push(100 * Math.cos(a), 100 * Math.sin(a), (1000 * r) / (rings - 1));
    }
  const faces: number[] = [];
  const sizes: number[] = [];
  for (let r = 0; r + 1 < rings; r++)
    for (let k = 0; k < 8; k++) {
      const a = r * 8 + k,
        b = r * 8 + ((k + 1) % 8);
      faces.push(a, b, b + 8, a + 8);
      sizes.push(4);
    }
  faces.push(...[7, 6, 5, 4, 3, 2, 1, 0]);
  sizes.push(8);
  faces.push(...[0, 1, 2, 3, 4, 5, 6, 7].map((k) => (rings - 1) * 8 + k));
  sizes.push(8);
  return {
    positions: Float32Array.from(pos),
    faceSizes: Uint32Array.from(sizes),
    faceIndices: Uint32Array.from(faces),
    faceMaterials: new Uint16Array(sizes.length),
    boneIds: [],
    morphs: [],
  };
}
const weightOf = (m: EpmMesh, v: number, bone: number) => {
  const w = m.weights!;
  for (let k = w.offsets[v]!; k < w.offsets[v + 1]!; k++)
    if (w.bones[k] === bone) return w.values[k]!;
  return 0;
};

describe('bone heat weights (C5b, TS-1248)', () => {
  const bones = [
    { head: [0, 0, 0] as [number, number, number], tail: [0, 0, 500] as [number, number, number] },
    {
      head: [0, 0, 500] as [number, number, number],
      tail: [0, 0, 1000] as [number, number, number],
    },
  ];
  it('weights each end to its bone and blends smoothly across the joint', () => {
    const out = boneHeatWeights(tube(), bones, ['lower', 'upper']);
    expect(out.boneIds).toEqual(['lower', 'upper']);
    const n = out.positions.length / 3;
    for (let v = 0; v < n; v++) {
      const w = out.weights!;
      let s = 0;
      for (let k = w.offsets[v]!; k < w.offsets[v + 1]!; k++) s += w.values[k]!;
      expect(s).toBeCloseTo(1, 5);
      expect(w.offsets[v + 1]! - w.offsets[v]!).toBeLessThanOrEqual(4);
    }
    // Ring 0 (z = 0) is the lower bone's, ring 10 (z = 1000) the upper's, ring 5 shared.
    expect(weightOf(out, 0, 0)).toBeGreaterThan(0.9);
    expect(weightOf(out, 80, 1)).toBeGreaterThan(0.9);
    expect(weightOf(out, 40, 0)).toBeGreaterThan(0.3);
    expect(weightOf(out, 40, 1)).toBeGreaterThan(0.3);
    // The upper bone's weight rises ring by ring.
    const rise = [...Array(11).keys()].map((r) => weightOf(out, r * 8, 1));
    for (let r = 1; r < 11; r++) expect(rise[r]!).toBeGreaterThanOrEqual(rise[r - 1]! - 1e-6);
  });
  it('times its phases only when asked, with the same result (C5e, TS-1260)', () => {
    const phases: string[] = [];
    const timed = boneHeatWeights(tube(), bones, ['lower', 'upper'], undefined, (p, ms) => {
      expect(ms).toBeGreaterThanOrEqual(0);
      phases.push(p);
    });
    expect(phases).toEqual(['nearest', 'laplacian', 'solve', 'normalize']);
    const plain = boneHeatWeights(tube(), bones, ['lower', 'upper']);
    expect([...timed.weights!.values]).toEqual([...plain.weights!.values]);
    expect([...timed.weights!.bones]).toEqual([...plain.weights!.bones]);
  });
  it('solves the low-heat vertices too when a vertex lies on a bone', () => {
    const tri: EpmMesh = {
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0.25, 1, 0]),
      faceSizes: Uint32Array.from([3]),
      faceIndices: Uint32Array.from([0, 1, 2]),
      faceMaterials: new Uint16Array(1),
      boneIds: [],
      morphs: [],
    };
    const out = boneHeatWeights(
      tri,
      [
        { head: [0, 0, 0], tail: [0, 0, 0] },
        { head: [1, 0, 0], tail: [1, 0, 0] },
      ],
      ['a', 'b'],
    );
    // Not a hard nearest-bone assignment: the solved system shares the third vertex.
    expect(weightOf(out, 2, 0)).toBeGreaterThan(0.6);
    expect(weightOf(out, 2, 0)).toBeLessThan(0.95);
    // Moved far from the origin together with its bones, it weighs the same.
    const far = 1_000_000;
    const moved = boneHeatWeights(
      { ...tri, positions: tri.positions.map((x, i) => (i % 3 === 0 ? x + far : x)) },
      [
        { head: [far, 0, 0], tail: [far, 0, 0] },
        { head: [far + 1, 0, 0], tail: [far + 1, 0, 0] },
      ],
      ['a', 'b'],
    );
    for (let v = 0; v < 3; v++) expect(weightOf(moved, v, 0)).toBeCloseTo(weightOf(out, v, 0), 4);
  });
  it('gives a loose vertex tied between many bones at most four', () => {
    const m = tube(3);
    const loose: EpmMesh = { ...m, positions: Float32Array.from([...m.positions, 0, 0, 5000]) };
    const ring = [...Array(9).keys()].map((k) => {
      const a = (k / 9) * 2 * Math.PI;
      const h: [number, number, number] = [1000 * Math.cos(a), 1000 * Math.sin(a), 5000];
      return { head: h, tail: h };
    });
    const out = boneHeatWeights(
      loose,
      ring,
      ring.map((_, k) => `b${k}`),
    );
    const v = loose.positions.length / 3 - 1;
    expect(out.weights!.offsets[v + 1]! - out.weights!.offsets[v]!).toBe(4);
  });
  it('refuses no bones and a bone that is not finite', () => {
    expect(() => boneHeatWeights(tube(), [], [])).toThrow(MeshEditError);
    expect(() =>
      boneHeatWeights(tube(), [{ head: [0, 0, Number.NaN], tail: [0, 0, 1] }], ['x']),
    ).toThrow(MeshEditError);
  });
});

describe('weight paint (C5c, TS-1251)', () => {
  const bones = [
    { head: [0, 0, 0] as [number, number, number], tail: [0, 0, 500] as [number, number, number] },
    {
      head: [0, 0, 500] as [number, number, number],
      tail: [0, 0, 1000] as [number, number, number],
    },
  ];
  const bound = () => boneHeatWeights(tube(), bones, ['lower', 'upper']);
  const sums = (m: EpmMesh) => {
    const w = m.weights!;
    return [...Array(m.positions.length / 3).keys()].map((v) => {
      let s = 0;
      for (let k = w.offsets[v]!; k < w.offsets[v + 1]!; k++) s += w.values[k]!;
      return s;
    });
  };
  it('adds and subtracts toward 1 and 0, keeping every vertex at a sum of 1', () => {
    const m = bound();
    const before = boneWeightsOf(m, 'upper')[40]!;
    const add = paintWeights(m, 'upper', new Map([[40, 0.5]]), 'add');
    const after = boneWeightsOf(add, 'upper')[40]!;
    expect(after).toBeCloseTo(before + 0.5 * (1 - before), 5);
    const sub = paintWeights(add, 'upper', new Map([[40, 1]]), 'subtract');
    expect(boneWeightsOf(sub, 'upper')[40]).toBe(0);
    expect(boneWeightsOf(sub, 'lower')[40]).toBeCloseTo(1, 5);
    for (const s of [...sums(add), ...sums(sub)]) expect(s).toBeCloseTo(1, 5);
    // Untouched vertices keep their weights.
    expect(boneWeightsOf(sub, 'upper')[48]).toBeCloseTo(boneWeightsOf(m, 'upper')[48]!, 6);
  });
  it('paints a new bone in, smooths toward the neighbours, and drops a bone no vertex weights', () => {
    const m = bound();
    const tip = paintWeights(m, 'tip', new Map([[80, 1]]), 'add');
    expect(tip.boneIds).toContain('tip');
    expect(boneWeightsOf(tip, 'tip')[80]).toBeCloseTo(1, 5);
    // Smoothing the tip vertex pulls it toward its neighbours (which have no tip weight).
    const smooth = paintWeights(tip, 'tip', new Map([[80, 0.5]]), 'smooth');
    expect(boneWeightsOf(smooth, 'tip')[80]).toBeLessThan(1);
    expect(boneWeightsOf(smooth, 'tip')[80]).toBeGreaterThan(0.4);
    // Removing every bit of the tip bone takes it out of the mesh's bones again.
    const half = paintWeights(m, 'tip', new Map([[80, 0.5]]), 'add');
    const gone = paintWeights(half, 'tip', new Map([[80, 1]]), 'subtract');
    expect(gone.boneIds).not.toContain('tip');
    for (const s of sums(gone)) expect(s).toBeCloseTo(1, 5);
  });
  it('leaves weights alone where smoothing or subtracting has nothing to work with', () => {
    const m = tube();
    const n = m.positions.length / 3;
    // Only vertex 40 is weighted, half to each bone (an import may leave the rest unweighted).
    const offsets = Uint32Array.from({ length: n + 1 }, (_, k) => (k <= 40 ? 0 : 2));
    const lone: EpmMesh = {
      ...m,
      boneIds: ['lower', 'upper'],
      weights: { offsets, bones: Uint16Array.from([0, 1]), values: Float32Array.from([0.5, 0.5]) },
    };
    // Subtracting where there is no weight leaves the vertex unweighted.
    const sub = paintWeights(lone, 'upper', new Map([[0, 0.5]]), 'subtract');
    expect(sub.weights!.offsets[1]! - sub.weights!.offsets[0]!).toBe(0);
    const out = paintWeights(lone, 'upper', new Map([[40, 1]]), 'smooth');
    expect(boneWeightsOf(out, 'lower')[40]).toBeCloseTo(0.5, 5);
    expect(boneWeightsOf(out, 'upper')[40]).toBeCloseTo(0.5, 5);
  });
  it("leaves a vertex's only bone at 1 and refuses a mesh without weights", () => {
    const m = bound();
    // Painted fully, vertex 0 is all the lower bone's: subtracting it there changes nothing.
    const all = paintWeights(m, 'lower', new Map([[0, 1]]), 'add');
    expect(boneWeightsOf(all, 'lower')[0]).toBe(1);
    const one = paintWeights(all, 'lower', new Map([[0, 1]]), 'subtract');
    expect(boneWeightsOf(one, 'lower')[0]).toBe(1);
    expect(sums(one)[0]).toBeCloseTo(1, 5);
    expect(() => paintWeights(tube(), 'lower', new Map([[0, 1]]), 'add')).toThrow(MeshEditError);
    // A sole weight saved just under 1 is still the vertex's only bone.
    const w = all.weights!;
    const values = w.values.slice();
    values[w.offsets[0]!] = 0.9999;
    const near = paintWeights(
      { ...all, weights: { ...w, values } },
      'lower',
      new Map([[0, 1]]),
      'subtract',
    );
    expect(boneWeightsOf(near, 'lower')[0]).toBeGreaterThan(0.99);
  });
});
