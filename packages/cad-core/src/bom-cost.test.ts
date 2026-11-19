import { describe, expect, it } from 'vitest';
import { bomCsv, bomCsvHeader, bomRows } from './bom';
import { bomJson, bomReport, cadBomJsonFormat, type CadBomEvaluations } from './bom-cost';
import { f151CostedBom, f151Values, r2bBom } from './bom-fixtures';
import type { CadBodyEvaluation } from './coordinator';
import { measureDesignTargets } from './design-targets';
import { fixtureComponent, fixturePart, fixtureVersion } from './assembly-fixtures';
import { compareCad } from './diff';
import { bodyPartContent } from './make-part';
import { f02Plate, f25B1Car, fixtureKernel } from './fixtures';
import { bodyMass, cadMass } from './mass';
import { emptyCad, type CadDocument } from './model';
import { applyCadOperation } from './operations';
import { validateCad } from './validation';

const codes = (doc: unknown) => validateCad(doc).map((d) => `${d.code}@${d.path}`);
const solid = (volumeMm3: number): CadBodyEvaluation => ({
  kind: 'solid',
  volumeMm3,
  areaMm2: 0,
  bounds: [
    [0, 0, 0],
    [1, 1, 1],
  ],
  centroidMm: [0, 0, 0],
});
const aluminium = { name: 'aluminium', densityKgM3: 2700 };
const bodiesOf = (doc: CadDocument, volumeMm3: number) =>
  Object.fromEntries(
    doc.bodies.filter((b) => b.state === 'active').map((b) => [b.id, solid(volumeMm3)]),
  );

