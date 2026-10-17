import { expect, it } from 'vitest';
import { contentHash } from '@editor-platform/artifact-core';
import { serializeGeo, type Geometry } from '@editor-platform/geo-core';
import { deferred } from '@editor-platform/extension-runtime/reference';
import { PointInputBuffer } from '../point-edit/buffer';
import { draftFor } from '../point-edit/model';
import { fixture } from '../../test-host/fixture';
import { editFixture } from '../../test-host/edit-fixture';
import {
  budgets,
  checkedReopen,
  saveFixture,
  saveHarness,
} from '../../test-host/native-save-harness';
const target = { layerId: 'synthetic-sites', featureId: 'point-1', fieldId: 'metric' };
function state(h: ReturnType<typeof saveHarness>) {
  const s = h.binding.session;
  return {
    content: structuredClone(s.content),
    revision: s.revision,
    undo: s.canUndo,
    redo: s.canRedo,
  };
}
function edit(h: ReturnType<typeof saveHarness>, value: string) {
  const draft = draftFor(h.handle.context.basic.read(), target);
  expect(h.port.execute({ ...draft, scalar: value }).state).toBe('applied');
}
it('GS01 save then native JSON reopen preserves all values and stable IDs without adding history', async () => {
  const h = saveHarness();
  edit(h, '25');
  const before = state(h),
    pending = h.save.save();
  const request = await h.storage.nextRequest();
  h.storage.commit(request.operationId);
  await expect(pending).resolves.toMatchObject({ state: 'committed', capture: request.capture });
  expect(state(h)).toEqual(before);
  expect(h.storage.saved).toEqual([request.capture]);
  const restored = await checkedReopen(
    serializeGeo(h.storage.writes[0].content, budgets),
    request.capture.contentHash,
  );
  const fresh = saveHarness(restored);
  expect(fresh.handle.context.basic.read().content).toEqual(before.content);
  expect(fresh.binding.session.canUndo).toBe(false);
  expect(fresh.binding.session.revision).not.toEqual(before.revision);
  expect(h.port.undo().state).toBe('applied');
  expect(h.binding.session.content.layers[0].features[0].values.metric).toBe(10);
  expect(h.binding.session.canUndo).toBe(false);
});
it('GS02 old capture commits its own content but never marks newer draft saved', async () => {
  const h = saveHarness();
  edit(h, '20');
  const pending = h.save.save(),
    request = await h.storage.nextRequest();
  edit(h, '30');
  const beforeAck = state(h);
  h.storage.commit(request.operationId);
  await expect(pending).resolves.toMatchObject({ state: 'committed', capture: request.capture });
  expect(h.storage.saved).toEqual([]);
  expect(state(h)).toEqual(beforeAck);
  expect(h.storage.writes[0].content.layers[0].features[0].values.metric).toBe(20);
  expect(h.port.undo().state).toBe('applied');
  expect(h.binding.session.content.layers[0].features[0].values.metric).toBe(20);
});
it('GS03 saving a clean draft with Redo available preserves both history directions', async () => {
  const h = saveHarness();
  edit(h, '20');
  h.port.undo();
  const before = state(h),
    pending = h.save.save(),
    request = await h.storage.nextRequest();
  h.storage.commit(request.operationId);
  await pending;
  expect(state(h)).toEqual(before);
  expect(h.port.redo().state).toBe('applied');
  expect(h.binding.session.content.layers[0].features[0].values.metric).toBe(20);
});
it.each(['invalid', 'composing'] as const)(
  'GS04 %s Point input refuses before any capture/write',
  async (mode) => {
    const h = saveHarness(),
      buffer = new PointInputBuffer(h.port.prepare);
    buffer.select(h.handle.context.basic.read(), target);
    const registration = h.editor.bindInputs(buffer);
    buffer.change({ scalar: 'not-a-number' });
    if (mode === 'composing') buffer.composition('scalar', true);
    registration.changed();
    const before = state(h),
      input = buffer.draft();
    await expect(h.save.save()).rejects.toThrow();
    expect(state(h)).toEqual(before);
    expect(buffer.draft()).toEqual(input);
    expect(h.storage.requests).toEqual([]);
    expect(h.registry.saves.observations()).toEqual([]);
  },
);
it('GS05 conclusive no-write does not mutate native or mark saved', async () => {
  const h = saveHarness(),
    before = state(h),
    pending = h.save.save();
  const request = await h.storage.nextRequest();
  h.storage.noWrite(request.operationId);
  await expect(pending).resolves.toMatchObject({
    state: 'aborted-before-write',
    proof: 'adapter-no-write-guarantee',
  });
  expect(state(h)).toEqual(before);
  expect(h.storage.saved).toEqual([]);
  expect(() => h.storage.commit(request.operationId)).toThrow('Fenced');
});
it('GS06 unknown outcome retains operation and fences retry until existing reconciliation', async () => {
  const h = saveHarness(),
    before = state(h),
    pending = h.save.save();
  const request = await h.storage.nextRequest();
  h.clock.advanceTo(100);
  await expect(pending).resolves.toMatchObject({
    state: 'indeterminate',
    operationId: request.operationId,
  });
  await expect(h.save.save()).rejects.toThrow('SaveBusy');
  expect(state(h)).toEqual(before);
  expect(h.storage.saved).toEqual([]);
  h.storage.commit(request.operationId, false);
  h.registry.saves.reconcile(request.operationId, h.storage.evidence(request.operationId));
  expect(h.registry.saves.observations()[0].outcome?.state).toBe('committed');
  expect((await pending).state).toBe('indeterminate');
  expect(h.storage.holds).toBe(0);
});
it('GS07 revoke before dispatch writes nothing and denies stale consumer delivery', async () => {
  const h = saveHarness(),
    gate = deferred<void>(),
    before = state(h);
  h.storage.beforeDispatch = () => gate.promise;
  const pending = h.save.save().catch((error: unknown) => error);
  await h.registry.saves.nextAdmission();
  h.binding.setGrants(['artifact:read']);
  gate.resolve();
  expect(await pending).toMatchObject({ code: 'ScopeRevoked' });
  expect(h.storage.requests).toEqual([]);
  expect(state(h)).toEqual(before);
  expect(h.registry.saves.observations()[0].outcome?.state).toBe('aborted-before-write');
});
it('GS08 revoke after write keeps true receipt but cannot mark or revive closed scope', async () => {
  const h = saveHarness(),
    before = state(h),
    pending = h.save.save().catch((e: unknown) => e);
  const request = await h.storage.nextRequest();
  h.storage.commit(request.operationId, false);
  h.handle.revoke('host-close');
  h.storage.ack(request.operationId, h.storage.evidence(request.operationId));
  expect(await pending).toMatchObject({ code: 'ScopeRevoked' });
  expect(h.storage.saved).toEqual([]);
  expect(state(h)).toEqual(before);
  expect(() => h.handle.context.basic.read()).toThrow('ScopeRevoked');
  expect(h.registry.saves.observations()[0].outcome?.state).toBe('committed');
});
it.each([
  ['schema', 'schema'],
  ['axis', 'crs-axis'],
  ['duplicate', 'feature-or-duplicate-id'],
  ['bytes', 'byte-limit'],
] as const)('GS09 reopen %s rejects for its specific validation reason', async (kind, code) => {
  const h = saveHarness(),
    before = state(h),
    candidate = saveFixture();
  if (kind === 'schema') candidate.schemaVersion = 2 as 1;
  if (kind === 'axis') candidate.layers[0].axis = 'latitude-longitude' as 'longitude-latitude';
  if (kind === 'duplicate') candidate.layers[0].features[1].id = candidate.layers[0].features[0].id;
  const expected = await contentHash(candidate);
  const text = kind === 'bytes' ? ' '.repeat(budgets.bytes + 1) : JSON.stringify(candidate);
  await expect(checkedReopen(text, expected)).rejects.toThrow(code);
  expect(state(h)).toEqual(before);
  expect(h.storage.requests).toEqual([]);
});
it('GS09 source profile rejects with the candidate correct hash, independently of hash mismatch', async () => {
  const h = saveHarness(),
    before = state(h),
    candidate = fixture();
  const text = serializeGeo(candidate, budgets),
    expected = await contentHash(candidate);
  await expect(checkedReopen(text, expected)).rejects.toThrow('GeoSourceFreeProfileRequired');
  expect(state(h)).toEqual(before);
  expect(h.storage.requests).toEqual([]);
});
it('GS09 valid mixed source-free document with wrong hash rejects specifically for capture mismatch', async () => {
  const h = saveHarness(),
    before = state(h),
    candidate = saveFixture();
  const changed = structuredClone(candidate);
  changed.layers[0].features[0].values.metric = 999;
  const wrong = await contentHash(changed);
  expect(wrong).not.toBe(await contentHash(candidate));
  await expect(checkedReopen(serializeGeo(candidate, budgets), wrong)).rejects.toThrow(
    'CaptureHashMismatch',
  );
  expect(state(h)).toEqual(before);
  expect(h.storage.requests).toEqual([]);
});

