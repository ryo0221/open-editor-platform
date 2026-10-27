import { EditorSession } from '@editor-platform/editor-core';
import { contentHash } from '@editor-platform/artifact-core';
import { describe, expect, it } from 'vitest';
import {
  applyCadOperation,
  assertCad,
  assertCadOperation,
  cadContentHash,
  cadEditorCommand,
  cadTolerance,
  cadToleranceSetOf,
  cadToleranceSets,
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

  it('takes one named tolerance set, changed only by its own edit (K2, CM-6)', () => {
    const plate = f02Plate();
    expect(cadToleranceSetOf(plate.kernelProfile)).toBe('standard');
    const large = applyCadOperation(plate, { type: 'setToleranceSet', set: 'large' });
    expect(large.kernelProfile).toMatchObject(cadToleranceSets.large);
    expect(cadToleranceSetOf(large.kernelProfile)).toBe('large');
    expect(validateCad(large)).toEqual([]);
    // The recipe is untouched: only the profile's tolerances change.
    expect({ ...large, kernelProfile: plate.kernelProfile }).toEqual(plate);
    expect(applyCadOperation(large, { type: 'setToleranceSet', set: 'standard' })).toEqual(plate);
    expect(() => applyCadOperation(large, { type: 'setToleranceSet', set: 'large' })).toThrow(
      'tolerance-set-unchanged',
    );
    expect(() =>
      applyCadOperation(plate, { type: 'setToleranceSet', set: 'huge' as never }),
    ).toThrow('tolerance-set-unknown');
    // A mixture of the two sets is no set: refused like any other value.
    const mixed = mutate(
      plate,
      (d) =>
        (d.kernelProfile.maxResultLinearToleranceMm =
          cadToleranceSets.large.maxResultLinearToleranceMm),
    );
    expect(cadToleranceSetOf(mixed.kernelProfile)).toBeUndefined();
    expect(codes(mixed)).toContain('kernel-tolerance');
    expect(cadToleranceSets.standard).toBe(cadTolerance);
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
      [{ ...f01Empty(), schemaVersion: 3 }, 'unsupported-schema'],
      [mutate(plate, (d) => (d.extra = 1)), 'unknown-field'],
      [mutate(plate, (d) => (d.parameters[0].value = Number.NaN)), 'number'],
      [mutate(plate, (d) => (d.parameters[0].value = 0)), 'dimension-range'],
      [mutate(plate, (d) => (d.parameters[2].value = -5)), 'dimension-range'],
      [mutate(plate, (d) => (d.features[0].args.profileId = 'nope')), 'profile-missing'],
      [mutate(plate, (d) => (d.features[2].inputFeatureIds = ['missing'])), 'feature-missing'],
      [mutate(plate, (d) => (d.parameters[1].id = 'W')), 'duplicate-id'],
      [mutate(plate, (d) => (d.features[0].type = 'helix')), 'feature-type'],
      [mutate(plate, (d) => d.assets.push({})), 'asset-kind'],
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

  it('names both places of a duplicate ID across element kinds (ST-28#7)', () => {
    const doc = mutate(f02Plate(), (d) => (d.bodies[1].id = 'plate-profile'));
    expect(validateCad(doc)).toContainEqual({
      code: 'duplicate-id',
      path: '$.bodies[1].id',
      severity: 'error',
      id: 'plate-profile',
      firstPath: '$.profiles[0].id',
    });
    expect(() => assertCad(doc)).toThrow(
      'cad-invalid:duplicate-id@$.bodies[1].id (ID "plate-profile" is already used at $.profiles[0].id)',
    );
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

  it('counts 64 active bodies; consumed tools count only toward 1,024 in all (CM-U3)', () => {
    const boxes = (from: number, n: number) => {
      const ids = Array.from({ length: n }, (_, i) => `b${from + i}`);
      return {
        type: 'insertFeatures' as const,
        features: ids.map((id, i) => ({
          id: `${id}-box`,
          name: id,
          type: 'box' as const,
          inputFeatureIds: [] as [],
          args: {
            size: position(1, 1, 1),
            origin: position((from + i) * 2, 0, 0),
            orientation: identityQuaternion(),
          },
        })),
        bodies: ids.map((id) => ({
          id,
          name: id,
          sourceFeatureId: `${id}-box`,
          placementFeatureId: `${id}-placement`,
          appearance: { color: '#9aa4b1', opacity: 1 },
        })),
      };
    };
    let doc = applyCadOperation(f01Empty(), boxes(0, 40));
    doc = applyCadOperation(doc, {
      type: 'booleanBodies',
      targetId: 'b0',
      toolIds: Array.from({ length: 20 }, (_, i) => `b${i + 1}`),
      mode: 'union',
      booleanFeatureId: 'join',
      placementFeatureId: 'join-placement',
    });
    // 20 consumed, 20 active: 44 more reach 64 active (84 bodies in all).
    doc = applyCadOperation(doc, boxes(40, 44));
    expect(doc.bodies).toHaveLength(84);
    expect(codes(doc)).toEqual([]);
    expect(() => applyCadOperation(doc, boxes(84, 1))).toThrow('limit-active-bodies');
    // The whole list, consumed included, stops at 1,024.
    const all = mutate(doc, (d) => {
      const consumed = d.bodies[1];
      for (let i = 0; i < 941; i++) d.bodies.push({ ...consumed, id: `c${i}` });
    });
    expect(codes(all)).toContain('limit-bodies');
    expect(codes(all)).not.toContain('limit-active-bodies');
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

describe('D2 imported bodies (CAD13 content side)', () => {
  const hash = (c: string) => `sha256:${c.repeat(64)}`;
  const assets = [
    {
      id: 'a-step',
      kind: 'source-step' as const,
      sha256: hash('a'),
      byteLength: 1200,
      mediaType: 'model/step',
    },
    {
      id: 'a-brep',
      kind: 'normalized-brep' as const,
      sha256: hash('b'),
      byteLength: 3400,
      mediaType: 'model/x-occt-brep',
    },
  ];
  const insert = (prefix = ''): CadOperation => ({
    type: 'insertImportedBody',
    assets,
    feature: {
      id: `${prefix}imp`,
      name: 'bracket.step',
      type: 'imported',
      inputFeatureIds: [],
      args: {
        kind: 'solid',
        sourceAssetId: 'a-step',
        brepAssetId: 'a-brep',
        importer: { id: 'occt-dev', buildHash: hash('c') },
        sourceUnit: 'in',
        scaleToMm: 25.4,
      },
    },
    body: {
      id: `${prefix}body`,
      name: 'bracket',
      sourceFeatureId: `${prefix}imp`,
      placementFeatureId: `${prefix}imp-placement`,
      appearance: { color: '#8899aa', opacity: 1 },
    },
  });
  const imported = () => applyCadOperation(f01Empty(), insert());

  it('adds the asset refs, the feature, its placement and an active body in one edit', () => {
    const doc = imported();
    expect(doc.assets).toEqual(assets);
    expect(doc.features.map((f) => f.type)).toEqual(['imported', 'transform']);
    expect(doc.bodies).toMatchObject([{ id: 'body', resultFeatureId: 'imp-placement' }]);
    expect(codes(doc)).toEqual([]);
    // A second import of the same file reuses equal refs; a different ref under the same ID is refused.
    expect(applyCadOperation(doc, insert('2-')).assets).toHaveLength(2);
    const conflict = structuredClone(insert('3-')) as Loose;
    conflict.assets[0].byteLength = 1;
    expect(() => applyCadOperation(doc, conflict)).toThrow('asset-conflict');
  });

  it('validates refs, kinds, sizes, units and an exact closure', () => {
    const doc = imported();
    const cases: [unknown, string][] = [
      [mutate(doc, (d) => (d.assets[0].sha256 = 'abc')), 'asset-hash'],
      [mutate(doc, (d) => (d.assets[0].mediaType = 'text/plain')), 'asset-media-type'],
      [mutate(doc, (d) => (d.assets[0].byteLength = 16 * 1024 * 1024 + 1)), 'asset-size'],
      [mutate(doc, (d) => (d.assets[1].byteLength = 0.5)), 'asset-size'],
      [mutate(doc, (d) => (d.features[0].args.brepAssetId = 'a-step')), 'asset-missing'],
      [mutate(doc, (d) => (d.features[0].args.sourceUnit = 'yard')), 'source-unit'],
      [mutate(doc, (d) => (d.features[0].args.scaleToMm = 25)), 'source-scale'],
      [mutate(doc, (d) => (d.features[0].args.importer.buildHash = 'x')), 'kernel-build-hash'],
      [mutate(doc, (d) => (d.features[0].inputFeatureIds = ['imp-placement'])), 'feature-arity'],
      [mutate(doc, (d) => d.assets.push({ ...d.assets[0], id: 'a-extra' })), 'asset-duplicate'],
      [
        mutate(doc, (d) => d.assets.push({ ...d.assets[0], id: 'a-extra', sha256: hash('d') })),
        'asset-unreferenced',
      ],
      [mutate(doc, (d) => (d.assets[0].id = 'imp')), 'duplicate-id'],
    ];
    for (const [value, code] of cases) expect(codes(value), code).toContain(code);
  });

  it('drops refs with their last reader; duplicates share them; Undo restores them', () => {
    const doc = imported();
    const copy = applyCadOperation(doc, {
      type: 'duplicateClosure',
      bodyIds: ['body'],
      idMap: { imp: 'imp-2', 'imp-placement': 'imp-placement-2', body: 'body-2' },
    });
    expect(copy.assets).toHaveLength(2);
    expect(copy.features.filter((f) => f.type === 'imported')).toHaveLength(2);
    const one = applyCadOperation(copy, { type: 'deleteClosure', ids: ['imp'], cascade: true });
    expect(one.assets).toHaveLength(2);
    const none = applyCadOperation(one, { type: 'deleteClosure', ids: ['imp-2'], cascade: true });
    expect(none.assets).toEqual([]);
    expect(codes(none)).toEqual([]);
    const s = session(doc);
    s.execute(
      cadEditorCommand(
        { type: 'deleteClosure', ids: ['imp'], cascade: true },
        { expectedHash: cadContentHash(doc), canEdit: () => true },
      ),
    );
    expect(s.content.assets).toEqual([]);
    s.undo();
    expect(s.content.assets).toEqual(assets);
  });

  it('rejects operation data that is not one imported feature with its body', () => {
    const op = insert() as Loose;
    op.feature.type = 'box';
    expect(() => applyCadOperation(f01Empty(), op)).toThrow('imported-feature');
    expect(() => assertCadOperation({ ...insert(), assets: {} })).toThrow('operation-schema');
  });
});
