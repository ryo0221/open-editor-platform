import { EditorSession } from '@editor-platform/editor-core';
import { contentHash } from '@editor-platform/artifact-core';
import { describe, expect, it } from 'vitest';
import {
  applyCadOperation,
  assertCadOperation,
  cadContentHash,
  cadEditorCommand,
  compareCad,
  evaluationOrder,
  f01Empty,
  f02Plate,
  f02Volume,
  f03Revolve,
  f05Dependencies,
  identityQuaternion,
  mm,
  parameterValues,
  position,
  resolvePosition,
  validateCad,
  type CadDocument,
  type CadOperation,
} from './index';

const codes = (doc: unknown) => validateCad(doc).map((d) => d.code);
/** Untyped JSON view, for constructing documents the types would forbid. */
type Loose = ReturnType<typeof JSON.parse>;
const mutate = (doc: CadDocument, edit: (d: Loose) => void) => {
  const copy: Loose = structuredClone(doc);
  edit(copy);
  return copy;
};
const holeX = (doc: CadDocument) => {
  const hole = doc.features.find((f) => f.id === 'hole-cylinder')!;
  if (hole.type !== 'cylinder') throw new Error('fixture');
  return resolvePosition(hole.args.origin, parameterValues(doc))[0];
};
const session = (doc: CadDocument) => new EditorSession(doc);
const exec = (s: EditorSession<CadDocument>, op: CadOperation, canEdit = () => true) =>
  s.execute(cadEditorCommand(op, { expectedHash: cadContentHash(s.content), canEdit }));

