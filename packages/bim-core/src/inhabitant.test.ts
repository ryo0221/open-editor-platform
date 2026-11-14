// GV2b (docs/cad/gulliver-world.md): the rules that come from a person's body scale with the
// building's people (Lilliput 146 mm, Gulliver 1,750 mm, Brobdingnag 21,000 mm).
import { describe, expect, it } from 'vitest';
import { bimStairProfile, deriveBim } from './derive';
import { bimStarter } from './fixtures';
import { bimBodyLimits, bimLimits, type BimDocument, type BimElement, type BimType } from './model';
import { applyBimOperation, assertBimOperation } from './operations';
import { validateBim } from './validation';

const errors = (doc: BimDocument) =>
  validateBim(doc)
    .filter((d) => d.severity === 'error')
    .map((d) => `${d.code} ${d.path}`);
/** A two-level building for `heightMm` people: no door or window types unless given. */
function building(
  heightMm: number | undefined,
  storeyMm: number,
  types: BimType[] = [],
  elements: BimElement[] = [],
  waistMm = 20,
): BimDocument {
  const doc = bimStarter();
  if (heightMm !== undefined) doc.inhabitantHeightMm = heightMm;
  doc.levels = [
    { id: 'l-1', name: '1', elevationMm: 0 },
    { id: 'l-2', name: '2', elevationMm: storeyMm },
  ];
  doc.types = [
    ...doc.types.filter((t) => t.kind !== 'door' && t.kind !== 'window'),
    {
      id: 't-waist',
      kind: 'slab',
      name: 'Waist',
      layers: [{ materialId: 'm-concrete', thicknessMm: waistMm }],
    },
    ...types,
  ];
  doc.elements = elements;
  return doc;
}
const stair = (widthMm: number, risers: number, treadMm: number): BimElement => ({
  id: 'st',
  kind: 'stair',
  typeId: 't-waist',
  start: { xy: [0, 0] },
  directionRad: 0,
  widthMm,
  risers,
  treadMm,
  base: { level: 'l-1', offsetMm: 0 },
  top: { level: 'l-2', offsetMm: 0 },
});
const door = (widthMm: number, heightMm: number): BimType => ({
  id: 't-door',
  kind: 'door',
  name: 'Door',
  widthMm,
  heightMm,
});

