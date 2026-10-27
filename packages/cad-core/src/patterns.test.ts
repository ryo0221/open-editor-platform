import { describe, expect, it } from 'vitest';
import {
  applyCadOperation,
  assertCadOperation,
  cadBuilder,
  cadContentHash,
  cadEditorCommand,
  cadPatternCopies,
  dependencyOrder,
  duplicateClosureOf,
  f01Empty,
  f41Bridge,
  fixtureKernel,
  k5aBars,
  featureReads,
  f14Patterns,
  identityQuaternion,
  mm,
  pathPlacements,
  position,
  remapTopoName,
  sketchPath,
  validateCad,
  type CadDocument,
  type CadFeature,
} from './index';

const codes = (doc: unknown) => validateCad(doc).map((d) => `${d.code}@${d.path}`);
const at = (doc: CadDocument, id: string) => doc.features.findIndex((f) => f.id === id);
/** `doc` with feature `id`'s args changed, as validation codes. */
const change = (doc: CadDocument, id: string, edit: (a: Record<string, unknown>) => void) => {
  const copy = structuredClone(doc);
  edit(copy.features[at(copy, id)]!.args as never);
  return codes(copy);
};

describe('pattern and mirror (R1c, CAD32)', () => {
  it('validates F14 and consumes the patterned tool in one command', () => {
    for (const kind of ['linear', 'circular', 'twice', 'mirror'] as const)
      expect(validateCad(f14Patterns(kind)), kind).toEqual([]);
    const doc = f14Patterns('linear');
    expect(doc.features[at(doc, 'row')]!.inputFeatureIds).toEqual([
      'part-placement',
      'hole-placement',
    ]);
    expect(doc.bodies.find((b) => b.id === 'part')).toMatchObject({
      resultFeatureId: 'row-placement',
    });
    expect(doc.bodies.find((b) => b.id === 'hole')).toMatchObject({
      state: 'consumed',
      consumedByFeatureId: 'row',
    });
    const op = {
      type: 'patternBodies' as const,
      targetId: 'part',
      toolId: 'part',
      mode: 'cut' as const,
      layout: {
        type: 'linear' as const,
        direction: [1, 0, 0],
        count: { literal: 2 },
        spacing: mm(5),
      },
      patternFeatureId: 'p',
      placementFeatureId: 'pp',
    };
    assertCadOperation(op);
    expect(() => applyCadOperation(doc, op)).toThrow('boolean-same-body');
    // The tool is consumed already.
    expect(() => applyCadOperation(doc, { ...op, toolId: 'hole' })).toThrow('body-consumed');
    const command = cadEditorCommand(
      { ...op, toolId: 'hole' },
      { expectedHash: cadContentHash(doc), canEdit: () => true },
    );
    expect(command.label).toBe('Pattern body');
  });

  it('refuses malformed layouts, counts and mirror planes', () => {
    const doc = f14Patterns('linear');
    const layout = `$.features[${at(doc, 'row')}].args.layout`;
    const row = (edit: (l: Record<string, unknown>) => void) =>
      change(doc, 'row', (a) => edit(a.layout as Record<string, unknown>));
    expect(change(doc, 'row', (a) => (a.mode = 'common'))).toEqual([
      `pattern-mode@$.features[${at(doc, 'row')}].args.mode`,
    ]);
    expect(row((l) => (l.type = 'grid'))).toEqual([`pattern-layout@${layout}`]);
    expect(row((l) => (l.direction = [0, 0, 2]))).toEqual([
      `pattern-direction@${layout}.direction`,
    ]);
    expect(row((l) => (l.count = { literal: 0 }))).toEqual([`count-range@${layout}.count`]);
    expect(row((l) => (l.count = { literal: 1.5 }))).toEqual([`count-range@${layout}.count`]);
    expect(row((l) => (l.count = { parameterId: 'W' }))).toEqual([
      `parameter-type@${layout}.count`,
    ]);
    const circular = f14Patterns('circular');
    expect(
      change(
        circular,
        'row',
        (a) => ((a.layout as { axisDirection: unknown }).axisDirection = [0, 1, 1]),
      ),
    ).toEqual([`pattern-direction@$.features[${at(circular, 'row')}].args.layout.axisDirection`]);
    const mirror = f14Patterns('mirror');
    const m1 = `$.features[${at(mirror, 'm1')}].args`;
    expect(
      change(mirror, 'm1', (a) => ((a.plane as { normal: unknown }).normal = [1, 1, 0])),
    ).toEqual([`mirror-normal@${m1}.plane.normal`]);
    expect(change(mirror, 'm1', (a) => (a.union = 'yes'))).toEqual([`mirror-union@${m1}.union`]);
  });

  it('counts pattern copies across the document: 4,096 pass, 4,097 do not', () => {
    const counts = [1000, 1000, 1000, 1000, 96];
    const cylinder = (id: string): CadFeature => ({
      id,
      name: id,
      type: 'cylinder',
      inputFeatureIds: [],
      args: {
        radius: mm(1),
        height: mm(1),
        origin: position(0, 0, 0),
        orientation: identityQuaternion(),
      },
    });
    const body = (id: string) => ({
      id: `${id}-body`,
      name: id,
      sourceFeatureId: id,
      placementFeatureId: `${id}-placement`,
      appearance: { color: '#9aa4b1', opacity: 1 },
    });
    const tools = counts.map((_, i) => `t${i}`);
    let doc = applyCadOperation(f01Empty(), {
      type: 'insertFeatures',
      features: [cylinder('base'), ...tools.map(cylinder)],
      bodies: [body('base'), ...tools.map(body)],
    });
    tools.forEach((toolId, i) => {
      doc = applyCadOperation(doc, {
        type: 'patternBodies',
        targetId: 'base-body',
        toolId: `${toolId}-body`,
        mode: 'union',
        layout: {
          type: 'linear',
          direction: [1, 0, 0],
          count: { literal: counts[i]! },
          spacing: mm(1),
        },
        patternFeatureId: `p${i}`,
        placementFeatureId: `p${i}-placement`,
      });
    });
    expect(counts.reduce((a, b) => a + b)).toBe(cadPatternCopies);
    expect(codes(doc)).toEqual([]);
    expect(
      change(doc, 'p4', (a) => ((a.layout as { count: unknown }).count = { literal: 97 })),
    ).toEqual(['limit-pattern-copies@$.features']);
  });

  it('renames pattern and mirror IDs inside duplicated references', () => {
    const doc = f14Patterns('twice');
    const { ids } = duplicateClosureOf(doc, ['part']);
    const idMap = Object.fromEntries(ids.map((id) => [id, `copy-${id}`]));
    const copy = applyCadOperation(doc, { type: 'duplicateClosure', bodyIds: ['part'], idMap });
    expect(validateCad(copy)).toEqual([]);
    const rim = copy.features.find((f) => f.id === 'copy-rim') as Extract<
      CadFeature,
      { type: 'fillet' }
    >;
    expect(rim.args.edges[0]!.name).toEqual([['+z'], ['copy:copy-row-2:1', 'side']]);
    // An ID may hold `:`; the copy index after the last one is never part of it.
    expect(
      remapTopoName(
        [
          ['copy:a:b:3', 'side'],
          ['mirror:m1', '+x'],
        ],
        { 'a:b': 'c', m1: 'n' },
      ),
    ).toEqual([
      ['copy:c:3', 'side'],
      ['mirror:n', '+x'],
    ]);
  });
});