describe('cad-core fixtures and validation', () => {
  it('accepts F01–F05 and keeps a stable evaluation order', () => {
    for (const doc of [
      f01Empty(),
      f02Plate(),
      f02Plate('edge'),
      f02Plate('literal'),
      f03Revolve(),
      f05Dependencies(),
    ])
      expect(validateCad(doc)).toEqual([]);
    const plate = f02Plate();
    expect(evaluationOrder(plate.features)).toEqual(evaluationOrder([...plate.features].reverse()));
    expect(plate.bodies.map((b) => [b.id, b.state])).toEqual([
      ['plate', 'active'],
      ['hole', 'consumed'],
    ]);
  });

  it('matches artifact-core contentHash', async () => {
    const doc = f02Plate();
    expect(cadContentHash(doc)).toBe(await contentHash(doc));
  });

  it('F02 hole follows 0.5W and W−10, literal stays, IDs are preserved (CAD18)', () => {
    const cases = [
      ['center', 40, 50],
      ['edge', 70, 90],
      ['literal', 40, 40],
    ] as const;
    for (const [mode, before, after] of cases) {
      const doc = f02Plate(mode);
      expect(holeX(doc)).toBe(before);
      const next = applyCadOperation(doc, { type: 'setParameter', parameterId: 'W', value: 100 });
      expect(holeX(next)).toBe(after);
      expect(next.features.map((f) => f.id)).toEqual(doc.features.map((f) => f.id));
    }
    expect(f02Volume(80)).toBeCloseTo(20000 - 125 * Math.PI, 9);
    expect(f02Volume(100)).toBeCloseTo(25000 - 125 * Math.PI, 9);
  });

  it('rejects malformed input from unknown (F04, CAD01)', () => {
    const plate = f02Plate();
    const poly = (vertices: [number, number][]) =>
      mutate(plate, (d) => {
        d.profiles[0].shape = {
          type: 'polyline',
          vertices: vertices.map(([u, v], i) => ({ id: `v${i}`, u: mm(u), v: mm(v) })),
        };
      });
    const cases: [unknown, string][] = [
      [{ ...f01Empty(), schemaVersion: 2 }, 'unsupported-schema'],
      [mutate(plate, (d) => (d.extra = 1)), 'unknown-field'],
      [mutate(plate, (d) => (d.parameters[0].value = Number.NaN)), 'number'],
      [mutate(plate, (d) => (d.parameters[0].value = 0)), 'dimension-range'],
      [mutate(plate, (d) => (d.parameters[2].value = -5)), 'dimension-range'],
      [mutate(plate, (d) => (d.features[0].args.profileId = 'nope')), 'profile-missing'],
      [mutate(plate, (d) => (d.features[2].inputFeatureIds = ['missing'])), 'feature-missing'],
      [mutate(plate, (d) => (d.parameters[1].id = 'W')), 'duplicate-id'],
      [mutate(plate, (d) => (d.features[0].type = 'imported')), 'feature-unsupported'],
      [mutate(plate, (d) => (d.features[0].type = 'loft')), 'feature-type'],
      [mutate(plate, (d) => d.assets.push({})), 'assets-unsupported'],
      [mutate(plate, (d) => (d.kernelProfile.linearToleranceMm = 0.001)), 'kernel-tolerance'],
      [mutate(plate, (d) => (d.parameters[0].type = 'angle')), 'parameter-type'],
      [
        mutate(plate, (d) => (d.features[1].args.origin[0].affine.scale = 2_000_000)),
        'affine-scale',
      ],
      [
        mutate(
          plate,
          (d) =>
            (d.features[1].args.origin[0] = {
              affine: { parameterId: 'W', scale: 0.5, offsetMm: 0, extra: 1 },
            }),
        ),
        'unknown-field',
      ],
      [
        poly([
          [0, 0],
          [10, 10],
          [10, 0],
          [0, 10],
        ]),
        'polyline-self-intersection',
      ],
      [
        poly([
          [0, 0],
          [10, 0],
          [10, 0],
          [0, 10],
        ]),
        'polyline-degenerate-edge',
      ],
      [
        poly([
          [0, 0],
          [10, 0],
          [20, 0],
        ]),
        'profile-zero-area',
      ],
      [mutate(plate, (d) => (d.bodies[0].state = 'hidden')), 'body-state'],
      [
        mutate(plate, (d) => (d.bodies[1].consumedByFeatureId = 'plate-extrude')),
        'body-consumed-by',
      ],
      [
        mutate(plate, (d) => (d.bodies[0].resultFeatureId = 'plate-extrude')),
        'body-result-not-placement',
      ],
      [mutate(plate, (d) => (d.bodies[0].appearance.color = 'red')), 'appearance-color'],
    ];
    for (const [doc, code] of cases) expect(codes(doc), code).toContain(code);
    const cyclic = mutate(plate, (d) => (d.features[0].inputFeatureIds = []));
    cyclic.features[4].inputFeatureIds = ['plate-cut-placement', 'hole-placement'];
    expect(codes(cyclic)).toEqual(expect.arrayContaining(['feature-order']));
    const getter: Loose = structuredClone(plate);
    Object.defineProperty(getter, 'units', { get: () => 'mm', enumerable: true });
    expect(codes(getter)).toEqual(['json-value']);
  });

  it('checks quaternion norm, revolve axis side and Boolean inputs', () => {
    const ring = f03Revolve();
    const q = (n: number) => mutate(ring, (d) => (d.profiles[0].plane.orientation = [0, 0, 0, n]));
    expect(codes(q(1 + 0.9e-9))).toEqual([]);
    expect(codes(q(1 + 2e-9))).toContain('quaternion-norm');
    expect(codes(mutate(ring, (d) => (d.features[0].args.axisOrigin = [mm(2), mm(0)])))).toContain(
      'revolve-crosses-axis',
    );
    expect(codes(mutate(ring, (d) => (d.features[0].args.axisOrigin = [mm(0), mm(0)])))).toEqual(
      [],
    );
    expect(codes(mutate(ring, (d) => (d.features[0].args.angle = { literalRad: 0 })))).toContain(
      'angle-range',
    );
    expect(codes(mutate(ring, (d) => (d.features[0].args.axisDirection = [0, 2])))).toContain(
      'axis-norm',
    );
    const plate = f02Plate();
    expect(
      codes(
        mutate(
          plate,
          (d) => (d.features[4].inputFeatureIds = ['plate-placement', 'plate-placement']),
        ),
      ),
    ).toContain('boolean-same-input');
  });

  it('enforces entity, DAG depth and active-overlap limits', () => {
    expect(codes(f05Dependencies(126))).toEqual([]);
    expect(() => f05Dependencies(127)).toThrow('limit-dag-depth');
    const many = mutate(f01Empty(), (d) => {
      d.parameters = Array.from({ length: 513 }, (_, i) => ({
        id: `p${i}`,
        name: '',
        type: 'length',
        value: 1,
      }));
    });
    expect(codes(many)).toContain('limit-parameters');
    const overlap = mutate(f05Dependencies(1), (d) => {
      d.features.push({
        id: 'b2-placement',
        name: '',
        type: 'transform',
        inputFeatureIds: ['a-placement'],
        args: { translation: position(0, 0, 0), rotation: identityQuaternion() },
      });
      d.bodies.push({ ...d.bodies[1], id: 'b2', resultFeatureId: 'b2-placement' });
    });
    expect(codes(overlap)).toContain('body-active-overlap');
  });

  it('stays robust for far-away small profiles, huge input lists and long names', () => {
    const far = mutate(f02Plate(), (d) => {
      d.profiles[0].shape = {
        type: 'polyline',
        vertices: [
          [750000, 750000],
          [750000.005, 750000],
          [750000.005, 750000.005],
          [750000, 750000.005],
        ].map(([u, v], i) => ({ id: `v${i}`, u: mm(u), v: mm(v) })),
      };
    });
    expect(codes(far)).not.toContain('profile-zero-area');
    const wide = mutate(f02Plate(), (d) => {
      d.features[2].inputFeatureIds = Array.from({ length: 150_000 }, () => d.features[0].id);
    });
    expect(codes(wide)).toContain('feature-arity');
    const objectType = mutate(f02Plate(), (d) => {
      d.features[0].type = { toString: 0 };
    });
    expect(codes(objectType)).toContain('feature-type');
    const named = applyCadOperation(f05Dependencies(0), {
      type: 'rename',
      targetId: 'b',
      name: 'x'.repeat(256),
    });
    const combined = applyCadOperation(named, {
      type: 'booleanBodies',
      targetId: 'a',
      toolId: 'b',
      mode: 'union',
      booleanFeatureId: 'u',
      placementFeatureId: 'u-placement',
    });
    expect([...combined.features.find((f) => f.id === 'u')!.name]).toHaveLength(256);
  });
});