describe('part material, sourcing and cost (PD2, ST-753)', () => {
  it('sets the values together, keeps them on a part number edit, and diffs them (TS-2510)', () => {
    const plate = f02Plate();
    // A document without the PD2 values still reads as it is.
    expect(plate.partProperties).toEqual({ partNumber: '', description: '' });
    expect(codes(plate)).toEqual([]);
    const set = applyCadOperation(plate, {
      type: 'setPartBomProperties',
      material: aluminium,
      sourcing: 'outsource',
      unitCost: 1500,
      currency: 'JPY',
      supplier: 'Plate shop',
    });
    expect(codes(set)).toEqual([]);
    expect(set.partProperties).toEqual({
      partNumber: '',
      description: '',
      material: aluminium,
      sourcing: 'outsource',
      unitCost: 1500,
      currency: 'JPY',
      supplier: 'Plate shop',
    });
    expect(compareCad(plate, set)).toEqual([
      expect.objectContaining({ elementId: 'partProperties', kind: 'changed' }),
    ]);
    // The part number edit leaves them; the BOM values edit leaves the part number.
    const named = applyCadOperation(set, {
      type: 'setPartProperties',
      partNumber: 'PL-100',
      description: 'Base plate',
    });
    expect(named.partProperties).toMatchObject({ partNumber: 'PL-100', unitCost: 1500 });
    const cleared = applyCadOperation(named, { type: 'setPartBomProperties', sourcing: 'make' });
    expect(cleared.partProperties).toEqual({
      partNumber: 'PL-100',
      description: 'Base plate',
      sourcing: 'make',
    });
    // The edit does not share the operation's material object.
    const material = { ...aluminium };
    const own = applyCadOperation(plate, { type: 'setPartBomProperties', material });
    material.densityKgM3 = 1;
    expect(own.partProperties.material?.densityKgM3).toBe(2700);
  });

  it('refuses a bad material, sourcing class, cost or currency (TS-2510)', () => {
    const bad = (props: Record<string, unknown>) => {
      const doc = structuredClone(f02Plate()) as unknown as { partProperties: unknown };
      doc.partProperties = { partNumber: '', description: '', ...props };
      return codes(doc);
    };
    expect(bad({ material: { name: 'steel', densityKgM3: 5 } })).toEqual([
      'mass-density@$.partProperties.material.densityKgM3',
    ]);
    expect(bad({ material: { name: ' ', densityKgM3: 7850 } })).toEqual([
      'part-material@$.partProperties.material.name',
    ]);
    expect(bad({ material: { name: 'steel' } })).toEqual([
      'missing-field@$.partProperties.material.densityKgM3',
    ]);
    expect(bad({ material: 'steel' })).toEqual(['part-material@$.partProperties.material']);
    expect(bad({ sourcing: 'borrow' })).toEqual(['part-sourcing@$.partProperties.sourcing']);
    expect(bad({ unitCost: 10 })).toEqual(['part-cost-currency@$.partProperties.currency']);
    expect(bad({ unitCost: -1, currency: 'JPY' })).toEqual(['part-cost@$.partProperties.unitCost']);
    // A number that is not finite is refused before the PD2 rules, as anywhere in the document.
    expect(bad({ unitCost: Number.NaN, currency: 'JPY' })).toEqual([
      'number@$.partProperties.unitCost',
    ]);
    expect(bad({ unitCost: 1e13, currency: 'JPY' })).toEqual([
      'part-cost@$.partProperties.unitCost',
    ]);
    expect(bad({ currency: 'yen' })).toEqual(['part-currency@$.partProperties.currency']);
    expect(bad({ supplier: 'a\u0007b' })).toEqual(['name@$.partProperties.supplier']);
    expect(bad({ weight: 1 })).toEqual(['unknown-field@$.partProperties.weight']);
    // A currency alone (no cost yet) and a cost of 0 are accepted.
    expect(bad({ currency: 'EUR' })).toEqual([]);
    expect(bad({ unitCost: 0, currency: 'EUR' })).toEqual([]);
  });

  it('weighs a body without a density of its own with the part material (TS-2511)', () => {
    const plate = applyCadOperation(f02Plate(), {
      type: 'setPartBomProperties',
      material: aluminium,
    });
    const body = plate.bodies[0]!;
    const e = solid(1_000_000);
    expect(bodyMass(body, e)).toEqual({ code: 'mass-missing' });
    expect(bodyMass(body, e, aluminium)).toMatchObject({ massKg: 2.7 });
    expect(cadMass(plate, { [body.id]: e }, () => undefined, undefined).massKg).toBeCloseTo(2.7);
    // A density of the body's own wins.
    const steel = applyCadOperation(plate, {
      type: 'setBodyMass',
      bodyId: body.id,
      mass: { densityKgM3: 7850, material: 'steel' },
    });
    expect(cadMass(steel, { [body.id]: e }, () => undefined, undefined).massKg).toBeCloseTo(7.85);
    // A body mass target reads the part material too (PD1).
    const target: CadDocument = {
      ...plate,
      designTargets: [
        { id: 'm', name: 'Plate mass', measure: { kind: 'mass', bodyIds: [body.id] }, max: 3 },
      ],
    };
    expect(measureDesignTargets(target, { bodies: { [body.id]: e } })[0]).toMatchObject({
      status: 'pass',
    });
    expect(measureDesignTargets(target, { bodies: { [body.id]: e } })[0]!.value).toBeCloseTo(2.7);
    // Making a part of the body takes the material along (not the sourcing or cost), so the
    // part weighs the same.
    const costed = applyCadOperation(plate, {
      type: 'setPartBomProperties',
      material: aluminium,
      sourcing: 'make',
      unitCost: 10,
      currency: 'JPY',
    });
    expect(bodyPartContent(costed, body.id).partProperties).toEqual({
      partNumber: '',
      description: '',
      material: aluminium,
    });
    expect(bodyPartContent(f02Plate(), body.id).partProperties).toEqual({
      partNumber: '',
      description: '',
    });
    // A sheet still needs its own thickness.
    const car = f25B1Car();
    const sheet = car.bodies.find((b) => b.kind === 'sheet' && b.state === 'active')!;
    const area: CadBodyEvaluation = {
      kind: 'sheet',
      areaMm2: 1000,
      bounds: solid(0).bounds,
      centroidMm: [0, 0, 0],
      freeEdges: 0,
      freeEdgeLengthMm: 0,
    };
    expect(bodyMass(sheet, area, aluminium)).toEqual({ code: 'mass-thickness-missing' });
  });
});

