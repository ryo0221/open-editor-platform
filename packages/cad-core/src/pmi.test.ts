import { describe, expect, it } from 'vitest';
import { f01Empty } from './fixtures';
import { applyCadOperation, type CadOperation } from './operations';
import { identityQuaternion, position } from './model';
import {
  cadBodyPmi,
  cadBodyPmiPlacements,
  cadPmiItemStates,
  cadPmiTrackedIndex,
  cadPmiItemText,
  cadPmiViewCamera,
  placePmiPoint,
  cadPmiLimits,
  pmiAssetProblem,
  assemblyPmiAssetProblem,
  readCadPmiAsset,
  type CadPmiAsset,
} from './pmi';

const counts = { faces: 7, edges: 15, vertices: 10 };
const face = (index: number) => ({ shape: 'face' as const, index });
/** The F43 plate's asset as the importer writes it. */
const plate = (): CadPmiAsset => ({
  version: 1,
  items: [
    { id: 'pmi-1', kind: 'datum', name: 'A', targets: [face(1)] },
    { id: 'pmi-2', kind: 'datum', name: 'B', targets: [face(3)] },
    {
      id: 'pmi-3',
      kind: 'dimension',
      type: 'Size_Diameter',
      values: [10],
      deviation: { lower: -0.05, upper: 0.05 },
      targets: [face(7)],
    },
    {
      id: 'pmi-4',
      kind: 'dimension',
      type: 'Location_LinearDistance',
      values: [5],
      targets: [face(1)],
      targets2: [face(2)],
    },
    {
      id: 'pmi-5',
      kind: 'geometric-tolerance',
      type: 'Position',
      value: 0.1,
      modifiers: [],
      zone: 'D',
      references: [
        { datums: ['pmi-1'], modifiers: [] },
        { datums: ['pmi-2'], modifiers: [] },
      ],
      targets: [face(7)],
    },
    {
      id: 'pmi-6',
      kind: 'datum-target',
      datum: 'A',
      number: 1,
      type: 'point',
      targets: [{ shape: 'vertex', index: 10 }],
    },
  ],
});
type Loose = { version: unknown; items: Record<string, unknown>[] } & Record<string, unknown>;
const problem = (edit: (a: Loose) => void) => {
  const a = plate() as unknown as Loose;
  edit(a);
  return pmiAssetProblem(a, counts);
};

