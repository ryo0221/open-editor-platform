import { describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '@editor-platform/artifact-core';
import { EditorSession, command } from '@editor-platform/editor-core';
import {
  prepareFictionMapChange,
  prepareFictionMapImport,
  commitFictionMapChange,
  previewFictionMapChange,
  undoFictionMap,
  redoFictionMap,
  createFeature,
  updateFeatureMetadata,
  deleteFeatures,
  moveFeaturesToLayer,
  translateFeatures,
  replaceGeometry,
  replaceLayers,
  replaceNamedViews,
  setCoordinateSpace,
  setPrecision,
  validateFictionMap,
  serializeFictionMap,
  type FictionMapContent,
  type FictionMapBase,
  type PreparedFictionMapChange,
} from '@editor-platform/fiction-map/model';
import * as admission from './admission';
import * as geometryValidation from './geometry-validation';
import { checkPreparedPolicy } from './commands';
import { copyData, requestBudget } from './input';
import { checkWork, checkAffectedIds, chargeWork, fictionMapLimits, type WorkPlan } from './limits';
import { attempt, fail, unwrap } from './result';
import { layer, native, pointFeature, polygon } from './test-data';

const allowed = () => true;
function context(content = native()) {
  const session = new EditorSession(content);
  return { session, base: { content, revision: session.revision } };
}
function checkpoint(session: EditorSession<FictionMapContent>) {
  return {
    content: canonicalJson(session.content),
    revision: session.revision,
    canUndo: session.canUndo,
    canRedo: session.canRedo,
    undo: session.peekHistory('undo'),
    redo: session.peekHistory('redo'),
    allHistory: JSON.stringify(session),
  };
}
function unchanged(
  session: EditorSession<FictionMapContent>,
  before: ReturnType<typeof checkpoint>,
) {
  expect(checkpoint(session)).toEqual(before);
}
function apply(session: EditorSession<FictionMapContent>, base: FictionMapBase, change: unknown) {
  return unwrap(
    commitFictionMapChange(session, unwrap(prepareFictionMapChange(base, change)), allowed),
  );
}
function many(prefix: string) {
  return native(Array.from({ length: 200 }, (_, i) => pointFeature(prefix + i)));
}
function maxRings() {
  return native([
    ...Array.from({ length: 15 }, (_, i) => pointFeature('r' + i, polygon(64))),
    pointFeature('last', polygon(40)),
  ]);
}

describe('Fiction Map B4 single local command boundary', () => {
  it('B4-01/02 200 old -> 200 distinct new in one command, Undo/Redo and stable source', () => {
    const { session, base } = context(many('old')),
      target = many('new'),
      before = canonicalJson(base.content);
    const execute = vi.spyOn(session, 'execute');
    const committed = apply(session, base, {
      delete: base.content.features.map((f) => f.id),
      create: target.features,
    });
    expect(committed.content.features).toEqual(target.features);
    expect(session.revision.sequence).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    const undone = unwrap(undoFictionMap(session, allowed));
    expect(canonicalJson(undone.content)).toBe(before);
    expect(unwrap(redoFictionMap(session, allowed)).content).toEqual(committed.content);
    expect(canonicalJson(base.content)).toBe(before);
    expect(base.revision.sequence).toBe(0);
  });
  it('B4-01 request counts, byte and structure caps precede materialization', () => {
    const { session, base } = context(many('old')),
      before = checkpoint(session);
    const over = {
      delete: base.content.features.map((f) => f.id),
      create: Array.from({ length: 201 }, (_, i) => pointFeature('new' + i)),
    };
    expect(prepareFictionMapChange(base, over)).toMatchObject({
      ok: false,
      diagnostic: { code: 'operation-feature-limit', path: '' },
    });
    expect(copyData('x'.repeat(262142), requestBudget)).toHaveLength(262142);
    expect(attempt('input', () => copyData('x'.repeat(262143), requestBudget))).toMatchObject({
      ok: false,
      diagnostic: { code: 'operation-byte-limit' },
    });
    expect(prepareFictionMapChange(base, { extra: 'x'.repeat(262145) })).toMatchObject({
      ok: false,
      diagnostic: { code: 'operation-byte-limit' },
    });
    let v: unknown = 0;
    for (let i = 0; i < 9; i++) v = [v];
    expect(prepareFictionMapChange(base, { extra: v })).toMatchObject({
      ok: false,
      diagnostic: { code: 'input-structure-limit' },
    });
    expect(prepareFictionMapChange(base, { create: Array(401) })).toMatchObject({
      ok: false,
      diagnostic: { code: 'operation-feature-limit' },
    });
    unchanged(session, before);
  });
  it('B4-03 max legal ring sum and append two-pass admission stay within accepted bounds', () => {
    const rings = maxRings(),
      plan = admission.planContent(rings);
    expect(plan).toMatchObject({ vertices: 1000, vertexPairs: 31020, edgePairs: 31020 });
    const { session, base } = context(admission.createFictionMap());
    const p = unwrap(prepareFictionMapImport(base, rings, { mode: 'append' }));
    const next = unwrap(commitFictionMapChange(session, p, allowed));
    expect(next.content.features).toHaveLength(16);
    expect(unwrap(undoFictionMap(session, allowed)).content).toEqual(base.content);
  });
  it('B4-04 defensive operation planner boundaries independently of earlier document refusal', () => {
    const p: WorkPlan = {
      features: 200,
      vertices: 1000,
      rawPoints: 1200,
      edges: 1000,
      vertexPairs: 31020,
      edgePairs: 31020,
    };
    expect(() => checkWork(p)).not.toThrow();
    expect(() => checkAffectedIds(400)).not.toThrow();
    expect(attempt('candidate', () => checkAffectedIds(401))).toMatchObject({
      ok: false,
      diagnostic: { code: 'operation-feature-limit', limit: 400 },
    });
    const ledger = { pairs: 0, passes: 0, maxPairs: 124080, maxPasses: 2 };
    chargeWork(p, ledger);
    chargeWork(p, ledger);
    expect(ledger.pairs).toBe(124080);
    expect(attempt('candidate', () => chargeWork(p, ledger))).toMatchObject({
      ok: false,
      diagnostic: { code: 'operation-pair-limit' },
    });

    for (const [field, value, code] of [
      ['vertices', 1001, 'operation-vertex-limit'],
      ['rawPoints', 1201, 'operation-vertex-limit'],
      ['edges', 1001, 'operation-vertex-limit'],
      ['features', 201, 'operation-feature-limit'],
      ['vertexPairs', 31021, 'operation-pair-limit'],
      ['edgePairs', 31021, 'operation-pair-limit'],
    ] as const)
      expect(attempt('candidate', () => checkWork({ ...p, [field]: value }))).toMatchObject({
        ok: false,
        diagnostic: { code },
      });
    expect(attempt('commit', () => checkPreparedPolicy('future-policy'))).toMatchObject({
      ok: false,
      diagnostic: { code: 'prepared-policy-mismatch' },
    });
  });
  it('B4-05 owns request and revision; forged/frozen/cloned Prepared cannot bypass admission', () => {
    const { session, base } = context(),
      request = { update: [{ ...pointFeature(), name: 'prepared' }] },
      revision = { ...base.revision };
    const p = unwrap(prepareFictionMapChange({ ...base, revision }, request));
    request.update[0].name = 'changed';
    revision.sequence = 999;
    const preview = unwrap(previewFictionMapChange(p));
    expect(preview.features[0].name).toBe('prepared');
    expect(Object.isFrozen(preview.features[0])).toBe(true);
    expect(Reflect.set(preview.features[0], 'name', 'tampered')).toBe(false);
    expect(JSON.stringify(p)).toBe('{}');
    for (const fake of [{}, Object.freeze({ ...p }), structuredClone(p)])
      expect(
        commitFictionMapChange(session, fake as PreparedFictionMapChange, allowed),
      ).toMatchObject({ ok: false, diagnostic: { code: 'invalid-data', path: '/prepared' } });
    expect(unwrap(commitFictionMapChange(session, p, allowed)).content.features[0].name).toBe(
      'prepared',
    );
    expect(
      prepareFictionMapChange(
        { content: structuredClone(base.content), revision: session.revision },
        {},
      ),
    ).toMatchObject({ ok: false, diagnostic: { code: 'invalid-data', path: '/base/content' } });
    let reads = 0;
    const getter = Object.defineProperty({ ...base }, 'content', {
      get() {
        reads++;
        return base.content;
      },
    });
    expect(prepareFictionMapChange(getter, {}).ok).toBe(false);
    expect(reads).toBe(0);
  });
  it('B4-06 stale revision, session identity, revision restoration and canonical base mismatch', () => {
    const { session, base } = context(),
      p = unwrap(prepareFictionMapChange(base, { update: [{ ...pointFeature(), name: 'stale' }] }));
    apply(session, base, { update: [{ ...pointFeature(), name: 'external' }] });
    const before = checkpoint(session);
    expect(commitFictionMapChange(session, p, allowed)).toMatchObject({
      ok: false,
      diagnostic: { code: 'stale-revision' },
    });
    unchanged(session, before);
    unwrap(undoFictionMap(session, allowed));
    const back = checkpoint(session);
    expect(canonicalJson(session.content)).toBe(canonicalJson(base.content));
    expect(commitFictionMapChange(session, p, allowed)).toMatchObject({
      ok: false,
      diagnostic: { code: 'stale-revision' },
    });
    unchanged(session, back);
    const another = new EditorSession(base.content);
    expect(commitFictionMapChange(another, p, allowed)).toMatchObject({
      ok: false,
      diagnostic: { code: 'stale-revision' },
    });
    const forged = native([{ ...pointFeature(), name: 'wrong base' }]),
      current = context();
    const q = unwrap(
      prepareFictionMapChange(
        { content: forged, revision: current.session.revision },
        { delete: ['p'] },
      ),
    );
    const s = checkpoint(current.session);
    expect(commitFictionMapChange(current.session, q, allowed)).toMatchObject({
      ok: false,
      diagnostic: { code: 'prepared-base-mismatch', path: '/base/content' },
    });
    unchanged(current.session, s);
  });
  it('B4-07 current permission is mandatory, false preserves Redo; bad asynchronous gate throws', () => {
    const { session, base } = context();
    apply(session, base, { update: [{ ...pointFeature(), name: 'next' }] });
    const restored = unwrap(undoFictionMap(session, allowed));
    const p = unwrap(prepareFictionMapChange(restored, { delete: ['p'] })),
      before = checkpoint(session);
    expect(commitFictionMapChange(session, p, () => false)).toMatchObject({
      ok: false,
      diagnostic: { code: 'permission-denied' },
    });
    unchanged(session, before);
    expect(() =>
      commitFictionMapChange(session, p, (() => Promise.resolve(true)) as unknown as () => boolean),
    ).toThrow('must return boolean');
    unchanged(session, before);
  });
  it('B4-07 permission hook reentry preserves external update and does not reuse old closure', () => {
    const { session, base } = context(),
      p = unwrap(prepareFictionMapChange(base, { delete: ['p'] }));
    let updated = false;
    const result = commitFictionMapChange(session, p, () => {
      if (!updated) {
        updated = true;
        session.execute(
          command('external', 'External', (c) => ({
            ...c,
            features: c.features.map((f) => ({ ...f, name: 'latest' })),
          })),
        );
      }
      return true;
    });
    expect(result).toMatchObject({ ok: false, diagnostic: { code: 'stale-revision' } });
    expect(session.content.features[0].name).toBe('latest');
    expect(session.revision.sequence).toBe(1);
    const another = context(),
      q = unwrap(prepareFictionMapChange(another.base, { delete: ['p'] }));
    let nested: unknown;
    expect(
      commitFictionMapChange(another.session, q, () => {
        nested = commitFictionMapChange(another.session, q, allowed);
        return true;
      }).ok,
    ).toBe(true);
    expect(nested).toMatchObject({ ok: false, diagnostic: { code: 'prepared-consumed' } });
    expect(another.session.revision.sequence).toBe(1);
  });
  it('B4-08 metadata skip, changed geometry local, profile/bounds change validate all', () => {
    const { session, base } = context(
      native([pointFeature('p', polygon(4)), pointFeature('q', polygon(5))]),
    );
    const spy = vi.spyOn(geometryValidation, 'checkGeometry');
    const p = unwrap(
      prepareFictionMapChange(
        base,
        unwrap(updateFeatureMetadata(base.content, 'p', { set: { name: 'rename' } })),
      ),
    );
    expect(spy).toHaveBeenCalledTimes(0);
    const next = unwrap(commitFictionMapChange(session, p, allowed));
    expect(spy).toHaveBeenCalledTimes(0);
    unwrap(prepareFictionMapChange(next, unwrap(replaceGeometry(next.content, 'p', polygon(6)))));
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear();
    unwrap(
      prepareFictionMapChange(
        next,
        unwrap(setPrecision({ ...next.content.precision, minEdgeLength: 0.1 })),
      ),
    );
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockClear();
    unwrap(
      prepareFictionMapChange(
        next,
        unwrap(setCoordinateSpace({ ...next.content.coordinateSpace, yAxis: 'up' })),
      ),
    );
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockClear();
    unwrap(
      prepareFictionMapChange(
        next,
        unwrap(setCoordinateSpace({ ...next.content.coordinateSpace, unit: { name: 'renamed' } })),
      ),
    );
    expect(spy).toHaveBeenCalledTimes(0);
    spy.mockRestore();
  });
  it('B4-09 command.apply permission failure before publish keeps native, all history and revision', () => {
    const { session, base } = context();
    const p = unwrap(prepareFictionMapChange(base, { delete: ['p'] })),
      before = checkpoint(session);
    let gates = 0;
    expect(commitFictionMapChange(session, p, () => ++gates === 1)).toMatchObject({
      ok: false,
      diagnostic: { code: 'permission-denied' },
    });
    unchanged(session, before);
    expect(commitFictionMapChange(session, p, allowed).ok).toBe(true);
    expect(session.revision.sequence).toBe(1);
    const after = checkpoint(session);
    expect(commitFictionMapChange(session, p, allowed)).toMatchObject({
      ok: false,
      diagnostic: { code: 'prepared-consumed' },
    });
    unchanged(session, after);
  });
  it('B4-09 command.apply final capacity failure is atomic and retry is a single commit', () => {
    const { session, base } = context(),
      p = unwrap(prepareFictionMapChange(base, { delete: ['p'] })),
      before = checkpoint(session);
    const real = admission.checkCapacity;
    let calls = 0;
    const spy = vi.spyOn(admission, 'checkCapacity').mockImplementation((c) => {
      if (++calls === 2) fail('native-byte-limit', '');
      return real(c);
    });
    expect(commitFictionMapChange(session, p, allowed)).toMatchObject({
      ok: false,
      diagnostic: { code: 'native-byte-limit' },
    });
    unchanged(session, before);
    spy.mockRestore();
    expect(commitFictionMapChange(session, p, allowed).ok).toBe(true);
    expect(session.revision.sequence).toBe(1);
  });
  it('B4-10 no-op never executes or clears Redo, and it still consumes the Prepared', () => {
    const { session, base } = context();
    apply(session, base, { delete: ['p'] });
    const restored = unwrap(undoFictionMap(session, allowed)),
      p = unwrap(prepareFictionMapChange(restored, {})),
      before = checkpoint(session),
      spy = vi.spyOn(session, 'execute');
    expect(unwrap(commitFictionMapChange(session, p, allowed)).changed).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    unchanged(session, before);
    expect(commitFictionMapChange(session, p, allowed)).toMatchObject({
      ok: false,
      diagnostic: { code: 'prepared-consumed' },
    });
    unchanged(session, before);
    expect(unwrap(redoFictionMap(session, allowed)).content.features).toHaveLength(0);
  });
  it('B4-11 Undo/Redo candidate permission refusal and callback reentry preserve every history entry', () => {
    const { session, base } = context();
    apply(session, base, { delete: ['p'] });
    let before = checkpoint(session);
    expect(undoFictionMap(session, () => false)).toMatchObject({
      ok: false,
      diagnostic: { code: 'permission-denied' },
    });
    unchanged(session, before);
    expect(() =>
      undoFictionMap(session, () => {
        session.execute(command('reenter', 'Reenter', (c) => c));
        return true;
      }),
    ).toThrow('HistoryValidationReentrancy');
    unchanged(session, before);
    unwrap(undoFictionMap(session, allowed));
    before = checkpoint(session);
    expect(redoFictionMap(session, () => false)).toMatchObject({
      ok: false,
      diagnostic: { code: 'permission-denied' },
    });
    unchanged(session, before);
    expect(redoFictionMap(session, allowed).ok).toBe(true);
  });
  it('B4-11 history validates unknown candidate snapshot and restores the candidate own precision', () => {
    const { session, base } = context();
    const p = apply(session, base, unwrap(setPrecision({ minEdgeLength: 2, minPolygonArea: 1 })));
    expect(p.content.precision.minEdgeLength).toBe(2);
    const back = unwrap(undoFictionMap(session, allowed));
    expect(back.content.precision.minEdgeLength).toBe(0);
    unwrap(redoFictionMap(session, allowed));
    // A trusted external command can put an invalid entry on history. Domain Undo refuses it.
    const other = context();
    other.session.execute(command('bad', 'Bad', (c) => ({ ...c, layers: [] })));
    other.session.execute(command('restore', 'Restore', () => other.base.content));
    const before = checkpoint(other.session);
    expect(undoFictionMap(other.session, allowed)).toMatchObject({
      ok: false,
      diagnostic: { code: 'missing-layer' },
    });
    unchanged(other.session, before);
  });
});

describe('Fiction Map constructors, references and atomic negative integration', () => {
  it('B1-08/B4-10 constructors preserve stable IDs, shared World ref, unrelated fields and one Undo', () => {
    const ref = { namespace: 'world', entityId: 'same' },
      original = native([
        {
          ...pointFeature('a'),
          worldEntityRef: ref,
          description: 'keep',
          style: { color: '#112233' },
        },
        { ...pointFeature('b'), worldEntityRef: ref },
      ]);
    const { session, base } = context(original);
    const renamed = apply(
      session,
      base,
      unwrap(
        updateFeatureMetadata(base.content, 'a', { set: { name: 'renamed' }, clear: ['style'] }),
      ),
    );
    expect(renamed.content.features[0]).toMatchObject({
      id: 'a',
      name: 'renamed',
      description: 'keep',
      worldEntityRef: ref,
    });
    expect(renamed.content.features[0].style).toBeUndefined();
    expect(renamed.content.features[1]).toEqual(original.features[1]);
    const moved = apply(
      session,
      renamed,
      unwrap(translateFeatures(renamed.content, ['a'], 10, 20)),
    );
    expect(moved.content.features[0]).toMatchObject({
      id: 'a',
      worldEntityRef: ref,
      geometry: { coordinates: [11, 22] },
    });
    expect(moved.content.features[1]).toEqual(original.features[1]);
    expect(unwrap(undoFictionMap(session, allowed)).content).toEqual(renamed.content);
    expect(unwrap(undoFictionMap(session, allowed)).content).toEqual(original);
    expect(unwrap(redoFictionMap(session, allowed)).content).toEqual(renamed.content);
  });
  it('B1-06 replace layers/views and feature move form one final-state transaction', () => {
    const original = unwrap(
        validateFictionMap({
          ...native(),
          namedViews: [
            {
              id: 'v',
              name: 'view',
              extent: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
              visibleLayerIds: ['l'],
            },
          ],
        }),
      ),
      { session, base } = context(original),
      before = checkpoint(session);
    expect(prepareFictionMapChange(base, unwrap(replaceLayers([])))).toMatchObject({
      ok: false,
      diagnostic: { code: 'missing-layer' },
    });
    unchanged(session, before);
    expect(prepareFictionMapChange(base, { features: [] })).toMatchObject({
      ok: false,
      diagnostic: { code: 'unknown-field' },
    });
    const change = {
      ...unwrap(replaceLayers([layer('dest')])),
      ...unwrap(moveFeaturesToLayer(base.content, ['p'], 'dest')),
      ...unwrap(replaceNamedViews([{ ...original.namedViews[0], visibleLayerIds: ['dest'] }])),
    };
    const next = apply(session, base, change);
    expect(next.content.features[0].id).toBe('p');
    expect(next.content.layers[0].id).toBe('dest');
    expect(unwrap(undoFictionMap(session, allowed)).content).toEqual(original);
  });
  it('B3-08 deletion with a valid but over-budget view update refuses the complete candidate', () => {
    const d = {
      ...native(Array.from({ length: 30 }, (_, i) => pointFeature('p' + i))),
      features: Array.from({ length: 30 }, (_, i) => ({
        ...pointFeature('p' + i),
        description: '',
      })),
      namedViews: [
        { id: 'v', name: 'v', extent: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, visibleLayerIds: [] },
      ],
    };
    let remaining = 65536 - new TextEncoder().encode(canonicalJson(d)).length;
    // Leave p0 tiny so its deletion is outweighed by the valid 128-character Unicode view name.
    for (const f of d.features.slice(1)) {
      const n = Math.min(4096, remaining);
      f.description = 'a'.repeat(n);
      remaining -= n;
    }
    expect(remaining).toBe(0);
    const { session, base } = context(unwrap(validateFictionMap(d))),
      before = checkpoint(session);
    expect(
      prepareFictionMapChange(base, {
        delete: ['p0'],
        namedViews: [{ ...d.namedViews[0], name: '地'.repeat(128) }],
      }),
    ).toMatchObject({ ok: false, diagnostic: { code: 'native-byte-limit' } });
    unchanged(session, before);
  });
  it('all Change fields and constructor refusals remain explicit', () => {
    const { session, base } = context(),
      created = apply(session, base, unwrap(createFeature(pointFeature('q'))));
    const reordered = apply(session, created, { featureOrder: ['q', 'p'] });
    expect(reordered.content.features.map((f) => f.id)).toEqual(['q', 'p']);
    const removed = apply(session, reordered, unwrap(deleteFeatures(['q'])));
    expect(removed.content.features.map((f) => f.id)).toEqual(['p']);
    expect(
      updateFeatureMetadata(base.content, 'p', {
        set: { description: 'a' },
        clear: ['description'],
      }),
    ).toMatchObject({ ok: false, diagnostic: { code: 'invalid-field' } });
    expect(moveFeaturesToLayer(base.content, ['p', 'p'], 'l').ok).toBe(false);
    expect(replaceGeometry(base.content, 'gone', { type: 'point', coordinates: [0, 0] }).ok).toBe(
      false,
    );
    expect(translateFeatures(base.content, ['p'], Number.MIN_VALUE, 0)).toMatchObject({
      ok: false,
      diagnostic: { code: 'coordinate-precision-loss' },
    });
    const before = checkpoint(session);
    for (const change of [
      { update: [pointFeature('gone')] },
      { create: [pointFeature()] },
      { create: [pointFeature('q')], delete: ['q'] },
      { featureOrder: ['p', 'p'] },
      { update: [{ ...pointFeature(), description: null }] },
    ])
      expect(prepareFictionMapChange(removed, change).ok).toBe(false);
    unchanged(session, before);
    expect(unwrap(serializeFictionMap(removed.content))).toBe(canonicalJson(session.content));
  });
  it('B1-07 replace/append/remap reject source errors and preserve native/history on failure', () => {
    const { session, base } = context(),
      before = checkpoint(session);
    expect(prepareFictionMapImport(base, base.content, { mode: 'append' })).toMatchObject({
      ok: false,
      diagnostic: { code: 'duplicate-id' },
    });
    expect(
      prepareFictionMapImport(base, { ...base.content, layers: [] }, { mode: 'append' }),
    ).toMatchObject({ ok: false, diagnostic: { code: 'missing-layer', source: 'source' } });
    unchanged(session, before);
    const p = unwrap(
      prepareFictionMapImport(base, canonicalJson(base.content), {
        mode: 'append',
        remap: { layers: [{ from: 'l', to: 'l2' }], features: [{ from: 'p', to: 'p2' }] },
      }),
    );
    const result = unwrap(commitFictionMapChange(session, p, allowed));
    expect(result.content.features.map((f) => [f.id, f.layerId])).toEqual([
      ['p', 'l'],
      ['p2', 'l2'],
    ]);
    expect(unwrap(undoFictionMap(session, allowed)).content).toEqual(base.content);
  });
  it('diagnostic priority and paths: budget before geometry, references before topology, consumed before permission', () => {
    const { session, base } = context();
    expect(
      prepareFictionMapChange(base, {
        update: [pointFeature('p', { type: 'polygon', outer: Array(66) })],
      }),
    ).toMatchObject({
      ok: false,
      diagnostic: { code: 'geometry-vertex-limit', path: '/update/0/geometry/outer' },
    });
    const bad = {
      ...base.content,
      features: [
        {
          ...pointFeature('p', {
            type: 'polygon',
            outer: [
              [0, 0],
              [0, 0],
              [0, 0],
              [0, 0],
            ],
          }),
          layerId: 'missing',
        },
      ],
    };
    expect(validateFictionMap(bad)).toMatchObject({
      ok: false,
      diagnostic: { code: 'missing-layer', path: '/features/0/layerId' },
    });
    const p = unwrap(prepareFictionMapChange(base, {}));
    unwrap(commitFictionMapChange(session, p, allowed));
    const gate = vi.fn(() => false);
    expect(commitFictionMapChange(session, p, gate)).toMatchObject({
      ok: false,
      diagnostic: { code: 'prepared-consumed' },
    });
    expect(gate).not.toHaveBeenCalled();
  });
  it('adopted public limit object is immutable', () => {
    expect(Object.isFrozen(fictionMapLimits)).toBe(true);
    expect(fictionMapLimits).toMatchObject({
      affectedIds: 400,
      passPairs: 62040,
      appendPairs: 124080,
    });
  });
});