describe('cad-core commands', () => {
  it('applies one Undo entry per operation and keeps history on rejection (CAD03 core)', () => {
    const s = session(f02Plate());
    const before = s.content;
    exec(s, { type: 'setParameter', parameterId: 'W', value: 100 });
    expect(holeX(s.content)).toBe(50);
    expect(() => exec(s, { type: 'setParameter', parameterId: 'W', value: -1 })).toThrow(
      /dimension-range/,
    );
    expect(() =>
      exec(s, { type: 'setParameter', parameterId: 'W', value: 90 }, () => false),
    ).toThrow('permission-denied');
    const stale = cadEditorCommand(
      { type: 'setParameter', parameterId: 'W', value: 90 },
      { expectedHash: cadContentHash(before), canEdit: () => true },
    );
    expect(() => s.execute(stale)).toThrow('cad-base-mismatch');
    expect(holeX(s.content)).toBe(50);
    s.undo();
    expect(s.content).toEqual(before);
    expect(s.canUndo).toBe(false);
  });

  it('Boolean keeps the target ID, consumes the tool and updates views atomically (CAD19)', () => {
    let doc = f05Dependencies(0);
    doc = applyCadOperation(doc, {
      type: 'saveNamedView',
      view: {
        id: 'only-b',
        name: 'B',
        bodyIds: ['b'],
        camera: { position: [0, -100, 50], target: [0, 0, 0], up: [0, 0, 1] },
        projection: { type: 'perspective', fovRad: 0.8 },
      },
    });
    doc = applyCadOperation(doc, {
      type: 'saveNamedView',
      view: {
        id: 'both',
        name: 'All',
        bodyIds: ['a', 'b'],
        camera: { position: [0, -100, 50], target: [0, 0, 0], up: [0, 0, 1] },
        projection: { type: 'orthographic', spanMm: 100 },
      },
    });
    const s = session(doc);
    exec(s, {
      type: 'booleanBodies',
      targetId: 'a',
      toolId: 'b',
      mode: 'union',
      booleanFeatureId: 'u',
      placementFeatureId: 'u-placement',
    });
    const after = s.content;
    expect(after.bodies.find((b) => b.id === 'a')).toMatchObject({
      state: 'active',
      resultFeatureId: 'u-placement',
    });
    expect(after.bodies.find((b) => b.id === 'b')).toMatchObject({
      state: 'consumed',
      consumedByFeatureId: 'u',
    });
    expect(after.namedViews.map((v) => [v.id, v.bodyIds])).toEqual([['both', ['a']]]);
    expect(() =>
      exec(s, {
        type: 'booleanBodies',
        targetId: 'a',
        toolId: 'b',
        mode: 'cut',
        booleanFeatureId: 'x',
        placementFeatureId: 'y',
      }),
    ).toThrow('body-consumed');
    s.undo();
    expect(s.content).toEqual(doc);
  });

  it('moves a body by updating its placement only (CAD20 core)', () => {
    const s = session(f03Revolve());
    const count = s.content.features.length;
    for (let i = 0; i < 100; i++)
      exec(s, {
        type: 'transformBody',
        bodyId: 'ring',
        translation: position(i, 0, 0),
        rotation: identityQuaternion(),
      });
    expect(s.content.features).toHaveLength(count);
    const plate = f02Plate();
    expect(() =>
      applyCadOperation(plate, {
        type: 'transformBody',
        bodyId: 'hole',
        translation: position(1, 0, 0),
        rotation: identityQuaternion(),
      }),
    ).toThrow('body-consumed');
    const bound = applyCadOperation(plate, {
      type: 'transformBody',
      bodyId: 'plate',
      translation: [{ parameterId: 'W' }, mm(0), mm(0)],
      rotation: identityQuaternion(),
    });
    expect(() =>
      applyCadOperation(bound, {
        type: 'transformBody',
        bodyId: 'plate',
        translation: position(5, 0, 0),
        rotation: identityQuaternion(),
      }),
    ).toThrow('placement-bound');
    expect(() =>
      applyCadOperation(bound, {
        type: 'transformBody',
        bodyId: 'plate',
        translation: position(5, 0, 0),
        rotation: identityQuaternion(),
        unbind: true,
      }),
    ).not.toThrow();
  });

  it('rejects deleting used entities unless cascading the whole closure (CAD06)', () => {
    const plate = f02Plate();
    expect(() =>
      applyCadOperation(plate, { type: 'deleteClosure', ids: ['W'], cascade: false }),
    ).toThrow('delete-has-dependents');
    const cascaded = applyCadOperation(plate, { type: 'deleteClosure', ids: ['W'], cascade: true });
    expect(cascaded.bodies).toEqual([]);
    expect(cascaded.parameters.map((p) => p.id)).toEqual(['H', 'T']);
    expect(validateCad(cascaded)).toEqual([]);
    const two = f05Dependencies(0);
    expect(
      applyCadOperation(two, { type: 'deleteClosure', ids: ['b'], cascade: false }).bodies.map(
        (b) => b.id,
      ),
    ).toEqual(['a']);
    expect(() =>
      applyCadOperation(two, { type: 'deleteClosure', ids: ['ghost'], cascade: true }),
    ).toThrow('target-missing');
  });

  it('duplicates the full closure with an explicit ID map', () => {
    const plate = f02Plate();
    const ids = [
      'W',
      'H',
      'T',
      'plate-profile',
      'plate-extrude',
      'hole-cylinder',
      'plate-placement',
      'hole-placement',
      'plate-cut',
      'plate-cut-placement',
      'plate',
      'hole',
    ];
    const idMap = Object.fromEntries(ids.map((id) => [id, `copy-${id}`]));
    const copy = applyCadOperation(plate, { type: 'duplicateClosure', bodyIds: ['plate'], idMap });
    expect(validateCad(copy)).toEqual([]);
    expect(copy.bodies.map((b) => b.id)).toEqual(['plate', 'hole', 'copy-plate', 'copy-hole']);
    const { ['W']: _, ...partial } = idMap;
    expect(() =>
      applyCadOperation(plate, { type: 'duplicateClosure', bodyIds: ['plate'], idMap: partial }),
    ).toThrow('duplicate-id-map');
  });

  it('reports semantic diffs and enforces dependency-respecting reorder', () => {
    const plate = f02Plate();
    const wider = applyCadOperation(plate, { type: 'setParameter', parameterId: 'W', value: 100 });
    expect(compareCad(plate, wider)).toEqual([
      { elementId: 'W', path: 'parameters.value', kind: 'changed', before: '80', after: '100' },
    ]);
    const order = plate.features.map((f) => f.id);
    const swapped = [order[1], order[0], ...order.slice(2)];
    const reordered = applyCadOperation(plate, { type: 'reorderFeatures', featureIds: swapped });
    expect(compareCad(plate, reordered).map((c) => c.kind)).toEqual(['moved', 'moved']);
    expect(() =>
      applyCadOperation(plate, { type: 'reorderFeatures', featureIds: [...order].reverse() }),
    ).toThrow(/feature-order/);
  });

  it('gates operation data before reading it', () => {
    expect(() => assertCadOperation({ type: 'eval', code: '1' })).toThrow('unsupported-operation');
    expect(() =>
      assertCadOperation({ type: 'setParameter', parameterId: 'W', value: 1, extra: true }),
    ).toThrow('operation-schema');
    expect(() =>
      assertCadOperation({ type: 'setParameter', parameterId: 'W', value: Infinity }),
    ).toThrow('operation-schema');
    const accessor = { type: 'rename', targetId: 'W', name: 'x' };
    Object.defineProperty(accessor, 'name', { get: () => 'x', enumerable: true });
    expect(() => assertCadOperation(accessor)).toThrow('operation-schema');
    expect(() =>
      assertCadOperation({ type: 'rename', targetId: 'W', name: 'Width ✓' }),
    ).not.toThrow();
  });
});