describe('pmi asset (PMI-2, CAD82)', () => {
  it('takes the asset an import writes, and an empty one', () => {
    expect(pmiAssetProblem(plate(), counts)).toBeUndefined();
    expect(pmiAssetProblem({ version: 1, items: [] }, counts)).toBeUndefined();
  });

  it('refuses a target that is not a sub-shape of the body', () => {
    expect(problem((a) => (a.items[2].targets = [face(8)]))).toBe('$.items[2].targets[0].index');
    expect(problem((a) => (a.items[2].targets = [face(0)]))).toBe('$.items[2].targets[0].index');
    expect(problem((a) => (a.items[2].targets = [{ shape: 'edge', index: 16 }]))).toBe(
      '$.items[2].targets[0].index',
    );
    expect(problem((a) => (a.items[2].targets = [{ shape: 'solid', index: 1 }]))).toBe(
      '$.items[2].targets[0].index',
    );
    expect(problem((a) => (a.items[2].targets = [{ ...face(1), extra: 1 }]))).toBe(
      '$.items[2].targets[0]',
    );
    expect(problem((a) => (a.items[2].targets = []))).toBe('$.items[2].targets');
    expect(problem((a) => (a.items[3].targets2 = [face(1.5)]))).toBe(
      '$.items[3].targets2[0].index',
    );
  });

  it('refuses a reference to a datum the asset does not hold', () => {
    expect(problem((a) => (a.items[4].references = [{ datums: ['pmi-3'], modifiers: [] }]))).toBe(
      '$.items[4].references[0].datums',
    );
    expect(problem((a) => (a.items[4].references = [{ datums: ['pmi-9'], modifiers: [] }]))).toBe(
      '$.items[4].references[0].datums',
    );
    expect(
      problem(
        (a) =>
          (a.items[4].references = Array.from({ length: 4 }, () => ({
            datums: ['pmi-1'],
            modifiers: [],
          }))),
      ),
    ).toBe('$.items[4].references');
  });

  it('refuses unknown keys, bad ids and values out of range', () => {
    expect(problem((a) => (a.extra = 1))).toBe('$');
    expect(problem((a) => (a.version = 2))).toBe('$');
    expect(problem((a) => (a.items[0].color = 'red'))).toBe('$.items[0]');
    expect(problem((a) => (a.items[1].id = 'pmi-1'))).toBe('$.items[1].id');
    expect(problem((a) => (a.items[1].id = 'x-2'))).toBe('$.items[1].id');
    expect(problem((a) => (a.items[1].kind = 'note'))).toBe('$.items[1]');
    expect(problem((a) => (a.items[2].values = [Infinity]))).toBe('$.items[2].values');
    expect(problem((a) => (a.items[2].values = [1, 2, 3]))).toBe('$.items[2].values');
    expect(problem((a) => (a.items[2].deviation = { lower: -1 }))).toBe('$.items[2].deviation');
    expect(problem((a) => (a.items[2].qualifier = 'mean'))).toBe('$.items[2].qualifier');
    expect(problem((a) => (a.items[4].value = -0.1))).toBe('$.items[4].value');
    expect(problem((a) => (a.items[4].zone = 'R'))).toBe('$.items[4].zone');
    expect(problem((a) => (a.items[4].maxValue = 0))).toBe('$.items[4].maxValue');
    expect(problem((a) => (a.items[0].name = ''))).toBe('$.items[0].name');
    expect(problem((a) => (a.items[5].type = 'sphere'))).toBe('$.items[5].type');
    expect(problem((a) => (a.items[5].number = -1))).toBe('$.items[5].number');
  });

  it('takes the limits and refuses one more', () => {
    const many = (n: number) => ({
      version: 1,
      items: Array.from({ length: n }, (_, i) => ({
        id: `pmi-${i + 1}`,
        kind: 'datum',
        name: 'A',
        targets: [face(1)],
      })),
    });
    expect(pmiAssetProblem(many(cadPmiLimits.items), counts)).toBeUndefined();
    expect(pmiAssetProblem(many(cadPmiLimits.items + 1), counts)).toBe('$.items');
    const targets = (n: number) =>
      problem((a) => (a.items[0].targets = Array.from({ length: n }, () => face(1))));
    expect(targets(cadPmiLimits.targets)).toBeUndefined();
    expect(targets(cadPmiLimits.targets + 1)).toBe('$.items[0].targets');
  });
});

const hash = (c: string) => `sha256:${c.repeat(64)}`;
/** An imported body `id` (its PMI asset `p-<id>` when `pmi`), as STEP import inserts one. */
const insert = (id: string, c: string, pmi: boolean): CadOperation => ({
  type: 'insertImportedBody',
  assets: [
    { id: `s-${id}`, kind: 'source-step', sha256: hash(c), byteLength: 9, mediaType: 'model/step' },
    {
      id: `b-${id}`,
      kind: 'normalized-brep',
      sha256: hash(c),
      byteLength: 9,
      mediaType: 'model/x-occt-brep',
    },
    ...(pmi
      ? [
          {
            id: `p-${id}`,
            kind: 'pmi' as const,
            sha256: hash(c),
            byteLength: 9,
            mediaType: 'application/json',
          },
        ]
      : []),
  ],
  feature: {
    id: `imp-${id}`,
    name: id,
    type: 'imported',
    inputFeatureIds: [],
    args: {
      kind: 'solid',
      sourceAssetId: `s-${id}`,
      brepAssetId: `b-${id}`,
      ...(pmi ? { pmiAssetId: `p-${id}` } : {}),
      importer: { id: 'occt', buildHash: hash('f') },
      sourceUnit: 'mm',
      scaleToMm: 1,
    },
  },
  body: {
    id,
    name: id,
    sourceFeatureId: `imp-${id}`,
    placementFeatureId: `place-${id}`,
    appearance: { color: '#8899aa', opacity: 1 },
  },
});

