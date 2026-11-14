import { describe, expect, it } from 'vitest';
import { f80Package, f80Rules, f80Sample } from './car-look-fixtures';
import { compareCad } from './diff';
import { f11Bracket } from './fixtures';
import type { CadDocument } from './model';
import { applyCadOperation } from './operations';
import {
  defaultProportions,
  measureProportions,
  type CadProportionMesh,
  type CadProportions,
} from './proportions';
import { validateCad } from './validation';

const codes = (doc: unknown) => validateCad(doc).map((d) => `${d.code}@${d.path}`);
/** An axis-aligned box as a mesh: its 8 corners (bit 0 x, 1 y, 2 z) and 12 triangles. */
const box = (bodyId: string, min: number[], max: number[]): CadProportionMesh => ({
  bodyId,
  points: [0, 1, 2, 3, 4, 5, 6, 7].flatMap((i) => [
    i & 1 ? max[0]! : min[0]!,
    i & 2 ? max[1]! : min[1]!,
    i & 4 ? max[2]! : min[2]!,
  ]),
  indices: [
    [0, 1, 3, 0, 3, 2],
    [4, 5, 7, 4, 7, 6],
    [0, 1, 5, 0, 5, 4],
    [2, 3, 7, 2, 7, 6],
    [0, 2, 6, 0, 6, 4],
    [1, 3, 7, 1, 7, 5],
  ].flat(),
});
// A boxy car, front at +X: 4000 long, 1800 wide, 1200 high; wheels Ø600, 250 wide, axles at
// x 3000 and 600 (wheelbase 2400, front overhang 1000); belt at 800, glass 800–1200.
const car: CadProportionMesh[] = [
  box('fl', [2700, 650, 0], [3300, 900, 600]),
  box('fr', [2700, -900, 0], [3300, -650, 600]),
  box('rl', [300, 650, 0], [900, 900, 600]),
  box('rr', [300, -900, 0], [900, -650, 600]),
  // The body: 1800 wide over the front wheels (900 + 10), narrower behind.
  box('shell', [0, -910, 100], [4000, 910, 800]),
  // The glass leans in: 1700 wide at the belt, 1300 at the top.
  {
    bodyId: 'glass',
    points: [
      [1000, 850, 800],
      [1000, -850, 800],
      [2500, 850, 800],
      [2500, -850, 800],
      [1200, 650, 1200],
      [1200, -650, 1200],
      [2300, 650, 1200],
      [2300, -650, 1200],
    ].flat(),
  },
];
const setup: CadProportions = defaultProportions({
  frontWheels: ['fl', 'fr'],
  rearWheels: ['rl', 'rr'],
  body: ['shell'],
  windows: ['glass'],
});

