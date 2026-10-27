import { describe, expect, it } from 'vitest';
import {
  CadBuildError,
  applyCadOperation,
  cadBuilder,
  cadLimits,
  emptyCad,
  f40Car,
  f41,
  f41ArchTop,
  f41Bridge,
  f41Hangers,
  f42Airliner,
  fixtureKernel,
  parameterValues,
  resolveLength,
  resolvePosition,
  validateCad,
  type CadDocument,
} from './index';

const errors = (doc: unknown) => validateCad(doc).filter((d) => d.severity === 'error');
const active = (doc: CadDocument) => doc.bodies.filter((b) => b.state === 'active');
const hanger = (doc: CadDocument, id: string) => {
  const f = doc.features.find((x) => x.id === `${id}-cylinder`);
  if (f?.type !== 'cylinder') throw new Error(id);
  const values = parameterValues(doc);
  return {
    height: resolveLength(f.args.height, values),
    base: resolvePosition(f.args.origin, values)[2],
  };
};

describe('O1 builder (CM-8)', () => {
  it('builds F40–F42 as valid schema 2 documents that survive native JSON (ST-91 #1)', () => {
    for (const build of [f40Car, f41Bridge, f42Airliner]) {
      const doc = build();
      expect(doc.schemaVersion).toBe(2);
      expect(errors(doc)).toEqual([]);
      // The native import reads JSON text and validates it as it is.
      expect(errors(JSON.parse(JSON.stringify(doc)))).toEqual([]);
      expect(active(doc).length).toBeLessThanOrEqual(cadLimits.bodies);
    }
    const car = f40Car();
    expect(active(car).map((b) => b.name)).toEqual([
      'Body',
      'Glass',
      'Wheel FL',
      'Wheel FR',
      'Wheel RL',
      'Wheel RR',
      'Headlight 1',
      'Headlight 2',
      'Tail lights',
    ]);
    const bridge = f41Bridge();
    // F41: more than 55 bodies, most consumed by the Booleans and patterns.
    expect(bridge.bodies.length).toBeGreaterThan(55);
    expect(active(bridge).map((b) => b.name)).toEqual([
      'Arches',
      'Deck',
      'Railing 1',
      'Railing 2',
      'River',
    ]);
    expect(active(f42Airliner()).map((b) => b.name)).toEqual([
      'Airframe',
      'Wing',
      'Stabiliser',
      'Fin',
      'Engine 1',
      'Engine 2',
      'Windows',
      'Windscreen',
    ]);
  });

  it('F41: changing the deck height changes every hanger length by expression (ST-91 #2)', () => {
    const doc = f41Bridge();
    const stations = f41Hangers();
    const ids = ['n', 's'].flatMap((side) => stations.map((_, k) => `hanger-${side}${k + 1}`));
    expect(ids.length).toBe(2 * stations.length);
    const before = ids.map((id) => hanger(doc, id));
    stations.forEach((x, k) => {
      expect(before[k]!.base).toBe(f41.deckHeight - 500);
      expect(before[k]!.height).toBeCloseTo(f41ArchTop(x) + 500 - f41.deckHeight, 0);
    });
    const lowered = applyCadOperation(doc, {
      type: 'setParameter',
      parameterId: 'deck-height',
      value: f41.deckHeight - 2000,
    });
    ids.forEach((id, i) => {
      const after = hanger(lowered, id);
      // The base moves down with the deck and the top stays on the arch.
      expect(after.base).toBe(before[i]!.base - 2000);
      expect(after.height).toBe(before[i]!.height + 2000);
    });
    // A different number of hangers is a different document, built again.
    expect(
      lowered.features.filter((f) => f.type === 'cylinder' && f.name.startsWith('Hanger ')).length,
    ).toBe(ids.length);
  });

  it('F40: the rear arch and wheels follow the rear axle parameter', () => {
    const doc = applyCadOperation(f40Car(), {
      type: 'setParameter',
      parameterId: 'rear-axle-x',
      value: 3400,
    });
    const values = parameterValues(doc);
    const arch = doc.features.find((f) => f.id === 'arch-2-cylinder');
    const tyre = doc.sketches.find((s) => s.id === 'tyre-rl');
    if (arch?.type !== 'cylinder' || !tyre || !('origin' in tyre.plane)) throw new Error('fixture');
    expect(resolvePosition(arch.args.origin, values)[0]).toBe(3400);
    expect(resolvePosition(tyre.plane.origin, values)[0]).toBe(3400);
  });

  it('returns the operations it applied: replaying them gives the same document (ST-91 #3)', () => {
    const b = cadBuilder(fixtureKernel);
    b.parameter('W', 'length', 80);
    const plate = b.box('Plate', { size: ['{W}', 50, 5] });
    const hole = b.cylinder('Hole', { radius: 5, height: 7, origin: ['{W} / 2', 25, -1] });
    b.boolean(plate, [hole], 'cut', 'Hole cut');
    b.setParameter('W', 100);
    const { document, operations } = b.build();
    expect(operations.map((o) => o.type)).toEqual([
      'insertFeatures',
      'insertFeatures',
      'insertFeatures',
      'booleanBodies',
      'rename',
      'setParameter',
    ]);
    expect(operations.reduce(applyCadOperation, emptyCad(fixtureKernel))).toEqual(document);
    expect(document.features.find((f) => f.id === 'hole-cut')?.name).toBe('Hole cut');
    expect(document.bodies.find((x) => x.id === 'hole')).toMatchObject({
      state: 'consumed',
      consumedByFeatureId: 'hole-cut',
    });
  });

  it('IDs come from names and are numbered when a name repeats', () => {
    const b = cadBuilder(fixtureKernel);
    expect([
      b.box('Post', { size: [1, 1, 1] }),
      b.box('Post', { size: [1, 1, 1] }),
      b.box('Støtte 1', { size: [1, 1, 1] }),
    ]).toEqual(['post', 'post-2', 'støtte-1']);
    expect(b.document.bodies.map((x) => x.resultFeatureId)).toEqual([
      'post-placement',
      'post-2-placement',
      'støtte-1-placement',
    ]);
    // Reserved keys are never IDs: the name stays, the ID is numbered.
    expect([
      b.box('Prototype', { size: [1, 1, 1] }),
      b.box('constructor', { size: [1, 1, 1] }),
    ]).toEqual(['prototype-2', 'constructor-2']);
    expect(b.document.bodies.find((x) => x.id === 'prototype-2')?.name).toBe('Prototype');
  });

  it('a refused step names its number, what it built and the code, and changes nothing (ST-91 #4)', () => {
    const b = cadBuilder(fixtureKernel);
    b.parameter('W', 'length', 80);
    const plate = b.box('Plate', { size: ['{W}', 50, 5] });
    const before = b.document;
    const caught = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return e;
      }
      throw new Error('not refused');
    };
    const unknown = caught(() => b.box('Bar', { size: ['{Width}', 1, 1] }));
    expect(unknown).toBeInstanceOf(CadBuildError);
    expect(unknown).toMatchObject({
      step: 3,
      what: 'expression "{Width}"',
      code: 'expression-name-unknown@0',
    });
    const missing = caught(() => b.boolean(plate, ['nothing'], 'cut'));
    expect(missing).toMatchObject({ step: 3, what: 'cut "plate"' });
    expect((missing as Error).message).toMatch(/^step 3 \(cut "plate"\): /);
    // An angle where a length belongs is refused by the same validation as an edit.
    expect(caught(() => b.box('Odd', { size: ['90deg', 1, 1] }))).toMatchObject({
      step: 3,
      what: 'body "Odd"',
    });
    expect(b.document).toBe(before);
    expect(b.build().operations).toHaveLength(2);
  });
  it('a named Boolean or pattern is one step: a refused name changes nothing and frees its IDs', () => {
    const b = cadBuilder(fixtureKernel);
    const plate = b.box('Plate', { size: [80, 50, 5] });
    const hole = b.cylinder('Hole', { radius: 5, height: 7, origin: [40, 25, -1] });
    const before = b.document;
    expect(() => b.boolean(plate, [hole], 'cut', 'Bad\u0007name')).toThrow(CadBuildError);
    expect(() =>
      b.pattern(
        plate,
        hole,
        { type: 'linear', direction: [1, 0, 0], count: 2, spacing: 10 },
        'cut',
        'x'.repeat(300),
      ),
    ).toThrow(CadBuildError);
    expect(b.document).toBe(before);
    expect(b.build().operations).toHaveLength(2);
    // The tool is still active, and the IDs the refused step took are free again.
    expect(b.boolean(plate, [hole], 'cut', 'Hole cut')).toBe('hole-cut');
    expect(b.document.features.find((f) => f.id === 'hole-cut-placement')).toBeDefined();
  });

  it('counts a named Boolean as one step in a later refusal', () => {
    const b = cadBuilder(fixtureKernel);
    const plate = b.box('Plate', { size: [80, 50, 5] });
    const hole = b.cylinder('Hole', { radius: 5, height: 7, origin: [40, 25, -1] });
    b.boolean(plate, [hole], 'cut', 'Hole cut');
    expect(b.build().operations).toHaveLength(4);
    let refused: unknown;
    try {
      b.box('Bad', { size: [0, 10, 10] });
    } catch (e) {
      refused = e;
    }
    expect(refused).toMatchObject({ step: 4, what: 'body "Bad"' });
  });

  it('keeps a copy of each operation: changing an input afterwards changes neither result', () => {
    const b = cadBuilder(fixtureKernel);
    const orientation: [number, number, number, number] = [0, 0, 0, 1];
    const size: [number, number, number] = [10, 10, 10];
    b.box('A', { size, orientation });
    orientation[2] = Math.SQRT1_2;
    orientation[3] = Math.SQRT1_2;
    size[0] = 99;
    b.box('B', { size, orientation });
    const { document, operations } = b.build();
    expect(operations.reduce(applyCadOperation, emptyCad(fixtureKernel))).toEqual(document);
    const a = document.features.find((f) => f.id === 'a-box');
    if (a?.type !== 'box') throw new Error('a');
    expect(a.args.orientation).toEqual([0, 0, 0, 1]);
    expect(a.args.size[0]).toEqual({ literalMm: 10 });
  });

  it('solves a sketch by its constraints, so a pattern path follows a parameter (ST-104 #1)', () => {
    const b = cadBuilder(fixtureKernel);
    b.parameter('H', 'length', 1000);
    // An arc whose centre, start and reach are tied to {H}; its seed points are deliberately off.
    const path = b.sketch(
      'Ridge',
      {},
      { c: [0, 0], e0: [10, 0], e1: [500, 800] },
      [{ type: 'arc', id: 'ridge', center: 'c', start: 'e0', end: 'e1', clockwise: false }],
      {
        constraints: [
          { id: 'fix-c', type: 'fix', point: 'c', at: [0, '{H} * -0.1'] },
          { id: 'fix-e0', type: 'fix', point: 'e0', at: ['{H}', '{H} * -0.1'] },
          { id: 'reach', type: 'horizontalDistance', a: 'c', b: 'e1', value: '{H} * 0.6' },
        ],
      },
    );
    const at = (p: string) => b.document.sketches.find((s) => s.id === path)!.solved[p]!;
    const near = (p: string, u: number, v: number) => {
      expect(at(p)[0]).toBeCloseTo(u, 6);
      expect(at(p)[1]).toBeCloseTo(v, 6);
    };
    // Solved on insert: the arc has radius {H} about (0, -0.1 {H}).
    near('c', 0, -100);
    near('e0', 1000, -100);
    near('e1', 600, 700);
    b.setParameter('H', 2000);
    near('c', 0, -200);
    near('e0', 2000, -200);
    near('e1', 1200, 1400);
    const c = b.document.sketches.find((s) => s.id === path)!.constraints;
    expect(c[0]).toMatchObject({ type: 'fix', at: [{ literalMm: 0 }, { expression: {} }] });
    expect(c[2]).toMatchObject({ type: 'horizontalDistance', value: { expression: {} } });
    // Constraints that cannot all hold are refused as the step that inserts them.
    expect(() =>
      b.sketch(
        'Bad',
        {},
        { a: [0, 0], b: [10, 0] },
        [{ type: 'line', id: 'l', start: 'a', end: 'b' }],
        {
          constraints: [
            { id: 'one', type: 'distance', a: 'a', b: 'b', value: 10 },
            { id: 'two', type: 'distance', a: 'a', b: 'b', value: 20 },
          ],
        },
      ),
    ).toThrow(CadBuildError);
  });
});