describe('the PMI a body carries (PMI-2, PMI-4a)', () => {
  const doc = () =>
    applyCadOperation(
      applyCadOperation(f01Empty(), insert('plate', 'a', true)),
      insert('block', 'b', false),
    );
  it('is current through rigid placements and none without an asset', () => {
    const moved = applyCadOperation(doc(), {
      type: 'transformBody',
      bodyId: 'plate',
      translation: position(10, 0, 0),
      rotation: identityQuaternion(),
    });
    expect(cadBodyPmi(moved, 'plate')).toEqual({
      status: 'current',
      featureId: 'imp-plate',
      assetId: 'p-plate',
    });
    expect(cadBodyPmi(moved, 'block')).toEqual({ status: 'none' });
    expect(cadBodyPmi(moved, 'missing')).toEqual({ status: 'none' });
  });
  it('is followed item by item after a feature that changes the shape, on the body that holds it', () => {
    const boolean = (targetId: string, toolId: string) =>
      applyCadOperation(doc(), {
        type: 'booleanBodies',
        targetId,
        toolId,
        mode: 'cut',
        booleanFeatureId: 'cut',
        placementFeatureId: 'cut-place',
      });
    expect(cadBodyPmi(boolean('plate', 'block'), 'plate')).toEqual({
      status: 'changed',
      featureId: 'imp-plate',
      assetId: 'p-plate',
      changedById: 'cut',
    });
    // The plate as the tool: its PMI is followed on the result, which the block now holds.
    expect(cadBodyPmi(boolean('block', 'plate'), 'block')).toMatchObject({
      status: 'changed',
      featureId: 'imp-plate',
    });
    // Two imports with PMI in one body: not followed, all stale (the target's is named).
    const two = applyCadOperation(
      applyCadOperation(
        applyCadOperation(f01Empty(), insert('plate', 'a', true)),
        insert('other', 'c', true),
      ),
      {
        type: 'booleanBodies',
        targetId: 'plate',
        toolId: 'other',
        mode: 'union',
        booleanFeatureId: 'join',
        placementFeatureId: 'join-place',
      },
    );
    expect(cadBodyPmi(two, 'plate')).toEqual({
      status: 'stale',
      featureId: 'imp-plate',
      assetId: 'p-plate',
      changedById: 'join',
      // PMI-4b: every import whose PMI the body leaves out.
      imports: [
        { featureId: 'imp-plate', assetId: 'p-plate' },
        { featureId: 'imp-other', assetId: 'p-other' },
      ],
    });
  });
});