describe('inhabitant height (ST-642, TS-2303)', () => {
  it('scales the body-based limits and keeps the rest', () => {
    expect(bimBodyLimits()).toEqual({
      inhabitantHeightMm: 1750,
      scale: 1,
      minStoreyMm: 1000,
      stair: { riserMm: [50, 250], treadMm: [150, 500], widthMm: 10_000 },
      railingHeightMm: 3000,
      openingMm: 20_000,
      maxSectionMm: 10_000,
    });
    const big = bimBodyLimits({ inhabitantHeightMm: 21_000 });
    expect(big.scale).toBe(12);
    expect(big.minStoreyMm).toBe(12_000);
    expect(big.stair).toEqual({ riserMm: [600, 3000], treadMm: [1800, 6000], widthMm: 120_000 });
    expect(big.openingMm).toBe(240_000);
    const small = bimBodyLimits({ inhabitantHeightMm: 146 });
    expect(small.minStoreyMm).toBeCloseTo(83.43, 2);
    expect(small.railingHeightMm).toBeCloseTo(250.29, 2);
    // Out-of-range heights (which validation refuses) fall back to people 1,750 mm tall.
    expect(bimBodyLimits({ inhabitantHeightMm: 50 }).scale).toBe(1);
  });

  it('GK1: a 250 mm storey passes for 146 mm people and is refused for 1,750 mm', () => {
    expect(errors(building(146, 250))).toEqual([]);
    expect(errors(building(undefined, 250))).toEqual(['level-spacing $.levels']);
    expect(errors(building(1750, 250))).toEqual(['level-spacing $.levels']);
    // Lilliput steps: 15 risers of 16.7 mm and 30 mm treads, 100 mm wide.
    const steps = building(146, 250, [], [stair(100, 15, 30)]);
    expect(errors(steps)).toEqual([]);
    expect(deriveBim(steps).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(errors(building(146, 250, [], [stair(100, 15, 10)]))).toEqual([
      'stair-tread $.elements[0].treadMm',
    ]);
    // A 250 mm storey in 2 risers is 125 mm a riser: too tall a step for 146 mm people.
    expect(errors(building(146, 250, [], [stair(100, 2, 30)]))).toContain(
      'stair-riser $.elements[0].top',
    );
  });

  it('GK1: a 24 m door and a 12 m stair pass for 21,000 mm people and are refused for 1,750 mm', () => {
    const giants = (h: number | undefined) =>
      building(h, 12_000, [door(12_000, 24_000)], [stair(12_000, 10, 3_000)], 1_500);
    expect(errors(giants(21_000))).toEqual([]);
    // A 12 m storey is fine for anyone; the door's 24 m height, the stair's width and its
    // treads are not (a 12 m wide door is, under the 20 m opening limit since GV3a).
    expect(errors(giants(undefined))).toEqual(
      expect.arrayContaining([
        'dimension $.types[6].heightMm',
        'dimension $.elements[0].widthMm',
        'stair-tread $.elements[0].treadMm',
      ]),
    );
    // A 1,750 mm door is too tall for Lilliput (its doors are at most 1,669 mm); the temple's
    // great gate, 4 ft high (1,219 mm), passes (GV3).
    expect(errors(building(146, 250, [door(900, 2100)]))).toEqual([
      'dimension $.types[6].heightMm',
    ]);
    expect(errors(building(146, 1500, [door(584, 1219)]))).toEqual([]);
  });

  it('keeps sizes that do not come from a body: coordinates, the count of risers', () => {
    expect(bimLimits.coordinateMm).toBe(1_000_000);
    expect(bimLimits.stair.risers).toEqual([2, 50]);
  });

  it('lets sections grow with taller people but not shrink with smaller ones (GV4a)', () => {
    const thick = (h: number | undefined, mm: number) => {
      const doc = building(h, 12_000);
      doc.types.push({
        id: 't-thick',
        kind: 'wall',
        name: 'Thick',
        layers: [{ materialId: 'm-concrete', thicknessMm: mm }],
      });
      return errors(doc).filter((e) => e.startsWith('dimension $.types[6]'));
    };
    // Brobdingnag's temple tower: walls 100 ft thick (30,480 mm), for 21 m people.
    expect(bimBodyLimits({ inhabitantHeightMm: 21_000 }).maxSectionMm).toBe(120_000);
    expect(thick(21_000, 30_480)).toEqual([]);
    expect(thick(21_000, 120_001)).toContain('dimension $.types[6].layers[0].thicknessMm');
    // For us the 100 ft wall is refused; for Lilliput the limit stays ours (10 m).
    expect(thick(undefined, 30_480)).toContain('dimension $.types[6].layers[0].thicknessMm');
    expect(bimBodyLimits({ inhabitantHeightMm: 146 }).maxSectionMm).toBe(bimLimits.maxSectionMm);
    expect(thick(146, 2_000)).toEqual([]);
  });

  it('refuses heights outside 100 mm to 30 m', () => {
    for (const h of [99, 30_001, '1750'])
      expect(errors({ ...building(undefined, 3000), inhabitantHeightMm: h } as never)).toContain(
        'inhabitant-height $.inhabitantHeightMm',
      );
    // Not JSON at all: the document's number check refuses it first.
    expect(
      errors({ ...building(undefined, 3000), inhabitantHeightMm: Number.NaN }).some((e) =>
        e.endsWith('$.inhabitantHeightMm'),
      ),
    ).toBe(true);
  });

  it('the stair profile takes the building riser range', () => {
    expect(bimStairProfile(15, 250 / 15, 30, 20)).toBe('riser');
    expect(
      typeof bimStairProfile(
        15,
        250 / 15,
        30,
        20,
        bimBodyLimits({ inhabitantHeightMm: 146 }).stair.riserMm,
      ),
    ).toBe('object');
  });

  it('setInhabitantHeight is one operation, refused when the building breaks the new rules', () => {
    const doc = building(146, 250);
    const human = bimStarter();
    expect(() =>
      applyBimOperation(human, { type: 'setInhabitantHeight', heightMm: 146 }),
    ).toThrow();
    const giant = applyBimOperation(building(undefined, 12_000), {
      type: 'setInhabitantHeight',
      heightMm: 21_000,
    });
    expect(giant.inhabitantHeightMm).toBe(21_000);
    const back = applyBimOperation(giant, { type: 'setInhabitantHeight' });
    expect(back).not.toHaveProperty('inhabitantHeightMm');
    expect(() => applyBimOperation(doc, { type: 'setInhabitantHeight' })).toThrow();
    expect(() => assertBimOperation({ type: 'setInhabitantHeight', heightMm: '146' })).toThrow(
      'operation-schema',
    );
    expect(() => assertBimOperation({ type: 'setInhabitantHeight', heightMm: 146, x: 1 })).toThrow(
      'operation-schema',
    );
  });
});