it.each(['exact-edit-fixture', 'all-geometry-families'] as const)(
  'GS12 %s preserves the entire mixed document with its real capture hash',
  async (kind) => {
    const candidate = editFixture();
    if (kind === 'all-geometry-families') {
      const ring: [number, number][] = [
        [12, 34],
        [13, 34],
        [13, 35],
        [12, 34],
      ];
      const extra: Geometry[] = [
        {
          type: 'MultiPoint',
          coordinates: [
            [12, 34],
            [13, 35],
          ],
        },
        {
          type: 'MultiLineString',
          coordinates: [
            [
              [12, 34],
              [13, 35],
            ],
          ],
        },
        { type: 'Polygon', coordinates: [ring] },
        { type: 'MultiPolygon', coordinates: [[ring]] },
      ];
      for (const [i, geometry] of extra.entries())
        candidate.layers[0].features.push({
          id: `retained-${i}`,
          rowId: `retained-row-${i}`,
          geometry,
          values: { metric: i === 0 ? null : 0, code: '001', active: false },
        });
    }
    const original = structuredClone(candidate),
      h = saveHarness(candidate);
    const pending = h.save.save(),
      request = await h.storage.nextRequest();
    expect(request.capture.contentHash).toBe(await contentHash(original));
    h.storage.commit(request.operationId);
    await pending;
    const restored = await checkedReopen(
      serializeGeo(h.storage.writes[0].content, budgets),
      request.capture.contentHash,
    );
    expect(restored).toEqual(original);
    expect(restored.layers[0].features).toHaveLength(original.layers[0].features.length);
    expect(restored.layers[0].features.find((f) => f.id === 'point-4')).toEqual(
      original.layers[0].features[3],
    );
    expect(restored.layers[0].features[3].geometry).toBeNull();
    expect(saveHarness(restored).handle.context.basic.read().content).toEqual(original);
    const nonPoint = draftFor(h.handle.context.basic.read(), { ...target, featureId: 'point-5' });
    expect(h.port.execute(nonPoint)).toMatchObject({ state: 'refused', message: 'GeoPointOnly' });
    expect(h.binding.session.content).toEqual(original);
  },
);