describe('presentation lines in the asset (PMI-3a, CAD82, ST-210)', () => {
  const plane = { origin: [55, 35, 5], z: [0, 0, 1], x: [1, 0, 0] } as const;
  const shown = (presentation: unknown) => {
    const asset = plate();
    (asset.items[2] as { presentation?: unknown }).presentation = presentation;
    return pmiAssetProblem(asset, counts);
  };
  it('takes an item with its lines and annotation plane', () => {
    expect(shown({ segments: [45, 25, 5, 55, 35, 5], plane })).toBeUndefined();
    expect(shown({ segments: [0, 0, 0, 1, 0, 0] })).toBeUndefined();
  });
  it('refuses lines that are not whole segments, not finite, or a plane that is not one', () => {
    expect(shown({ segments: [0, 0, 0, 1, 0] })).toBe('$.items[2].presentation.segments');
    expect(shown({ segments: [] })).toBe('$.items[2].presentation.segments');
    expect(shown({ segments: [0, 0, 0, 1, 0, Infinity] })).toBe('$.items[2].presentation.segments');
    // Finite but past the model's coordinate range: float32 in the viewport makes it infinite.
    expect(shown({ segments: [0, 0, 0, 1e40, 0, 0] })).toBe('$.items[2].presentation.segments');
    expect(shown({ segments: [0, 0, 0, 1e7, 0, 0] })).toBeUndefined();
    expect(shown({ segments: [0, 0, 0, 1, 0, 0], plane: { ...plane, origin: [1e40, 0, 0] } })).toBe(
      '$.items[2].presentation.plane',
    );
    expect(shown({ segments: [0, 0, 0, 1, 0, 0], plane: { ...plane, z: [0, 0, 2] } })).toBe(
      '$.items[2].presentation.plane',
    );
    expect(shown({ segments: [0, 0, 0, 1, 0, 0], colour: 'red' })).toBe('$.items[2].presentation');
  });
  it('takes the asset at the vertex limit and refuses one segment more', () => {
    const asset = plate();
    const half = cadPmiLimits.vertices / 2;
    // Two items share the limit: it is the asset's, not one item's.
    asset.items[2]!.presentation = { segments: new Array<number>(half * 3).fill(1) };
    asset.items[3]!.presentation = { segments: new Array<number>(half * 3).fill(2) };
    expect(pmiAssetProblem(asset, counts)).toBeUndefined();
    asset.items[3]!.presentation.segments.push(0, 0, 0, 1, 1, 1);
    expect(pmiAssetProblem(asset, counts)).toBe('$.items[3].presentation.segments');
  });
  it('places the lines where the body is: through its rigid placements, past a change too', () => {
    const doc = applyCadOperation(
      applyCadOperation(f01Empty(), insert('plate', 'a', true)),
      insert('block', 'b', false),
    );
    // A quarter turn about z, then 10 mm along x.
    const turn: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    const moved = applyCadOperation(doc, {
      type: 'transformBody',
      bodyId: 'plate',
      translation: position(10, 0, 0),
      rotation: turn,
    });
    const placements = cadBodyPmiPlacements(moved, 'plate')!;
    const p = placePmiPoint(placements, [1, 0, 0]);
    [10, 1, 0].forEach((v, i) => expect(p[i]).toBeCloseTo(v, 12));
    expect(placePmiPoint([], [1, 2, 3])).toEqual([1, 2, 3]);
    expect(cadBodyPmiPlacements(moved, 'block')).toBeUndefined();
    // PMI-4a: a cut changes the shape in place; the placements on the way back still apply,
    // the plate's own and those after the cut, whether it is the target or the tool.
    const boolean = (base: typeof doc, targetId: string, toolId: string) =>
      applyCadOperation(base, {
        type: 'booleanBodies',
        targetId,
        toolId,
        mode: 'cut',
        booleanFeatureId: 'cut',
        placementFeatureId: 'cut-place',
      });
    const step = { rotation: identityQuaternion(), translation: [0, 5, 0] };
    const cut = applyCadOperation(boolean(moved, 'plate', 'block'), {
      type: 'transformBody',
      bodyId: 'plate',
      translation: position(0, 5, 0),
      rotation: identityQuaternion(),
    });
    expect(cadBodyPmiPlacements(cut, 'plate')).toEqual([...placements, step]);
    // The Boolean's own placement after it is the identity until the result is moved.
    expect(cadBodyPmiPlacements(boolean(moved, 'block', 'plate'), 'block')).toEqual([
      ...placements,
      { rotation: identityQuaternion(), translation: [0, 0, 0] },
    ]);
    // Two imports with PMI: stale, nothing to place.
    const two = applyCadOperation(doc, insert('other', 'c', true));
    expect(
      cadBodyPmiPlacements(
        applyCadOperation(two, {
          type: 'booleanBodies',
          targetId: 'plate',
          toolId: 'other',
          mode: 'union',
          booleanFeatureId: 'join',
          placementFeatureId: 'join-place',
        }),
        'plate',
      ),
    ).toBeUndefined();
  });
});

