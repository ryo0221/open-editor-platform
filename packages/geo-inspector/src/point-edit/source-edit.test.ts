import { it, expect } from 'vitest';
import { draftFor, preparePointEdit } from './model';
import { PointInputBuffer } from './buffer';
import { assertPointEditProfile, type GeoPointEditProfile } from './profile';
import { editHarness } from '../../test-host/edit-fixture';
import { retainedEditFixture } from '../../test-host/retained-edit-fixture';
import { budgets } from '../../test-host/fixture';
const target = { layerId: 'retained-sites', featureId: 'retained-edit:f:1', fieldId: 'metric' };
async function harness() {
  const retained = await retainedEditFixture();
  const h = editHarness('editable', undefined, {
    content: retained.content,
    profile: retained.profile,
  });
  const buffer = new PointInputBuffer(h.port.prepare);
  buffer.select(h.handle.context.basic.read(), target);
  const registration = h.editor.bindInputs(buffer);
  return { ...h, retained, buffer, registration };
}
it('source-backed editing is opt-in; omitted profile still refuses exact retained content', async () => {
  const retained = await retainedEditFixture();
  const h = editHarness('editable', undefined, { content: retained.content });
  const snapshot = h.handle.context.basic.read();
  expect(h.port.execute({ ...draftFor(snapshot, target), scalar: '99' })).toMatchObject({
    state: 'refused',
    message: 'GeoSourceFreeProfileRequired',
  });
  expect(h.binding.session.content).toEqual(retained.content);
});
it('one coordinate/scalar command preserves source snapshots/refs, originals and exclusions through Undo/Redo', async () => {
  const h = await harness(),
    before = h.binding.session.content;
  const originals = h.retained.original.slice(),
    excluded = structuredClone(h.retained.excluded);
  h.buffer.change({ longitude: '12.5', latitude: '34.5', scalar: '25' });
  h.registration.changed();
  expect(h.editor.applyInputs().state).toBe('applied');
  const changed = h.binding.session.content;
  expect(h.binding.session.revision.sequence).toBe(1);
  expect(changed.layers[0].features[0]).toMatchObject({
    geometry: { type: 'Point', coordinates: [12.5, 34.5] },
    values: { metric: 25 },
    sourceRef: before.layers[0].features[0].sourceRef,
  });
  expect(changed.sources).toEqual(before.sources);
  expect(changed.layers[0].features.slice(1)).toEqual(before.layers[0].features.slice(1));
  expect(h.retained.original).toEqual(originals);
  expect(h.retained.excluded).toEqual(excluded);
  expect(h.port.undo().state).toBe('applied');
  expect(h.binding.session.content).toEqual(before);
  expect(h.port.redo().state).toBe('applied');
  expect(h.binding.session.content).toEqual(changed);
});
it('closure lost between prepare and apply refuses atomically; dirty/composing inputs survive refusal', async () => {
  const h = await harness(),
    before = h.binding.session.content;
  h.buffer.change({ scalar: '44' });
  h.registration.changed();
  const prepared = h.buffer.prepare(h.handle.context.basic.read());
  h.retained.closure(false);
  expect(h.editor.execute(prepared).state).toBe('refused');
  expect(h.binding.session.content).toEqual(before);
  expect(h.binding.session.canUndo).toBe(false);
  expect(h.buffer.draft()?.scalar).toBe('44');
  expect(h.buffer.read().dirty).toBe(true);
  h.buffer.composition('scalar', true);
  h.registration.changed();
  expect(h.editor.applyInputs().state).toBe('refused');
  expect(h.buffer.read()).toEqual({ dirty: true, composing: true });
  h.buffer.composition('scalar', false);
  h.registration.changed();
  h.retained.closure(true);
  expect(h.editor.applyInputs().state).toBe('applied');
});
it('history requires its own whole-history closure attestation before mutation', async () => {
  const h = await harness();
  expect(
    h.port.execute({ ...draftFor(h.handle.context.basic.read(), target), scalar: '30' }).state,
  ).toBe('applied');
  const changed = h.binding.session.content,
    revision = h.binding.session.revision;
  h.retained.history(false);
  expect(h.port.undo()).toMatchObject({ state: 'refused', message: 'GeoSourceClosureRequired' });
  expect(h.binding.session.content).toEqual(changed);
  expect(h.binding.session.revision).toEqual(revision);
  h.retained.history(true);
  expect(h.port.undo().state).toBe('applied');
  h.retained.history(false);
  expect(h.port.redo().state).toBe('refused');
});
it('valid changed pins/refs are refused even when Host check is erroneously permissive', async () => {
  const h = await harness(),
    snapshot = h.handle.context.basic.read();
  const profile: GeoPointEditProfile = { kind: 'retained-source-closure', check: () => true };
  const prepared = preparePointEdit(
    snapshot,
    { ...draftFor(snapshot, target), scalar: '22' },
    () => ({ revision: snapshot.revision, canEdit: true, budgets }),
    budgets,
    undefined,
    profile,
  );
  for (const alter of [
    (v: typeof snapshot.content) => {
      v.sources[0].pin.versionId = 'different';
    },
    (v: typeof snapshot.content) => {
      v.sources[0].bytesHash = `sha256:${'f'.repeat(64)}`;
    },
    (v: typeof snapshot.content) => {
      v.layers[0].features[0].sourceRef!.externalId = 'different';
    },
  ]) {
    const changed = structuredClone(snapshot.content);
    alter(changed);
    expect(() => prepared.command!.apply(changed)).toThrow('GeoSourcePinsChanged');
  }
  const invalid = structuredClone(snapshot.content);
  invalid.layers[0].features[0].sourceRef!.sourceId = 'missing-source';
  expect(() => prepared.command!.apply(invalid)).toThrow();
  expect(h.binding.session.content).toEqual(snapshot.content);
});
it('Host check gets a frozen detached copy and async/truthy checks never authorize', async () => {
  const { content } = await retainedEditFixture();
  const before = structuredClone(content);
  assertPointEditProfile(content, {
    kind: 'retained-source-closure',
    check(value) {
      expect(value).not.toBe(content);
      expect(Object.isFrozen(value.sources[0].pin)).toBe(true);
      expect(() => {
        (value.sources as unknown as unknown[]).pop();
      }).toThrow();
      return true;
    },
  });
  expect(content).toEqual(before);
  for (const check of [() => 1, async () => true])
    expect(() =>
      assertPointEditProfile(content, {
        kind: 'retained-source-closure',
        check,
      } as unknown as GeoPointEditProfile),
    ).toThrow('GeoSourceClosureRequired');
});
it('closure approval does not bypass numeric bounds, stale revisions or authority revoke', async () => {
  const h = await harness(),
    snapshot = h.handle.context.basic.read();
  for (const scalar of ['NaN', 'Infinity', 'invalid']) {
    expect(h.port.execute({ ...draftFor(snapshot, target), scalar }).state).toBe('refused');
    expect(h.binding.session.content).toEqual(snapshot.content);
  }
  const prepared = h.port.prepare(snapshot, { ...draftFor(snapshot, target), scalar: '33' });
  h.revoke();
  expect(h.editor.execute(prepared).state).toBe('refused');
  expect(h.binding.session.content).toEqual(snapshot.content);
});

it('source-backed stale prepared input cannot apply after another accepted edit', async () => {
  const h = await harness(),
    snapshot = h.handle.context.basic.read();
  const prepared = h.port.prepare(snapshot, { ...draftFor(snapshot, target), scalar: '50' });
  expect(h.port.execute({ ...draftFor(snapshot, target), scalar: '40' }).state).toBe('applied');
  const current = h.binding.session.content;
  expect(h.editor.execute(prepared).state).toBe('refused');
  expect(h.binding.session.content).toEqual(current);
});

it('retained profile composes with the existing fifth-argument complete-view capacity gate', async () => {
  const h = await harness();
  const snapshot = h.handle.context.basic.read();
  const before = structuredClone(h.binding.session.content);
  expect(() =>
    preparePointEdit(
      snapshot,
      { ...draftFor(snapshot, target), scalar: '22' },
      () => ({ revision: snapshot.revision, canEdit: true, budgets }),
      budgets,
      () => {
        throw Error('FullSaveEnvelopeCapacity');
      },
      { kind: 'retained-source-closure', check: () => true },
    ),
  ).toThrow('FullSaveEnvelopeCapacity');
  expect(h.binding.session.content).toEqual(before);
  expect(h.binding.session.revision.sequence).toBe(0);
});