describe('BOM mass and cost (PD2, ST-754, F151)', () => {
  const f = f151CostedBom();
  const lookup = (h: string) => f.closure.get(h);
  const own = f.assembly.bodies.find((b) => b.state === 'active')!;
  // Each plate version is 10,000 mm³, the bolt 1,000 mm³; the cart's own plate has no density.
  const evaluations: CadBomEvaluations = {
    own: { [own.id]: solid(10_000) },
    versions: Object.fromEntries(
      [f.plate1, f.plate2, f.bolt, f.wheel].map((v) => [
        v.contentHash,
        { state: 'available', bodies: bodiesOf(v.content, v === f.bolt ? 1_000 : 10_000) },
      ]),
    ),
  };
  const plateKg = 10_000 * 2700 * 1e-9;
  const boltKg = 1_000 * 7850 * 1e-9;

  it('F151 is valid and its values reach every version (TS-2516)', () => {
    expect(codes(f.assembly)).toEqual([]);
    for (const v of [f.plate1, f.plate2, f.bolt, f.wheel]) expect(codes(v.content)).toEqual([]);
    expect(f.bolt.content.partProperties).toMatchObject(f151Values.bolt);
    expect(f.assembly.partProperties).toMatchObject({ partNumber: 'CART-1', unitCost: 500 });
  });

  it('gives each flat row its material, sourcing, mass and cost, and the totals (TS-2512)', () => {
    const { rows, totals } = bomReport(f.assembly, lookup, 'flat', evaluations);
    expect(
      rows.map((r) => [r.item, r.name, r.quantity, r.material, r.sourcing, r.unitCost, r.cost]),
    ).toEqual([
      ['1', own.name, 1, undefined, undefined, undefined, undefined],
      ['2', 'Plate', 5, 'aluminium', 'make', 1200, 6000],
      ['3', 'Plate', 1, 'aluminium', 'outsource', 1500, 1500],
      ['4', 'Bolt "M8", long', 24, 'steel', 'standard', 12.5, 300],
    ]);
    expect(rows[1]!.supplier).toBe('In-house machining');
    expect(rows[1]!.unitMassKg).toBeCloseTo(plateKg);
    expect(rows[1]!.massKg).toBeCloseTo(5 * plateKg);
    expect(rows[3]!.massKg).toBeCloseTo(24 * boltKg);
    expect(rows[0]).toMatchObject({ massLeftOut: 1 });
    expect(rows[0]!.massKg).toBeUndefined();
    // The cart's own 500 and the wheels' own 4 × 300 of work are in the total.
    expect(totals.cost).toBe(500 + 6000 + 1500 + 300 + 4 * 300);
    expect(totals.currency).toBe('JPY');
    expect(totals.massKg).toBeCloseTo(6 * plateKg + 24 * boltKg);
    expect(totals.bySourcing).toEqual({
      make: { quantity: 5, cost: 6000 },
      outsource: { quantity: 1, cost: 1500 },
      buy: { quantity: 0, cost: 0 },
      standard: { quantity: 24, cost: 300 },
      unset: { quantity: 0, cost: 0 },
    });
    // The cart's plate has no density: listed, never counted as 0.
    expect(totals.leftOut).toEqual([
      { item: '1', name: own.name, bodyName: '', code: 'mass-missing' },
    ]);
    // The rows are the R2b-3 BOM's, with the PD2 values added.
    expect(rows.map((r) => r.item)).toEqual(bomRows(f.assembly, lookup, 'flat').map((r) => r.item));
  });

  it('puts the same values on the hierarchical rows and keeps the same totals (TS-2513)', () => {
    const flat = bomReport(f.assembly, lookup, 'flat', evaluations);
    const tree = bomReport(f.assembly, lookup, 'hierarchical', evaluations);
    expect(tree.totals).toEqual(flat.totals);
    expect(tree.rows.map((r) => [r.item, r.sourcing, r.unitCost, r.cost])).toEqual([
      ['1', undefined, undefined, undefined],
      ['2', 'make', 1200, 1200],
      ['3', 'outsource', 1500, 1500],
      ['4', 'make', 300, 1200],
      ['4.1', 'make', 1200, 1200],
      ['4.2', 'standard', 12.5, 25],
      ['5', 'standard', 12.5, 200],
    ]);
    // The wheel has no bodies of its own: no mass on its row.
    expect(tree.rows[3]!.massKg).toBeUndefined();
    expect(tree.rows[4]!.massKg).toBeCloseTo(plateKg);
  });

  it('lists what it cannot weigh or cost, never as 0 (TS-2514)', () => {
    // Not evaluated yet: every part's body is left out (the cart's own has no density at all).
    const none = bomReport(f.assembly, lookup, 'flat');
    expect(none.totals.massKg).toBe(0);
    expect(none.totals.leftOut.map((l) => [l.item, l.code])).toEqual([
      ['1', 'mass-missing'],
      ['2', 'mass-not-evaluated'],
      ['3', 'mass-not-evaluated'],
      ['4', 'mass-not-evaluated'],
    ]);
    expect(none.totals.cost).toBe(9500);
    // No read access to the wheel: its parts are not reached, the wheel is listed for both.
    const denied = bomReport(f.assembly, lookup, 'flat', {
      ...evaluations,
      access: (a) => a !== 'wheel',
    });
    // (A version this Surface cannot read is a row of the flat table, as in R2b-3.)
    expect(denied.totals.leftOut.slice(1)).toEqual([
      { item: '4', name: 'Wheel', bodyName: '', code: 'mass-no-access' },
      { item: '4', name: 'Wheel', bodyName: '', code: 'cost-unavailable' },
    ]);
    expect(denied.rows[3]).toMatchObject({ unavailable: true, massLeftOut: 1 });
    expect(denied.totals.cost).toBe(500 + 1200 + 1500 + 16 * 12.5);
    // A wheel that failed to evaluate (its own joints) is listed, and nothing it places is
    // weighed, though the hub and bolt versions are calculated (as the mass panel).
    const failed = bomReport(f.assembly, lookup, 'flat', {
      ...evaluations,
      versions: {
        ...evaluations.versions,
        [f.wheel.contentHash]: { state: 'failed', bodies: {} },
      },
    });
    expect(failed.totals.massKg).toBeCloseTo(2 * plateKg + 16 * boltKg);
    expect(failed.totals.leftOut).toContainEqual({
      item: '',
      name: 'Wheel',
      bodyName: '',
      code: 'mass-part-failed',
    });
    expect(failed.rows[1]).toMatchObject({ quantity: 5, massLeftOut: 1 });
    expect(failed.rows[1]!.massKg).toBeCloseTo(plateKg);
    const failedTree = bomReport(f.assembly, lookup, 'hierarchical', {
      ...evaluations,
      versions: {
        ...evaluations.versions,
        [f.wheel.contentHash]: { state: 'failed', bodies: {} },
      },
    });
    expect(failedTree.rows.map((r) => [r.item, r.massKg !== undefined])).toEqual([
      ['1', false],
      ['2', true],
      ['3', true],
      ['4', false],
      ['4.1', false],
      ['4.2', false],
      ['5', true],
    ]);
    // Two saved versions with one content are separate rows, each weighing its own count.
    const twin = fixtureVersion('plate-copy', 'v1', f.plate1.content);
    const pair = applyCadOperation(emptyCad(fixtureKernel), {
      type: 'insertComponents',
      parts: [fixturePart('a', 'Plate A', f.plate1), fixturePart('b', 'Plate B', twin)],
      components: [
        fixtureComponent('a-1', 'a'),
        fixtureComponent('a-2', 'a', [0, 100, 0]),
        fixtureComponent('b-1', 'b', [0, 200, 0]),
      ],
    });
    const twins = bomReport(pair, lookup, 'flat', evaluations);
    expect(twins.rows.map((r) => [r.name, r.quantity, r.massLeftOut])).toEqual([
      ['Plate A', 2, undefined],
      ['Plate B', 1, undefined],
    ]);
    expect(twins.rows[0]!.massKg).toBeCloseTo(2 * plateKg);
    expect(twins.rows[1]!.massKg).toBeCloseTo(plateKg);
    expect(twins.totals.massKg).toBeCloseTo(3 * plateKg);
    // A failed version is left out; a part without a cost and one in dollars are listed.
    const g = r2bBom(undefined, {
      plate1: { unitCost: 10, currency: 'USD' },
      bolt: { sourcing: 'buy' },
      assembly: { currency: 'JPY' },
    });
    const evaluated = Object.fromEntries(
      [g.plate1, g.plate2, g.bolt, g.wheel].map((v) => [
        v.contentHash,
        {
          state: v === g.plate2 ? 'failed' : 'available',
          bodies: bodiesOf(v.content, 1_000),
        },
      ]),
    );
    const mixed = bomReport(g.assembly, (h) => g.closure.get(h), 'flat', { versions: evaluated });
    expect(mixed.totals.currency).toBe('JPY');
    expect(mixed.totals.cost).toBe(0);
    expect(mixed.totals.leftOut.map((l) => [l.item, l.code])).toEqual([
      ['1', 'mass-missing'],
      ['2', 'mass-missing'],
      ['2', 'cost-currency'],
      ['3', 'mass-part-failed'],
      ['3', 'cost-missing'],
      ['4', 'mass-missing'],
      ['4', 'cost-missing'],
    ]);
    expect(mixed.totals.bySourcing.buy.quantity).toBe(24);
    expect(mixed.totals.bySourcing.unset.quantity).toBe(6);
  });
});