describe('items on a body whose shape changed (PMI-4a, CAD84, ST-212)', () => {
  const tracked = (faces: number[], vertices: number[] = [10]) => ({
    featureId: 'imp-plate',
    // Each kept face at index + 10 in the body's table.
    faces: faces.flatMap((f) => [f, f + 10]),
    edges: [],
    vertices: vertices.flatMap((v) => [v, v + 20]),
  });
  const states = (asset: CadPmiAsset, t: ReturnType<typeof tracked> | undefined) =>
    Object.fromEntries(
      [...cadPmiItemStates(asset, t)].map(([id, s]) => [id, s.current ? 'current' : s.reason]),
    );
  it('keeps an item whose targets are all unchanged, and the items that depend on its datums', () => {
    expect(states(plate(), tracked([1, 2, 3, 7]))).toEqual({
      'pmi-1': 'current',
      'pmi-2': 'current',
      'pmi-3': 'current',
      'pmi-4': 'current',
      'pmi-5': 'current',
      'pmi-6': 'current',
    });
    expect(cadPmiTrackedIndex(tracked([1, 7]), face(7))).toBe(17);
    expect(cadPmiTrackedIndex(tracked([1, 7]), face(2))).toBeUndefined();
    expect(cadPmiTrackedIndex(tracked([1, 7]), { shape: 'edge', index: 7 })).toBeUndefined();
  });
  it('makes stale an item with a changed target, the second end of a distance too', () => {
    // Face 2 (the distance's second end) changed; face 7 (the hole) changed.
    expect(states(plate(), tracked([1, 3]))).toEqual({
      'pmi-1': 'current',
      'pmi-2': 'current',
      'pmi-3': 'target',
      'pmi-4': 'target',
      'pmi-5': 'target',
      'pmi-6': 'current',
    });
  });
  it('makes stale a tolerance whose datum is stale, and a datum whose datum target is', () => {
    // Datum B's face changed: the position tolerance referencing it is stale for that reason.
    expect(states(plate(), tracked([1, 2, 7]))).toMatchObject({
      'pmi-2': 'target',
      'pmi-5': 'datum',
      'pmi-3': 'current',
    });
    // Datum A's target point changed: datum A, and the tolerance referencing it, are stale.
    expect(states(plate(), tracked([1, 2, 3, 7], []))).toMatchObject({
      'pmi-6': 'target',
      'pmi-1': 'datum',
      'pmi-5': 'datum',
      'pmi-4': 'current',
    });
    // A datum with no targets of its own stands on its datum targets.
    const onTargets = plate();
    onTargets.items[0]!.targets = [];
    expect(states(onTargets, tracked([2, 3, 7]))).toMatchObject({ 'pmi-1': 'current' });
    expect(states(onTargets, tracked([2, 3, 7], []))).toMatchObject({ 'pmi-1': 'datum' });
  });
  it('makes everything stale without an evaluation, and an item with nothing to check', () => {
    expect(new Set(Object.values(states(plate(), undefined)))).toEqual(new Set(['target']));
    const empty = plate();
    empty.items[2]!.targets = [];
    expect(states(empty, tracked([1, 2, 3, 7]))).toMatchObject({ 'pmi-3': 'target' });
  });
});

