import { describe, expect, it } from 'vitest';
import type { CadBodyEvaluation } from './coordinator';
import {
  designTargetReport,
  measureDesignTargets,
  pruneDesignTargets,
  type CadDesignTarget,
} from './design-targets';
import { compareCad } from './diff';
import { f11Bracket } from './fixtures';
import { f150LugTargets } from './product-design-fixtures';
import type { CadDocument } from './model';
import { applyCadOperation } from './operations';
import { defaultProportions, type CadProportionMesh } from './proportions';
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
const solid = (volumeMm3: number, areaMm2: number): CadBodyEvaluation => ({
  kind: 'solid',
  volumeMm3,
  areaMm2,
  bounds: [
    [0, 0, 0],
    [1, 1, 1],
  ],
  centroidMm: [0, 0, 0],
});

// PD1 (docs/cad/product-design.md, PD1 設計の目標値). ST-750, TS-2500..2502.
describe('PD1 design targets', () => {
  // A watch case with two lugs: the lugs' inner faces are 11.2 mm apart (SK-01 as first drawn),
  // the strap needs 16 mm (DM-01).
  const watch = (gap: number): { doc: CadDocument; meshes: CadProportionMesh[] } => {
    const doc = f11Bracket();
    const targets: CadDesignTarget[] = [
      {
        id: 'lug-gap',
        name: 'Lug width',
        requirement: 'RQ-04',
        measure: { kind: 'distance', a: ['lug-l'], b: ['lug-r'] },
        min: 15.9,
        max: 16.1,
      },
      {
        id: 'case-dia',
        name: 'Case diameter',
        measure: { kind: 'extent', bodyIds: ['case'], axis: 'x' },
        max: 42,
      },
      { id: 'width', name: 'W', measure: { kind: 'parameter', parameterId: 'W' }, min: 1 },
      {
        id: 'mass',
        name: 'Case mass',
        measure: { kind: 'mass', bodyIds: ['case'] },
        max: 0.03,
      },
      { id: 'vol', name: 'Volume', measure: { kind: 'volume', bodyIds: ['case'] }, max: 5000 },
      { id: 'area', name: 'Area', measure: { kind: 'area', bodyIds: ['case', 'lug-l'] }, min: 1 },
    ];
    const meshes = [
      box('case', [-20, -20, 0], [20, 20, 10]),
      box('lug-l', [-gap / 2 - 2, 18, 2], [-gap / 2, 24, 6]),
      box('lug-r', [gap / 2, 18, 2], [gap / 2 + 2, 24, 6]),
    ];
    return {
      doc: {
        ...doc,
        designTargets: targets,
        bodies: [
          ...doc.bodies,
          // Only their IDs and mass are read here (no validation of the document).
          { ...doc.bodies[0]!, id: 'case', mass: { densityKgM3: 8000 } },
          { ...doc.bodies[0]!, id: 'lug-l' },
          { ...doc.bodies[0]!, id: 'lug-r' },
        ],
      },
      meshes,
    };
  };
  const bodies = { case: solid(3000, 2000), 'lug-l': solid(48, 100), 'lug-r': solid(48, 100) };

  it('measures each kind and checks it against its band (TS-2500)', () => {
    const before = watch(11.2);
    const r = measureDesignTargets(before.doc, { meshes: before.meshes, bodies });
    const byId = Object.fromEntries(r.map((x) => [x.id, x]));
    expect(byId['lug-gap']).toMatchObject({ unit: 'mm', status: 'fail' });
    expect(byId['lug-gap']!.value).toBeCloseTo(11.2, 9);
    expect(byId['case-dia']).toEqual({ id: 'case-dia', unit: 'mm', value: 40, status: 'pass' });
    expect(byId.width).toMatchObject({ unit: 'mm', status: 'pass' });
    // 3000 mm³ × 8000 kg/m³ = 0.024 kg.
    expect(byId.mass!.value).toBeCloseTo(0.024, 12);
    expect(byId.mass).toMatchObject({ unit: 'kg', status: 'pass' });
    expect(byId.vol).toEqual({ id: 'vol', unit: 'mm3', value: 3000, status: 'pass' });
    expect(byId.area).toEqual({ id: 'area', unit: 'mm2', value: 2100, status: 'pass' });
    const after = watch(16);
    const fixed = measureDesignTargets(after.doc, { meshes: after.meshes, bodies });
    expect(fixed.find((x) => x.id === 'lug-gap')).toMatchObject({ status: 'pass' });
    const report = designTargetReport(after.doc, fixed, 'SK-01');
    expect(report.summary).toEqual({ pass: 6, fail: 0, unknown: 0 });
    expect(report.targets[0]).toMatchObject({
      id: 'lug-gap',
      requirement: 'RQ-04',
      min: 15.9,
      max: 16.1,
      unit: 'mm',
      status: 'pass',
    });
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it('reports what it cannot measure now as unknown, never as a pass (TS-2501)', () => {
    const { doc, meshes } = watch(16);
    const reasons = (input: Parameters<typeof measureDesignTargets>[1], d = doc) =>
      Object.fromEntries(measureDesignTargets(d, input).map((x) => [x.id, x.reason ?? x.status]));
    // Not evaluated with the document's own build: only the parameter is known.
    expect(reasons({})).toEqual({
      'lug-gap': 'design-not-evaluated',
      'case-dia': 'design-not-evaluated',
      width: 'pass',
      mass: 'design-not-evaluated',
      vol: 'design-not-evaluated',
      area: 'design-not-evaluated',
    });
    // A lug not drawn (it failed), the case without a density, a sheet's volume.
    const noLug = meshes.filter((m) => m.bodyId !== 'lug-r');
    const light = {
      ...doc,
      bodies: doc.bodies.map((b) => (b.id === 'case' ? { ...b, mass: undefined } : b)),
    };
    const sheet: CadBodyEvaluation = {
      ...bodies.case,
      kind: 'sheet',
      freeEdges: 0,
      freeEdgeLengthMm: 0,
    };
    const r = reasons({ meshes: noLug, bodies: { ...bodies, case: sheet } }, light);
    expect(r['lug-gap']).toBe('design-body-missing');
    expect(r.mass).toBe('design-mass-left-out');
    expect(r.vol).toBe('design-volume-sheet');
    // The whole document's mass needs every body weighed.
    const whole: CadDocument = {
      ...doc,
      designTargets: [{ id: 'm', name: 'Mass', measure: { kind: 'mass' }, max: 1 }],
    };
    const mass = { massKg: 0.5, items: [], leftOut: [] };
    expect(reasons({ mass }, whole)).toEqual({ m: 'pass' });
    expect(
      reasons(
        {
          mass: { ...mass, leftOut: [{ path: [], bodyId: 'x', name: 'x', code: 'mass-missing' }] },
        },
        whole,
      ),
    ).toEqual({ m: 'design-mass-left-out' });
    // A proportion needs the proportion setup.
    const prop: CadDocument = {
      ...doc,
      designTargets: [
        {
          id: 'p',
          name: 'Width/height',
          measure: { kind: 'proportion', metric: 'widthToHeight' },
          min: 1,
        },
      ],
    };
    expect(reasons({ meshes }, prop)).toEqual({ p: 'design-proportion-missing' });
    expect(
      reasons({ meshes }, { ...prop, proportions: defaultProportions({ body: ['case'] }) }),
    ).toEqual({
      p: 'pass',
    });
  });

  it('stores the targets in the document: validated, removed when empty, pruned with a body (TS-2502)', () => {
    const doc = f11Bracket();
    const id = doc.bodies[0]!.id;
    const targets: CadDesignTarget[] = [
      {
        id: 't1',
        name: 'Width',
        requirement: 'RQ-01',
        measure: { kind: 'parameter', parameterId: 'W' },
        max: 100,
      },
      { id: 't2', name: 'Size', measure: { kind: 'extent', bodyIds: [id], axis: 'z' }, min: 1 },
    ];
    const set = applyCadOperation(doc, { type: 'setDesignTargets', targets });
    expect(set.designTargets).toEqual(targets);
    expect(codes(set)).toEqual([]);
    expect(compareCad(doc, set).map((c) => c.path)).toEqual(['designTargets']);
    expect(() => applyCadOperation(set, { type: 'setDesignTargets', targets })).toThrow(
      'design-targets-unchanged',
    );
    expect(
      applyCadOperation(set, { type: 'setDesignTargets', targets: [] }).designTargets,
    ).toBeUndefined();
    // The body's target goes with it; the parameter's stays.
    const gone = applyCadOperation(set, { type: 'deleteClosure', ids: [id], cascade: true });
    expect(gone.designTargets?.map((t) => t.id)).toEqual(['t1']);
    // A list keeps its other bodies; a removed parameter takes its target.
    const two: CadDocument = {
      ...set,
      designTargets: [
        { id: 'd', name: 'Gap', measure: { kind: 'distance', a: ['x', 'y'], b: ['z'] }, min: 1 },
        ...targets,
      ],
    };
    pruneDesignTargets(two, new Set(['x']), new Set(['W']));
    expect(two.designTargets).toEqual([
      { id: 'd', name: 'Gap', measure: { kind: 'distance', a: ['y'], b: ['z'] }, min: 1 },
      targets[1],
    ]);
    pruneDesignTargets(two, new Set(['z', id]));
    expect(two.designTargets).toBeUndefined();
  });

  it('refuses unknown bodies and parameters, bad bands and bad measures (TS-2502)', () => {
    const doc = f11Bracket();
    const id = doc.bodies[0]!.id;
    const at = '$.designTargets[0]';
    const withT = (t: unknown) => ({ ...doc, designTargets: [t] }) as unknown as CadDocument;
    const base = {
      id: 't',
      name: 'T',
      measure: { kind: 'extent', bodyIds: [id], axis: 'x' },
      min: 1,
    };
    expect(codes(withT(base))).toEqual([]);
    expect(codes({ ...doc, designTargets: [] })).toEqual(['design-targets@$.designTargets']);
    expect(codes(withT({ id: base.id, name: base.name, measure: base.measure }))).toEqual([
      `design-target-band@${at}`,
    ]);
    expect(codes(withT({ ...base, min: 2, max: 1 }))).toEqual([`design-target-band@${at}.max`]);
    expect(codes(withT({ ...base, requirement: ' ' }))).toEqual([
      `design-target-requirement@${at}.requirement`,
    ]);
    expect(
      codes(withT({ ...base, measure: { kind: 'extent', bodyIds: ['ghost'], axis: 'x' } })),
    ).toEqual([`design-target-body@${at}.measure.bodyIds[0]`]);
    expect(
      codes(withT({ ...base, measure: { kind: 'extent', bodyIds: [id, id], axis: 'w' } })),
    ).toEqual([
      `design-target-body-twice@${at}.measure.bodyIds[1]`,
      `design-target-axis@${at}.measure.axis`,
    ]);
    expect(codes(withT({ ...base, measure: { kind: 'distance', a: [id], b: [id] } }))).toEqual([
      `design-target-distance-same@${at}.measure`,
    ]);
    expect(codes(withT({ ...base, measure: { kind: 'parameter', parameterId: 'nope' } }))).toEqual([
      `design-target-parameter@${at}.measure.parameterId`,
    ]);
    expect(codes(withT({ ...base, measure: { kind: 'proportion', metric: 'nope' } }))).toEqual([
      `design-target-metric@${at}.measure.metric`,
    ]);
    expect(codes(withT({ ...base, measure: { kind: 'speed' } }))).toEqual([
      `design-target-measure@${at}.measure`,
    ]);
    expect(codes({ ...doc, designTargets: [base, base] })).toEqual([
      'duplicate-id@$.designTargets[1].id',
    ]);
  });
});

describe('F150 lug targets', () => {
  it('validates, its lug target over the two lug bodies (TS-2503)', () => {
    const doc = f150LugTargets();
    expect(codes(doc)).toEqual([]);
    expect(doc.designTargets?.map((t) => t.id)).toEqual([
      'lug-width',
      'case-diameter',
      'case-mass',
    ]);
    expect(codes(f150LugTargets(undefined, 16))).toEqual([]);
  });
});
