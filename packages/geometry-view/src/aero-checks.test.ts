import { BoxGeometry, CylinderGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import {
  aeroColor,
  aeroColors,
  diffuserAngle,
  flowIncidence,
  flowLeaves,
  flowLeavesOf,
  frontalArea,
  outwardFrom,
  incidenceSummary,
} from './aero-checks';
import type { PartCheckMesh } from './part-checks';

const meshOf = (g: BoxGeometry | CylinderGeometry, origin: [number, number, number] = [0, 0, 0]) =>
  ({
    origin,
    positions: g.getAttribute('position').array as Float32Array,
    normals: g.getAttribute('normal').array as Float32Array,
    indices: Uint32Array.from(g.getIndex()!.array),
  }) satisfies PartCheckMesh;

describe('aero indicators on the display mesh (CLF4, CL7b, TS-2028, ST-517)', () => {
  // A block 1 m long, 400 mm wide and 200 mm high, the air moving toward +X.
  const block = meshOf(new BoxGeometry(1000, 400, 200, 10, 4, 2), [2000, 0, 300]);

  it('reads the incidence to the flow: the nose faces it, the roof runs along, the tail looks away', () => {
    const inc = flowIncidence(block, 1);
    const summary = incidenceSummary(block, inc, 15);
    expect(summary.facing).toBeCloseTo(400 * 200, 3);
    expect(summary.away).toBeCloseTo(400 * 200, 3);
    expect(summary.along).toBeCloseTo(2 * (1000 * 400 + 1000 * 200), 3);
    // The other way round, nose and tail swap.
    const back = flowIncidence(block, -1);
    expect(Math.max(...back)).toBeCloseTo(90, 3);
    expect(Math.min(...back)).toBeCloseTo(-90, 3);
    expect(aeroColor(30, false, 15)).toEqual([...aeroColors.facing]);
    expect(aeroColor(-10, false, 15)).toEqual([...aeroColors.along]);
    expect(aeroColor(-20, false, 15)).toEqual([...aeroColors.away]);
    expect(aeroColor(0, true, 15)).toEqual([...aeroColors.leaves]);
    expect(aeroColor(NaN, false, 15)).toEqual([...aeroColors.none]);
  });

  it('warns at the tail’s convex edges, not at the nose’s', () => {
    const inc = flowIncidence(block, 1);
    const { spots } = flowLeaves(block, inc, 1, 100);
    expect(spots.length).toBeGreaterThan(0);
    for (const s of spots) {
      expect(s.kind).toBe('edge');
      expect(s.x[0]).toBeCloseTo(2500, 3);
    }
  });

  it('warns at a bend away from the flow tighter than the radius, not at a gentler one', () => {
    // A cylinder of 50 mm radius lying across the flow (its axis along Y), 128 segments round.
    const tube = meshOf(new CylinderGeometry(50, 50, 400, 128, 1, true));
    const inc = flowIncidence(tube, 1);
    const tight = flowLeaves(tube, inc, 1, 100).spots.filter((s) => s.kind === 'bend');
    expect(tight.length).toBe(1);
    // Downstream of the top and bottom, where the surface turns away.
    expect(tight[0]!.x[0]).toBeGreaterThanOrEqual(0);
    expect(tight[0]!.x[1]).toBeLessThanOrEqual(50.001);
    expect(flowLeaves(tube, inc, 1, 20).spots.filter((s) => s.kind === 'bend')).toEqual([]);
  });

  it('measures the frontal area of the union of the bodies', () => {
    const area = frontalArea([block])!;
    expect(area.mm2).toBeCloseTo(400 * 200, 0);
    expect(area.y).toEqual([-200, 200]);
    expect(area.z).toEqual([200, 400]);
    // A second block behind the first, as wide and half as high: the union stays the same.
    const behind = meshOf(new BoxGeometry(500, 400, 100), [3000, 0, 250]);
    expect(frontalArea([block, behind])!.mm2).toBeCloseTo(400 * 200, 0);
    // Raised clear of it: its own area adds.
    const above = meshOf(new BoxGeometry(500, 400, 100), [3000, 0, 500]);
    expect(frontalArea([block, above])!.mm2).toBeCloseTo(400 * 300, 0);
    expect(frontalArea([])).toBeUndefined();
  });

  it('reads the underside’s rise toward the tail as the diffuser’s angle', () => {
    const g = new BoxGeometry(800, 400, 50, 8, 4, 1);
    // Tilted so its underside rises 10° toward +X.
    g.rotateY((-10 * Math.PI) / 180);
    const ramp = meshOf(g, [3000, 0, 200]);
    const d = diffuserAngle(ramp, 1)!;
    expect(d.meanDeg).toBeCloseTo(10, 3);
    expect(d.maxDeg).toBeCloseTo(10, 3);
    expect(d.mm2).toBeCloseTo(800 * 400, 0);
    expect(d.x[0]).toBeGreaterThan(2500);
    // With the flow the other way it falls toward the tail: no diffuser.
    expect(diffuserAngle(ramp, -1)).toBeUndefined();
    expect(diffuserAngle(block, 1)).toBeUndefined();
  });

  it("finds the tail's edge between two bodies, and turns a sheet's normals outward", () => {
    // The block's tail face (+X, BoxGeometry's first group) as a body of its own.
    const g = new BoxGeometry(1000, 400, 200, 10, 4, 2);
    const tail = g.groups[0]!;
    const all = Uint32Array.from(g.getIndex()!.array);
    const part = (keep: (t: number) => boolean) => ({
      ...meshOf(g, [2000, 0, 300]),
      indices: all.filter((_, i) => keep(i)),
    });
    const inTail = (i: number) => i >= tail.start && i < tail.start + tail.count;
    const body = part((i) => !inTail(i));
    const cap = part(inTail);
    const inc = [flowIncidence(body, 1), flowIncidence(cap, 1)];
    const [onBody, onCap] = flowLeavesOf([body, cap], inc, 1, 100);
    expect(onBody!.spots).toEqual([]);
    expect(onCap!.spots.map((s) => s.kind)).toEqual(['edge']);
    expect(onCap!.spots[0]!.x[0]).toBeCloseTo(2500, 3);
    // The cap as a sheet with its normals turned in: they are turned back out from the middle.
    const flipped = { ...cap, normals: cap.normals.map((x) => -x) };
    const out = outwardFrom(flipped, [2000, 0, 300]);
    expect(
      Math.min(...flowIncidence(out, 1).filter((_, v) => cap.indices.includes(v))),
    ).toBeCloseTo(-90, 3);
    expect(outwardFrom(cap, [2000, 0, 300])).toBe(cap);
  });

  it('finds the same edges on a small part far from the origin', () => {
    const near = meshOf(new BoxGeometry(0.2, 0.2, 0.2));
    const far = meshOf(new BoxGeometry(0.2, 0.2, 0.2), [9e6, 9e6, 9e6]);
    const count = (m: PartCheckMesh) =>
      flowLeaves(m, flowIncidence(m, 1), 1, 100).flags.reduce((n, f) => n + f, 0);
    expect(count(near)).toBeGreaterThan(0);
    expect(count(far)).toBe(count(near));
  });
});