describe('saved views in the asset (PMI-3b, CAD82, ST-211)', () => {
  const camera = {
    eye: [60, 36, 100],
    direction: [0, 0, -1],
    up: [0, 1, 0],
    width: 50,
    height: 30,
  };
  const viewed = (views: unknown, itemViews: unknown = ['view-1']) => {
    const asset = plate() as unknown as Record<string, unknown> & {
      items: Record<string, unknown>[];
    };
    asset.views = views;
    asset.items[2]!.views = itemViews;
    return pmiAssetProblem(asset, counts);
  };
  it('takes views with a parallel camera, and items that name them', () => {
    expect(viewed([{ id: 'view-1', name: 'Hole', camera }])).toBeUndefined();
  });
  it('refuses a view that is not one, or an item naming an unknown view', () => {
    expect(viewed([])).toBe('$.views');
    expect(
      viewed([{ id: 'view-1', name: 'Hole', camera: { ...camera, direction: [0, 0, -2] } }]),
    ).toBe('$.views[0].camera');
    // Up must be at right angles to the direction.
    expect(viewed([{ id: 'view-1', name: 'Hole', camera: { ...camera, up: [0, 0, 1] } }])).toBe(
      '$.views[0].camera',
    );
    expect(viewed([{ id: 'view-1', name: 'Hole', camera: { ...camera, width: 0 } }])).toBe(
      '$.views[0].camera',
    );
    // Past the model's coordinate range: the viewport could not place it.
    expect(viewed([{ id: 'view-1', name: 'Hole', camera: { ...camera, width: 1e40 } }])).toBe(
      '$.views[0].camera',
    );
    expect(viewed([{ id: 'view-1', name: 'Hole', camera: { ...camera, eye: [1e40, 0, 0] } }])).toBe(
      '$.views[0].camera',
    );
    expect(
      viewed([{ id: 'view-1', name: 'Hole', camera: { ...camera, projection: 'central' } }]),
    ).toBe('$.views[0].camera');
    expect(
      viewed([
        { id: 'view-1', name: 'a', camera },
        { id: 'view-1', name: 'b', camera },
      ]),
    ).toBe('$.views[1].id');
    expect(viewed([{ id: 'view-1', name: 'Hole', camera }], ['view-2'])).toBe('$.items[2].views');
    expect(viewed(undefined, ['view-1'])).toBe('$.items[2].views');
  });
  it('takes lines callout by callout with the views that list each, and refuses others', () => {
    const ranged = (ranges: unknown, itemViews: unknown[] | 'none' = ['view-1', 'view-2']) => {
      const asset = plate() as unknown as Record<string, unknown> & {
        items: Record<string, unknown>[];
      };
      asset.views = [
        { id: 'view-1', name: 'a', camera },
        { id: 'view-2', name: 'b', camera },
      ];
      if (itemViews !== 'none') asset.items[2]!.views = itemViews;
      asset.items[2]!.presentation = { segments: new Array(12).fill(1), ranges };
      return pmiAssetProblem(asset, counts);
    };
    const at = '$.items[2].presentation.ranges';
    expect(
      ranged([
        { end: 6, views: ['view-1'] },
        { end: 12, views: ['view-2'] },
      ]),
    ).toBeUndefined();
    expect(ranged([{ end: 12, views: [] }])).toBeUndefined();
    // Not ending at the last segment, not increasing, not whole segments, an unknown view.
    expect(ranged([{ end: 6, views: ['view-1'] }])).toBe(at);
    expect(
      ranged([
        { end: 6, views: [] },
        { end: 6, views: [] },
        { end: 12, views: [] },
      ]),
    ).toBe(at);
    expect(ranged([{ end: 12.5, views: [] }])).toBe(at);
    expect(ranged([{ end: 12, views: ['view-3'] }])).toBe(at);
    expect(ranged([{ end: 12, views: ['view-2'] }], ['view-1'])).toBe(at);
    expect(ranged([{ end: 12, views: [] }], 'none')).toBe(at);
    expect(ranged([])).toBe(at);
  });
  it('refuses a view name past the limit', () => {
    const name = 'n'.repeat(cadPmiLimits.viewName);
    expect(viewed([{ id: 'view-1', name, camera }])).toBeUndefined();
    expect(viewed([{ id: 'view-1', name: `${name}n`, camera }])).toBe('$.views[0].name');
  });
  it('takes the view limit and refuses one more', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `view-${i + 1}`, name: '', camera }));
    expect(viewed(many(cadPmiLimits.views))).toBeUndefined();
    expect(viewed(many(cadPmiLimits.views + 1))).toBe('$.views');
  });
  it('turns a view into a viewport camera where the body is', () => {
    // A quarter turn about z, then 10 mm along x: the view from above stays above.
    const placements = [
      {
        rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] as [number, number, number, number],
        translation: [10, 0, 0] as [number, number, number],
      },
    ];
    const v = cadPmiViewCamera(placements, camera as never, [0, 0, 0], 2);
    [-26, 60, 100].forEach((x, i) => expect(v.camera.position[i]).toBeCloseTo(x, 9));
    [-26, 60, 0].forEach((x, i) => expect(v.camera.target[i]).toBeCloseTo(x, 9));
    [-1, 0, 0].forEach((x, i) => expect(v.camera.up[i]).toBeCloseTo(x, 9));
    // The 50 × 30 window whole in a viewport twice as wide as high: 30 mm high.
    expect(v.projection).toEqual({ type: 'orthographic', spanMm: 30 });
    // In a tall viewport the width decides; a target behind the eye is 1 mm ahead.
    const tall = cadPmiViewCamera([], camera as never, [0, 0, 500], 0.5);
    expect(tall.projection.spanMm).toBe(100);
    expect(tall.camera.target).toEqual([60, 36, 99]);
  });
});

