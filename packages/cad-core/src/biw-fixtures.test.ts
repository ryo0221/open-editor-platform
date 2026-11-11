import { describe, expect, it } from 'vitest';
import { f29Biw, f29Defaults, f29FrontKick, f29RearKick, f29Groups } from './biw-fixtures';
import { cadLimits, type CadFeature } from './model';
import { cadSketchLimits } from './sketch';
import { validateCad } from './validation';

const codes = (doc: unknown) => validateCad(doc).map((d) => `${d.code}@${d.path}`);

describe('F29 simplified BIW (CR4g)', () => {
  it('is the plan’s 40 bodies and the front extensions within the feature and sketch limits', () => {
    // TS-1550, ST-266: the「B2の簡略BIW」table's groups, counted.
    const doc = f29Biw();
    expect(codes(doc)).toEqual([]);
    const active = doc.bodies.filter((b) => b.state === 'active');
    expect(active).toHaveLength(42);
    expect(active.length).toBeLessThanOrEqual(cadLimits.bodies);
    expect(
      Object.fromEntries(Object.entries(f29Groups).map(([g, ids]) => [g, ids.length])),
    ).toEqual({ floor: 3, roof: 3, side: 12, front: 11, rear: 6, cross: 3, mount: 4 });
    expect(Object.values(f29Groups).flat().sort()).toEqual(active.map((b) => b.id).sort());
    // 108 features (a body's source and placement, each trim or flange and its placement; CR5f's
    // four join flanges add 8, CR5f-7's front extensions 4, CR5f-9's apron lower flange 2) and 16
    // sketches, well inside 256 and 256.
    expect(doc.features).toHaveLength(108);
    expect(doc.sketches).toHaveLength(16);
    expect(doc.features.length).toBeLessThanOrEqual(cadLimits.features);
    expect(doc.sketches.length).toBeLessThanOrEqual(cadSketchLimits.sketches);
    // Every right part is a mirrorCopy of its left part's result in y = 0, with no sketch of its
    // own; the left part's details (the side outer's trim and flange) carry over.
    const byId = new Map(doc.features.map((f) => [f.id, f]));
    const rights = active.filter((b) => b.id.endsWith('-r'));
    expect(rights).toHaveLength(16);
    for (const r of rights) {
      const left = active.find((b) => b.id === r.id.slice(0, -2))!;
      const copy = byId.get(`${r.id}-copy`) as Extract<CadFeature, { type: 'mirrorCopy' }>;
      expect(copy.type).toBe('mirrorCopy');
      expect(copy.args.source.featureId).toBe(left.resultFeatureId);
      expect(copy.args.plane.normal).toEqual([0, 1, 0]);
      expect(byId.get(r.resultFeatureId)?.inputFeatureIds).toEqual([copy.id]);
      expect(r.kind).toBe(left.kind);
    }
    expect(active.find((b) => b.id === 'side')!.resultFeatureId).toBe('side-roof-flange-placement');
    // Four solid mounts (cylinders and boxes), the rest sheets.
    const solids = active.filter((b) => b.kind === 'solid');
    expect(solids.map((b) => b.id).sort()).toEqual([
      'rear-mount',
      'rear-mount-r',
      'strut-mount',
      'strut-mount-r',
    ]);
    // 68 spot weld rows (both sides of each joint; CR5f's 14 join the front and rear structures to
    // the cabin, CR5f-4's 6 the rear side members' runs under the floor, CR5f-7's 4 the front
    // extensions), all at the default pitch.
    expect(doc.spotWelds).toHaveLength(68);
    expect(new Set(doc.spotWelds!.map((w) => w.pitchMm))).toEqual(new Set([f29Defaults.pitchMm]));
  });

  it('joins every sheet into one piece by its weld rows (CR5f)', () => {
    // TS-1585, ST-275: the front structure (side member and closure, strut tower, apron,
    // radiator support) and the rear (side member and closure, wheelhouse) are welded to the
    // cabin, so the sheets are one piece; only the solid mounts are left, for contact bonds.
    const doc = f29Biw();
    const parent = new Map(doc.bodies.map((b) => [b.id, b.id]));
    const root = (id: string): string => (parent.get(id) === id ? id : root(parent.get(id)!));
    for (const w of doc.spotWelds!)
      parent.set(root(w.flanges[0].bodyId), root(w.flanges[1].bodyId));
    const pieces = new Map<string, string[]>();
    for (const b of doc.bodies) pieces.set(root(b.id), [...(pieces.get(root(b.id)) ?? []), b.id]);
    const sorted = [...pieces.values()].sort((a, b) => b.length - a.length);
    expect(sorted[0]).toHaveLength(38);
    expect(sorted.slice(1).flat().sort()).toEqual(f29Groups.mount.slice().sort());
    // The new rows: each side's closure on the dash and the radiator support, the tower's two
    // ends on the apron, the apron on the dash, the rear member on the trunk floor, the
    // wheelhouse on the side outer; then (CR5f-4) the rear member's run under the floor on its
    // closure and on the floor pan; (CR5f-7) the front extension on the closure and the floor.
    const joins = doc.spotWelds!.slice(44).map((w) => w.flanges.map((f) => f.bodyId).join('→'));
    expect(joins.filter((j) => !j.includes('-r'))).toEqual([
      'front-closure→dash',
      'front-closure→radiator',
      'tower→apron',
      'tower→apron',
      'apron→dash',
      'rear-member→trunk',
      'wheelhouse→side',
      'rear-member→rear-closure',
      'rear-member→rear-closure',
      'rear-member→floor',
      'front-extension→front-closure',
      'front-extension→floor',
    ]);
    expect(joins).toHaveLength(24);
  });

  it('runs the rear side member down under the trunk floor’s kick and on under the floor (CR5f-4)', () => {
    // TS-1586, ST-276: the path's elements meet end to end and turn smoothly (two bends of
    // R 200 round a 30° run), dropping 100 mm to end under the floor pan at x 1260; the run
    // under the floor is welded to its closure and to the floor on both sides.
    const doc = f29Biw();
    const s = doc.sketches.find((k) => k.id === 'rear-member-line')!;
    const p = (id: string) => s.solved[id]!;
    expect(p('p0')).toEqual([250, f29RearKick.z]);
    expect(p('p5')).toEqual([f29RearKick.frontX, f29RearKick.z - f29RearKick.drop]);
    expect(p('p4')[0]).toBe(f29RearKick.endX);
    const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    for (const [c, a, b] of [
      ['c0', 'p1', 'p2'],
      ['c1', 'p3', 'p4'],
    ] as const) {
      expect(dist(p(c), p(a))).toBeCloseTo(f29RearKick.radius, 9);
      expect(dist(p(c), p(b))).toBeCloseTo(f29RearKick.radius, 9);
    }
    // The run leaves the first bend and meets the second along their tangents (30° down).
    const run = [p('p3')[0] - p('p2')[0], p('p3')[1] - p('p2')[1]];
    expect((Math.atan2(-run[1]!, run[0]!) * 180) / Math.PI).toBeCloseTo(f29RearKick.angleDeg, 9);
    const r0 = [p('p2')[0] - p('c0')[0], p('p2')[1] - p('c0')[1]];
    expect(run[0]! * r0[0]! + run[1]! * r0[1]!).toBeCloseTo(0, 6);
    // Sharp corners (CR5f-5): an R 3 corner on the run is refused by the Host's shell expansion.
    for (const id of ['rear-member-sweep', 'rear-closure-sweep']) {
      const f = doc.features.find((g) => g.id === id) as Extract<
        CadFeature,
        { type: 'profileSweep' }
      >;
      expect(f.args.profile.radius, id).toEqual({ literalMm: 0 });
      expect(f.args.up, id).toBe('inPlane');
    }
    // Before the kick the member's top (z + 60) lies under the trunk floor, with the mount on it.
    expect(p('p1')[0]).toBeGreaterThan(560);
    const rows = doc.spotWelds!.filter(
      (w) => w.id.includes('rear-member-run') || w.id.includes('rear-member-floor'),
    );
    expect(rows.map((w) => w.flanges.map((f) => f.bodyId).join('→')).sort()).toEqual([
      'rear-member-r→floor',
      'rear-member-r→rear-closure-r',
      'rear-member-r→rear-closure-r',
      'rear-member→floor',
      'rear-member→rear-closure',
      'rear-member→rear-closure',
    ]);
  });

  it('takes the side outer’s roof flange width and the rows’ pitch', () => {
    // TS-1550, ST-266.
    const doc = f29Biw({ flangeMm: 100, pitchMm: 60 });
    expect(codes(doc)).toEqual([]);
    const flange = doc.features.find((f) => f.id === 'side-roof-flange') as Extract<
      CadFeature,
      { type: 'flange' }
    >;
    expect(flange.args.width).toEqual({ literalMm: 100 });
    expect(new Set(doc.spotWelds!.map((w) => w.pitchMm))).toEqual(new Set([60]));
  });
  it('runs the front side member’s extension under the toe board to the front cross member (CR5f-7)', () => {
    // TS-1588, ST-278: from under the closure (top z 450) at x 3400 the extension's path bends
    // down R 100, runs at 60° and bends back to run under the floor pan (top z 250) to the front
    // cross member's front wall at x 2740; its elements meet end to end and turn smoothly.
    const doc = f29Biw();
    const k = f29FrontKick;
    const s = doc.sketches.find((x) => x.id === 'front-extension-line')!;
    const p = (id: string) => s.solved[id]!;
    expect(p('p0')).toEqual([k.rearX, k.z]);
    expect(p('p1')).toEqual([k.endX, k.z]);
    expect(p('p5')).toEqual([k.frontX, k.z + k.rise]);
    expect(p('p4')[1]).toBe(k.z + k.rise);
    const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    for (const [c, a, b] of [
      ['c0', 'p1', 'p2'],
      ['c1', 'p3', 'p4'],
    ] as const) {
      expect(dist(p(c), p(a))).toBeCloseTo(k.radius, 9);
      expect(dist(p(c), p(b))).toBeCloseTo(k.radius, 9);
    }
    const run = [p('p3')[0] - p('p2')[0], p('p3')[1] - p('p2')[1]];
    expect((Math.atan2(run[1]!, run[0]!) * 180) / Math.PI).toBeCloseTo(k.angleDeg, 9);
    // Under the toe board: the hat's top (60 above the path) stays under the floor's end
    // (x 2900, z 250) and the toe board up to the dash wall (x 2950, z 450).
    expect(p('p2')[0]).toBeGreaterThan(2950);
    expect(p('p2')[1] + 60).toBeLessThan(450);
    const sweep = doc.features.find((f) => f.id === 'front-extension-sweep')!;
    expect(sweep.type === 'profileSweep' && sweep.args.up).toBe('inPlane');
    expect(sweep.type === 'profileSweep' && sweep.args.profile.radius).toEqual({ literalMm: 0 });
  });
});