describe('BOM export (PD2, ST-755)', () => {
  const f = f151CostedBom();
  const lookup = (h: string) => f.closure.get(h);
  const versions = Object.fromEntries(
    [f.plate1, f.plate2, f.bolt].map((v) => [
      v.contentHash,
      { state: 'available', bodies: bodiesOf(v.content, 1_000) },
    ]),
  );

  it('writes the PD2 columns and a total row to CSV (TS-2515)', () => {
    const report = bomReport(f.assembly, lookup, 'flat', { versions });
    const csv = bomCsv(report.rows, report.totals);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(bomCsvHeader.join(','));
    expect(lines[0]).toBe(
      'Item,Part number,Name,Description,Quantity,Artifact,Version,Material,Sourcing,Supplier,' +
        'Unit mass (kg),Mass (kg),Unit cost,Cost,Currency',
    );
    expect(lines[3]).toBe(
      `3,PL-100,Plate,"Base plate, rev B",1,plate,v2,aluminium,outsource,` +
        `"Plate shop ""A"", Osaka",0.002700,0.002700,1500,1500,JPY`,
    );
    expect(lines[4]).toBe(
      `4,'=B-M8,"Bolt ""M8"", long",'-M8 x 40,24,bolt,v1,steel,standard,Fastener catalogue,` +
        `0.007850,0.188400,12.5,300,JPY`,
    );
    expect(lines[5]).toBe('Total,,,,,,,,,,,0.204600,,9500,JPY');
    expect(csv.endsWith('\r\n')).toBe(true);
    // Without a report the R2b-3 rows leave the mass and cost columns empty, and add no total.
    const plain = bomCsv(bomRows(f.assembly, lookup, 'flat')).split('\r\n');
    expect(plain[2]).toBe(
      '2,PL-100,Plate,Base plate,5,plate,v1,aluminium,make,In-house machining,,,1200,,JPY',
    );
    expect(plain).toHaveLength(6);
  });

  it('writes the report to JSON with the format, rows and totals (TS-2515)', () => {
    const report = bomReport(f.assembly, lookup, 'hierarchical', { versions });
    const text = bomJson(report, { name: 'F151', contentHash: 'abc' });
    expect(text.endsWith('\n')).toBe(true);
    const json = JSON.parse(text);
    expect(json).toMatchObject({
      ...cadBomJsonFormat,
      name: 'F151',
      contentHash: 'abc',
      mode: 'hierarchical',
      totals: { cost: 9500, currency: 'JPY' },
    });
    expect(json.rows).toHaveLength(7);
    expect(json.rows[5]).toMatchObject({ item: '4.2', sourcing: 'standard', cost: 25 });
    expect(JSON.parse(JSON.stringify(report))).toEqual(
      Object.fromEntries(['mode', 'rows', 'totals'].map((k) => [k, json[k]])),
    );
  });
});