describe('reading and naming PMI items (PMI-2)', () => {
  it('reads an asset, and nothing from bytes that are not one', () => {
    const bytes = new TextEncoder().encode(JSON.stringify(plate()));
    expect(readCadPmiAsset(bytes)).toEqual(plate());
    expect(readCadPmiAsset(new Uint8Array([0x7b, 0xff]))).toBeUndefined();
    expect(readCadPmiAsset(new TextEncoder().encode('{"version":2,"items":[]}'))).toBeUndefined();
  });
  it('names each item with its value, unit, tolerance and datums', () => {
    const a = plate();
    expect(a.items.map((i) => cadPmiItemText(i, a))).toEqual([
      'Datum A',
      'Datum B',
      'Diameter ⌀10 ±0.05 mm',
      'Distance 5 mm',
      'Position ⌀0.1 mm | A | B',
      'Datum target A1 (point)',
    ]);
    expect(
      cadPmiItemText(
        {
          id: 'pmi-9',
          kind: 'dimension',
          type: 'Size_Angular',
          values: [30],
          deviation: { lower: 0, upper: 0.5 },
          qualifier: 'max',
          targets: [face(1)],
        },
        a,
      ),
    ).toBe('Angle 30 +0.5/+0° (max)');
    expect(
      cadPmiItemText(
        {
          id: 'pmi-9',
          kind: 'geometric-tolerance',
          type: 'CircularRunout',
          value: 0.02,
          modifiers: ['MAXIMUM_MATERIAL_REQUIREMENT'],
          references: [{ datums: ['pmi-1', 'pmi-2'], modifiers: [] }],
          targets: [face(1)],
        },
        a,
      ),
    ).toBe('Circular runout 0.02 mm | A-B (maximum material requirement)');
    // A compartment's modifiers and a maximum tolerance are part of the requirement.
    expect(
      cadPmiItemText(
        {
          id: 'pmi-9',
          kind: 'geometric-tolerance',
          type: 'Position',
          value: 0.1,
          maxValue: 0.5,
          modifiers: [],
          references: [{ datums: ['pmi-1'], modifiers: ['MAXIMUM_MATERIAL_REQUIREMENT'] }],
          targets: [face(1)],
        },
        a,
      ),
    ).toBe('Position 0.1 mm, at most 0.5 mm | A (maximum material requirement)');
  });
});

describe("an assembly's PMI of particular instances (PMI-5a, CAD86, TS-1435)", () => {
  // F46: the block (6 faces) placed once and the plate (7 faces) twice.
  const parts: Record<string, typeof counts> = {
    'c-plate-1': counts,
    'c-plate-2': counts,
    'c-block': { faces: 6, edges: 12, vertices: 8 },
  };
  const on = (component: string, index: number) => ({ component, shape: 'face' as const, index });
  const assembly = (): CadPmiAsset => ({
    version: 1,
    items: [
      {
        id: 'pmi-1',
        kind: 'geometric-tolerance',
        type: 'Flatness',
        value: 0.04,
        modifiers: [],
        references: [],
        targets: [on('c-plate-2', 2)],
      },
      {
        id: 'pmi-2',
        kind: 'dimension',
        type: 'Location_LinearDistance',
        values: [5],
        targets: [on('c-plate-2', 2)],
        targets2: [on('c-block', 6)],
      },
      // JAMA's assembly datums stand on features with no geometry.
      { id: 'pmi-3', kind: 'datum', name: 'A', targets: [] },
      {
        id: 'pmi-4',
        kind: 'geometric-tolerance',
        type: 'Parallelism',
        value: 0.05,
        modifiers: [],
        references: [{ datums: ['pmi-3'], modifiers: [] }],
        targets: [on('c-block', 6)],
      },
    ],
  });
  const check = (a: unknown) => assemblyPmiAssetProblem(a, (id) => parts[id]);

  it('accepts targets on components, across two of them', () => {
    expect(check(assembly())).toBeUndefined();
  });

  it('refuses a target without a component, on a missing one, or past its part', () => {
    const edited = (edit: (a: Loose) => void) => {
      const a = assembly() as unknown as Loose;
      edit(a);
      return check(a);
    };
    expect(edited((a) => ((a.items[0]!.targets as object[])[0] = face(2)))).toBe(
      '$.items[0].targets[0].component',
    );
    expect(edited((a) => ((a.items[0]!.targets as object[])[0] = on('c-gone', 2)))).toBe(
      '$.items[0].targets[0].component',
    );
    expect(edited((a) => ((a.items[1]!.targets2 as object[])[0] = on('c-block', 7)))).toBe(
      '$.items[1].targets2[0].index',
    );
    // A dimension or tolerance needs a target; only a datum may have none.
    expect(edited((a) => (a.items[0]!.targets = []))).toBe('$.items[0].targets');
  });

  it('keeps the part asset as it was: no component, and a datum needs its faces', () => {
    const a = plate() as unknown as Loose;
    (a.items[0]!.targets as object[])[0] = on('c-block', 1);
    expect(pmiAssetProblem(a, counts)).toBe('$.items[0].targets[0]');
    const b = plate() as unknown as Loose;
    b.items[0]!.targets = [];
    expect(pmiAssetProblem(b, counts)).toBe('$.items[0].targets');
  });
});