it('GS10 Save flushes valid Point input once; only the edit contributes history', async () => {
  const h = saveHarness(),
    buffer = new PointInputBuffer(h.port.prepare);
  buffer.select(h.handle.context.basic.read(), target);
  const registration = h.editor.bindInputs(buffer);
  buffer.change({ scalar: '42', longitude: '12.5' });
  registration.changed();
  const pending = h.editor.save(),
    request = await h.storage.nextRequest();
  expect(request.content.layers[0].features[0]).toMatchObject({
    geometry: { type: 'Point', coordinates: [12.5, 34] },
    values: { metric: 42 },
  });
  const captured = state(h);
  h.storage.commit(request.operationId);
  await expect(pending).resolves.toMatchObject({
    state: 'outcome',
    outcome: { state: 'committed' },
  });
  expect(state(h)).toEqual(captured);
  expect(buffer.read().dirty).toBe(false);
  expect(h.port.undo().state).toBe('applied');
  expect(h.binding.session.content).toEqual(saveFixture());
  expect(h.binding.session.canUndo).toBe(false);
});

it('GS11 no-write after valid flush keeps the accepted edit unsaved, without silent rollback', async () => {
  const h = saveHarness(),
    buffer = new PointInputBuffer(h.port.prepare);
  buffer.select(h.handle.context.basic.read(), target);
  const registration = h.editor.bindInputs(buffer);
  buffer.change({ scalar: '42' });
  registration.changed();
  const pending = h.editor.save(),
    request = await h.storage.nextRequest();
  const afterFlush = state(h);
  h.storage.noWrite(request.operationId);
  await expect(pending).resolves.toMatchObject({
    state: 'outcome',
    outcome: { state: 'aborted-before-write' },
  });
  expect(state(h)).toEqual(afterFlush);
  expect(h.storage.saved).toEqual([]);
  expect(buffer.read().dirty).toBe(false);
  expect(h.binding.session.content.layers[0].features[0].values.metric).toBe(42);
  h.port.undo();
  expect(h.binding.session.content).toEqual(saveFixture());
});