// CLF3 (docs/cad/car-look-process.md, 比率の指標, CLF1〜CLF3の分け方). ST-503, TS-2008.
describe('proportion indicators (CLF3)', () => {
  it('measures each indicator from the roles and checks it against its band', () => {
    const got = Object.fromEntries(
      measureProportions(setup, car).map((m) => [m.metric, [m.value, m.status]]),
    );
    expect(got.wheelToHeight![0]).toBeCloseTo(600 / 1200, 9);
    expect(got.wheelToHeight![1]).toBe('ok');
    expect(got.wheelbaseToLength![0]).toBeCloseTo(2400 / 4000, 9);
    expect(got.wheelbaseToLength![1]).toBe('ok');
    expect(got.frontOverhangToWheelbase).toEqual([1000 / 2400, 'none']);
    expect(got.glassToBody![0]).toBeCloseTo(400 / 800, 9);
    expect(got.glassToBody![1]).toBe('outside');
    expect(got.widthToHeight![0]).toBeCloseTo(1820 / 1200, 9);
    expect(got.widthToHeight![1]).toBe('outside');
    // The body reaches 10 mm past every tyre.
    expect(got.wheelToFender![0]).toBeCloseTo(10, 9);
    expect(got.wheelToFender![1]).toBe('ok');
    // 200 mm in over 400 mm up on each side.
    expect(got.tumblehome![0]).toBeCloseTo((Math.atan2(200, 400) * 180) / Math.PI, 9);
  });

  it('measures the same car moved sideways, and nothing that needs a body not drawn', () => {
    // 2000 mm along Y: the sides are either side of the wheels' centre line (#1114 review).
    const moved = car.map((m) => ({
      ...m,
      points: Array.from(m.points, (v, i) => (i % 3 === 1 ? v + 2000 : v)),
    }));
    const at = (ms: CadProportionMesh[], metric: string) =>
      measureProportions(setup, ms).find((m) => m.metric === metric)!;
    expect(at(moved, 'wheelToFender').value).toBeCloseTo(10, 9);
    expect(at(moved, 'tumblehome').value).toBeCloseTo((Math.atan2(200, 400) * 180) / Math.PI, 9);
    // The glass not drawn (failed): the car's height and width are not the rest's (#1114 review).
    const noGlass = car.filter((m) => m.bodyId !== 'glass');
    for (const metric of ['wheelToHeight', 'widthToHeight', 'wheelbaseToLength', 'glassToBody'])
      expect(at(noGlass, metric)).toEqual({ metric, status: 'none' });
    // The wheels and the body are all there: the fender still measures.
    expect(at(noGlass, 'wheelToFender').value).toBeCloseTo(10, 9);
  });

  it('reads the front from where the front wheels are, and leaves out what it cannot measure', () => {
    // The same car facing −X: front and rear wheels swapped.
    const back = { ...setup, frontWheels: ['rl', 'rr'], rearWheels: ['fl', 'fr'] };
    const overhang = measureProportions(back, car).find(
      (m) => m.metric === 'frontOverhangToWheelbase',
    );
    expect(overhang?.value).toBeCloseTo(600 / 2400, 9);
    // No windows, no glass measures; the ground raised past the top, no height.
    const bare = measureProportions({ ...setup, windows: [], groundMm: 2000 }, car);
    for (const m of bare.filter((x) =>
      ['glassToBody', 'tumblehome', 'wheelToHeight', 'widthToHeight'].includes(x.metric),
    ))
      expect(m).toEqual({ metric: m.metric, status: 'none' });
  });

  it('stores the setup in the document: validated, undone by removing it, pruned with a body', () => {
    const doc = f11Bracket();
    const id = doc.bodies[0]!.id;
    const p = defaultProportions({ body: [id] });
    const set = applyCadOperation(doc, { type: 'setProportions', proportions: p });
    expect(set.proportions).toEqual(p);
    expect(codes(set)).toEqual([]);
    expect(compareCad(doc, set).map((c) => c.path)).toEqual(['proportions']);
    expect(() => applyCadOperation(set, { type: 'setProportions', proportions: p })).toThrow(
      'proportions-unchanged',
    );
    expect(
      applyCadOperation(set, { type: 'setProportions', proportions: null }).proportions,
    ).toBeUndefined();
    const gone = applyCadOperation(set, { type: 'deleteClosure', ids: [id], cascade: true });
    expect(gone.proportions?.body).toEqual([]);
    expect(gone.proportions?.targets).toEqual(p.targets);
  });

  it('refuses a setup with unknown bodies, a body twice, a bad ground or bad bands', () => {
    const doc = f11Bracket();
    const id = doc.bodies[0]!.id;
    const at = '$.proportions';
    const withP = (p: unknown) => ({ ...doc, proportions: p }) as unknown as CadDocument;
    const base = defaultProportions({ body: [id] });
    expect(codes(withP({ ...base, windows: ['ghost'] }))).toEqual([
      `proportions-body@${at}.windows[0]`,
    ]);
    expect(codes(withP({ ...base, frontWheels: [id] }))).toEqual([
      `proportions-body-twice@${at}.body[0]`,
    ]);
    expect(codes(withP({ ...base, groundMm: 2e7 }))).toEqual([`proportions-ground@${at}.groundMm`]);
    expect(codes(withP({ ...base, targets: [{ metric: 'beauty', min: 1 }] }))).toEqual([
      `proportions-metric@${at}.targets[0].metric`,
    ]);
    expect(
      codes(
        withP({
          ...base,
          targets: [
            { metric: 'wheelToHeight', min: 0.6, max: 0.5 },
            { metric: 'wheelToHeight', min: 0.5 },
            { metric: 'tumblehome' },
          ],
        }),
      ),
    ).toEqual([
      `proportions-band@${at}.targets[0].max`,
      `proportions-metric-twice@${at}.targets[1].metric`,
      `proportions-band@${at}.targets[2]`,
    ]);
    const { groundMm: _, ...noGround } = base;
    expect(codes(withP(noGround))).toEqual([`missing-field@${at}.groundMm`]);
  });

  it('F80: the CL1 package validates, its proportions inside the plan’s first bands', () => {
    const doc = f80Package();
    expect(codes(doc)).toEqual([]);
    expect(doc.bodies.map((b) => b.id)).toEqual([
      'front-left-body',
      'front-right-body',
      'rear-left-body',
      'rear-right-body',
      'shell-body',
      'glass-body',
    ]);
    // What the boxes and the wheels give, by hand (the e2e reads the same from the meshes).
    const r = f80Rules;
    expect(r.tyre.rear.diameter / r.height).toBeGreaterThan(0.5);
    expect(r.wheelbase / r.length).toBeCloseTo(0.609, 3);
    expect(r.width / r.height).toBeGreaterThan(1.6);
    expect(r.width / 2 - (r.track.front + r.tyre.front.width) / 2).toBe(12.5);
  });

  it('F80 sample (CLF-s): the roof curves sit over the glass, the network validates', () => {
    const doc = f80Sample();
    expect(codes(doc)).toEqual([]);
    expect(doc.sketches.map((s) => s.id)).toEqual(
      ['u0', 'u1', 'u2', 'v0', 'v1', 'v2', 'plan'].map((id) => `roof-${id}`),
    );
    // The middle side arc's ends at the glass's front and back, near the belt; its plane at y 0.
    const u1 = doc.sketches.find((s) => s.id === 'roof-u1')!;
    const plane = u1.plane as { origin: { literalMm: number }[] };
    const [x, y] = plane.origin.map((c) => c.literalMm);
    expect(y).toBeCloseTo(0, 9);
    expect(u1.solved.a![0] + x!).toBeCloseTo(750, 9);
    expect(u1.solved.b![0] + x!).toBeCloseTo(2150, 9);
    const net = f80Sample(undefined, true);
    expect(codes(net)).toEqual([]);
    expect(net.bodies.map((b) => b.id).at(-1)).toBe('roof-body');
  });
});
