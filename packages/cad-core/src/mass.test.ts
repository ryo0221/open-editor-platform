import { describe, expect, it } from 'vitest';
import { fixtureComponent, fixturePart, fixtureVersion } from './assembly-fixtures';
import type { CadBodyEvaluation } from './coordinator';
import { f02Plate, f12Holes, f18Hood, f25B1Car, fixtureKernel } from './fixtures';
import { axleSplit, cadMass, componentCentre } from './mass';
import { emptyCad, mm, type CadDocument } from './model';
import { applyCadOperation } from './operations';
import { validateCad } from './validation';

const codes = (doc: unknown) => validateCad(doc).map((d) => `${d.code}@${d.path}`);
const steel = { densityKgM3: 7850, material: 'steel' };
const solidEval = (volumeMm3: number, centroidMm: [number, number, number]): CadBodyEvaluation => ({
  kind: 'solid',
  volumeMm3,
  areaMm2: 0,
  bounds: [
    [0, 0, 0],
    [1, 1, 1],
  ],
  centroidMm,
});

describe('mass and centre of mass (CR7a, TS-1807)', () => {
  it('sets a body’s density and refuses one out of range, or a thickness on a solid', () => {
    const plate = f02Plate();
    const id = plate.bodies[0]!.id;
    const weighed = applyCadOperation(plate, { type: 'setBodyMass', bodyId: id, mass: steel });
    expect(weighed.bodies[0]!.mass).toEqual(steel);
    expect(codes(weighed)).toEqual([]);
    expect(() =>
      applyCadOperation(weighed, { type: 'setBodyMass', bodyId: id, mass: steel }),
    ).toThrow('mass-unchanged');
    expect(
      applyCadOperation(weighed, { type: 'setBodyMass', bodyId: id, mass: null }).bodies[0],
    ).not.toHaveProperty('mass');
    const bad = (mass: unknown) => {
      const doc = structuredClone(weighed) as unknown as { bodies: { mass: unknown }[] };
      doc.bodies[0]!.mass = mass;
      return codes(doc);
    };
    expect(bad({ densityKgM3: 5 })).toEqual(['mass-density@$.bodies[0].mass.densityKgM3']);
    expect(bad({ densityKgM3: 7850, thicknessMm: 1 })).toEqual([
      'mass-thickness-solid@$.bodies[0].mass.thicknessMm',
    ]);
    expect(bad({ densityKgM3: 7850, material: 'unobtainium' })).toEqual([
      'mass-material@$.bodies[0].mass.material',
    ]);
    // A sheet takes a thickness, in range.
    const skin = f25B1Car();
    const i = skin.bodies.findIndex((b) => b.kind === 'sheet' && b.state === 'active');
    const sheet = structuredClone(skin) as unknown as { bodies: { mass: unknown }[] };
    sheet.bodies[i]!.mass = { densityKgM3: 7850, thicknessMm: 0.7 };
    expect(codes(sheet)).toEqual([]);
    sheet.bodies[i]!.mass = { densityKgM3: 7850, thicknessMm: 30 };
    expect(codes(sheet)).toEqual([`mass-thickness@$.bodies[${i}].mass.thicknessMm`]);
  });

  it('adds up placed parts at their poses, nested ones included, and splits front and rear', () => {
    const plate = applyCadOperation(f02Plate(), {
      type: 'setBodyMass',
      bodyId: f02Plate().bodies[0]!.id,
      mass: steel,
    });
    const bare = f02Plate();
    const pv = fixtureVersion('plate', 'v1', plate);
    const bv = fixtureVersion('bare', 'v1', bare);
    let pair = emptyCad(fixtureKernel);
    pair = applyCadOperation(pair, {
      type: 'insertComponents',
      parts: [fixturePart('p', 'Plate', pv)],
      components: [fixtureComponent('a', 'p'), fixtureComponent('b', 'p', [0, 0, 100])],
    });
    const pairV = fixtureVersion('pair', 'v1', pair);
    let car = emptyCad(fixtureKernel);
    car = applyCadOperation(car, {
      type: 'insertComponents',
      parts: [
        fixturePart('part-plate', 'Plate', pv),
        fixturePart('part-pair', 'Pair', pairV),
        fixturePart('part-bare', 'Bare', bv),
      ],
      components: [
        fixtureComponent('front', 'part-plate', [0, 0, 0]),
        fixtureComponent('rear', 'part-pair', [3000, 0, 0]),
        fixtureComponent('trim', 'part-bare', [1000, 0, 0]),
      ],
    });
    const closure = new Map<string, CadDocument>(
      [pv, bv, pairV].map((v) => [v.contentHash, v.content]),
    );
    const bodyId = plate.bodies[0]!.id;
    // 80 × 50 × 5 mm of steel: 20,000 mm³ is 0.157 kg, its centre at (40, 25, 2.5).
    const ev = { bodies: { [bodyId]: solidEval(20_000, [40, 25, 2.5]) } };
    const result = cadMass(car, undefined, (h) => closure.get(h), {
      [pv.contentHash]: ev,
      [bv.contentHash]: ev,
    });
    expect(result.items.map((i) => i.path)).toEqual([['front'], ['rear', 'a'], ['rear', 'b']]);
    expect(result.massKg).toBeCloseTo(3 * 0.157, 9);
    expect(result.centroidMm![0]).toBeCloseTo((40 + 2 * 3040) / 3, 9);
    expect(result.centroidMm![2]).toBeCloseTo((2.5 + 2.5 + 102.5) / 3, 9);
    // A body without a mass is left out (not counted as 0), with why.
    expect(result.leftOut).toEqual([
      { path: ['trim'], bodyId, name: bare.bodies[0]!.name, code: 'mass-missing' },
    ]);
    expect(componentCentre(result, ['rear'])![2]).toBeCloseTo(52.5, 9);
    // Front axle at x 40, rear at 3040, the centre at 2040: one third front, two thirds rear.
    const split = axleSplit(result, [['front']], [['rear']]);
    if ('code' in split) throw new Error(split.code);
    expect(split.front).toBeCloseTo(1 / 3, 9);
    expect(split.rear).toBeCloseTo(2 / 3, 9);
    expect(split.wheelbaseMm).toBeCloseTo(Math.hypot(3000, 0, 50), 9);
    // Not evaluated yet: left out.
    const pending = cadMass(car, undefined, (h) => closure.get(h), undefined);
    expect(pending.massKg).toBe(0);
    expect(pending.leftOut.map((l) => l.code)).toContain('mass-not-evaluated');
    expect(axleSplit(pending, [['front']], [['rear']])).toEqual({ code: 'mass-empty' });
  });

  it('keeps a body’s density through a thicken, a Boolean and a tool given back', () => {
    // A weighed sheet thickened: still weighed, its thickness dropped for its volume.
    const trimmed = applyCadOperation(f18Hood('trim'), {
      type: 'setBodyMass',
      bodyId: 'left',
      mass: { ...steel, thicknessMm: 0.8 },
    });
    const thick = applyCadOperation(trimmed, {
      type: 'detailBody',
      bodyId: 'left',
      placementFeatureId: 'skin-placement',
      feature: {
        id: 'skin',
        name: 'Skin',
        type: 'thicken',
        inputFeatureIds: ['window-placement'],
        args: { thickness: mm(1.5), side: 'front' },
      },
    });
    expect(thick.bodies.find((b) => b.id === 'left')!.mass).toEqual(steel);
    // Boolean tools consumed and one given back keep their densities.
    let holes = f12Holes();
    for (const id of ['a', 'b'])
      holes = applyCadOperation(holes, { type: 'setBodyMass', bodyId: id, mass: steel });
    expect(holes.bodies.filter((b) => b.mass).map((b) => b.id)).toEqual(['a', 'b']);
    const back = applyCadOperation(holes, {
      type: 'setBooleanTools',
      featureId: 'holes',
      toolIds: ['a'],
    });
    expect(back.bodies.find((b) => b.id === 'b')).toMatchObject({ state: 'active', mass: steel });
  });

  it('leaves out a part this person may no longer read, without naming its bodies', () => {
    const plate = applyCadOperation(f02Plate(), {
      type: 'setBodyMass',
      bodyId: f02Plate().bodies[0]!.id,
      mass: steel,
    });
    const pv = fixtureVersion('plate', 'v1', plate);
    const shared = fixtureVersion('plate-shared', 'v1', plate);
    let pair = emptyCad(fixtureKernel);
    pair = applyCadOperation(pair, {
      type: 'insertComponents',
      parts: [fixturePart('p', 'Plate', pv)],
      components: [fixtureComponent('a', 'p'), fixtureComponent('b', 'p', [0, 0, 100])],
    });
    const pairV = fixtureVersion('pair', 'v1', pair);
    let doc = emptyCad(fixtureKernel);
    doc = applyCadOperation(doc, {
      type: 'insertComponents',
      parts: [
        fixturePart('part-pair', 'Pair', pairV),
        fixturePart('part-open', 'Open plate', shared),
      ],
      components: [fixtureComponent('denied', 'part-pair'), fixtureComponent('open', 'part-open')],
    });
    const closure = new Map<string, CadDocument>(
      [pv, pairV].map((v) => [v.contentHash, v.content]),
    );
    const bodyId = plate.bodies[0]!.id;
    const ev = { bodies: { [bodyId]: solidEval(20_000, [40, 25, 2.5]) } };
    // The same version is placed readably too: only that occurrence weighs.
    const result = cadMass(
      doc,
      undefined,
      (h) => closure.get(h),
      { [pv.contentHash]: ev },
      (artifactId) => artifactId !== 'pair',
    );
    expect(result.items.map((i) => i.path)).toEqual([['open']]);
    expect(result.massKg).toBeCloseTo(0.157, 9);
    expect(result.leftOut).toEqual([
      { path: ['denied'], bodyId: '', name: 'Pair', code: 'mass-no-access' },
    ]);
    // A version the closure does not hold: listed, not weighed as nothing.
    const gone = cadMass(
      doc,
      undefined,
      (h) => (h === pv.contentHash ? undefined : closure.get(h)),
      {
        [pv.contentHash]: ev,
      },
    );
    expect(gone.massKg).toBe(0);
    expect(gone.leftOut).toEqual([
      { path: ['denied', 'a'], bodyId: '', name: 'Plate', code: 'mass-part-missing' },
      { path: ['denied', 'b'], bodyId: '', name: 'Plate', code: 'mass-part-missing' },
      { path: ['open'], bodyId: '', name: 'Open plate', code: 'mass-part-missing' },
    ]);
    // A sub-assembly that failed (e.g. its saved poses do not match its joints): its parts are
    // not weighed at the rejected poses, even when their own version evaluated.
    const failed = cadMass(doc, undefined, (h) => closure.get(h), {
      [pv.contentHash]: ev,
      [pairV.contentHash]: { state: 'failed' },
    });
    expect(failed.items.map((i) => i.path)).toEqual([['open']]);
    expect(failed.leftOut).toEqual([
      { path: ['denied'], bodyId: '', name: 'Pair', code: 'mass-part-failed' },
    ]);
    // One whose build is not available here (or only a reference substitute): the same.
    for (const state of ['unavailable', 'substitute'])
      expect(
        cadMass(doc, undefined, (h) => closure.get(h), {
          [pv.contentHash]: ev,
          [pairV.contentHash]: { state },
        }).leftOut,
      ).toEqual([{ path: ['denied'], bodyId: '', name: 'Pair', code: 'mass-part-unavailable' }]);
  });
});