describe('pattern along a sketch path (K5a, CM-7b)', () => {
  /** A bar patterned onto a plate along a 100 mm line and a quarter arc of radius 50. */
  const along = () => {
    const doc = k5aBars(fixtureKernel, true);
    const wave = cadBuilder(fixtureKernel);
    wave.sketch(
      'Wave',
      { origin: [0, 0, 0] },
      { q0: [0, 0], q1: [30, 40], q2: [70, -40], q3: [100, 0] },
      [{ type: 'spline', id: 's', poles: ['q0', 'q1', 'q2', 'q3'], degree: 3 }],
    );
    doc.sketches.push(...wave.document.sketches);
    const id = doc.features.find((f) => f.type === 'pattern')!.id;
    return { doc, id, path: doc.sketches[0]!.id };
  };

  it('places copies at equal distances along lines and arcs, with the direction there', () => {
    const { doc, path } = along();
    const g = sketchPath(doc.sketches.find((s) => s.id === path)!, ['l', 'a']);
    if ('code' in g) throw new Error(g.code);
    const length = 100 + 25 * Math.PI;
    const [p0, p1, p2] = pathPlacements(g, 3)!;
    expect(p0).toEqual({ at: [0, 0], angle: 0 });
    expect(p1!.at[0]).toBeCloseTo(length / 2, 9);
    expect(p1!.at[1]).toBeCloseTo(0, 9);
    expect(p2!.at[0]).toBeCloseTo(150, 9);
    expect(p2!.at[1]).toBeCloseTo(50, 9);
    expect(p2!.angle).toBeCloseTo(Math.PI / 2, 9);
    // Walked from the other end, and one copy: the start.
    const back = sketchPath(doc.sketches.find((s) => s.id === path)!, ['a', 'l']);
    if ('code' in back) throw new Error(back.code);
    const [q0, , q2] = pathPlacements(back, 3)!;
    expect(q0!.at.map((x) => +x.toFixed(9))).toEqual([150, 50]);
    expect(q0!.angle).toBeCloseTo(-Math.PI / 2, 9);
    expect(q2!.at.map((x) => +x.toFixed(9))).toEqual([0, 0]);
    expect(q2!.angle).toBeCloseTo(Math.PI, 9);
    expect(pathPlacements(g, 1)).toEqual([{ at: [0, 0], angle: 0 }]);
  });

  it('validates the layout and reads the path sketch', () => {
    const { doc, id, path } = along();
    expect(codes(doc)).toEqual([]);
    expect(codes(f41Bridge(undefined, { lamps: true }))).toEqual([]);
    const lp = `$.features[${at(doc, id)}].args.layout`;
    const layout = (edit: (l: Record<string, unknown>) => void) =>
      change(doc, id, (a) => edit(a.layout as Record<string, unknown>));
    expect(layout((l) => (l.align = 'yes'))).toEqual([`pattern-align@${lp}.align`]);
    expect(layout((l) => ((l.path as { elements: string[] }).elements = ['l', 'l']))).toEqual([
      `sweep-path-element@${lp}.path.elements[1]`,
    ]);
    const spline = change(doc, id, (a) => {
      (a.layout as { path: unknown }).path = { sketchId: doc.sketches[1]!.id, elements: ['s'] };
    });
    expect(spline).toEqual([`pattern-path@${lp}.path.elements[0]`]);
    expect(change(doc, id, (a) => ((a.layout as Record<string, unknown>).spacing = mm(1)))).toEqual(
      [`unknown-field@${lp}.spacing`],
    );
    // The path's sketch comes first, and deleting it takes the pattern with it.
    const pattern = doc.features[at(doc, id)]!;
    expect(featureReads(pattern).sketches).toEqual([path]);
    const order = dependencyOrder(doc);
    if (!('order' in order)) throw new Error('cycle');
    expect(order.order.indexOf(path)).toBeLessThan(order.order.indexOf(id));
    expect(() =>
      applyCadOperation(doc, { type: 'deleteClosure', ids: [path], cascade: false }),
    ).toThrow('delete-has-dependents');
  });
});
