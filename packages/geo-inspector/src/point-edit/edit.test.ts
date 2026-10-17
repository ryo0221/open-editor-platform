import { it, expect } from 'vitest';
import { command } from '@editor-platform/editor-core';
import { contentHash } from '@editor-platform/artifact-core';
import { editHarness } from '../../test-host/edit-fixture';
import { PointInputBuffer } from './buffer';
import { draftFor } from './model';
const target = { layerId: 'synthetic-sites', featureId: 'point-1', fieldId: 'metric' };
function harness(mode: Parameters<typeof editHarness>[0] = 'editable') {
  const h = editHarness(mode),
    buffer = new PointInputBuffer(h.port.prepare);
  if (mode !== 'source') buffer.select(h.handle.context.basic.read(), target);
  const registration = h.editor.bindInputs(buffer);
  return { ...h, buffer, registration };
}
it('distinct editable capability requests no save/resources; missing edit or Inputs stays readonly', () => {
  for (const mode of ['readonly', 'no-inputs'] as const) {
    const h = harness(mode);
    expect(h.editor.getSnapshot()).toMatchObject({ state: 'open', canEdit: false, canSave: false });
    h.buffer.change({ longitude: '12.5' });
    h.registration.changed();
    const before = h.binding.session.content;
    expect(h.editor.applyInputs().state).toBe('refused');
    expect(h.port.execute(draftFor(h.handle.context.basic.read(), target)).state).toBe('refused');
    expect(h.binding.session.content).toEqual(before);
  }
  expect(harness().definition.manifest.permissions).toEqual(['artifact:read', 'artifact:edit']);
});
it('pure prepare then single coordinate+scalar commit uses one native Undo/Redo', async () => {
  const h = harness(),
    initial = h.binding.session.content,
    hash = await contentHash(initial);
  h.buffer.change({ longitude: '12.5', latitude: '34.5', scalar: '25' });
  h.registration.changed();
  const prepared = h.buffer.prepare(h.handle.context.basic.read());
  expect(prepared.command).not.toBeNull();
  expect(await contentHash(h.binding.session.content)).toBe(hash);
  expect(h.binding.session.canUndo).toBe(false);
  expect(h.editor.applyInputs().state).toBe('applied');
  expect(h.binding.session.revision.sequence).toBe(1);
  expect(h.buffer.read()).toEqual({ dirty: false, composing: false });
  const changed = h.binding.session.content;
  expect(changed.layers[0].features[0]).toMatchObject({
    id: 'point-1',
    rowId: 'row-1',
    geometry: { type: 'Point', coordinates: [12.5, 34.5] },
    values: { metric: 25, code: '001', active: true },
  });
  expect(changed.layers[0].features.slice(1)).toEqual(initial.layers[0].features.slice(1));
  expect(h.port.undo().state).toBe('applied');
  expect(h.binding.session.content).toEqual(initial);
  expect(h.port.redo().state).toBe('applied');
  expect(h.binding.session.content).toEqual(changed);
});
it('UI/non-UI use identical numeric and local-range rules with failure atomicity', () => {
  for (const patch of [
    { longitude: '' },
    { latitude: ' ' },
    { longitude: 'NaN' },
    { latitude: 'Infinity' },
    { scalar: 'oops' },
    { longitude: '30' },
    { latitude: '70' },
    { longitude: '181' },
  ]) {
    const ui = harness(),
      before = ui.binding.session.content;
    ui.buffer.change(patch);
    ui.registration.changed();
    expect(ui.editor.applyInputs().state).toBe('refused');
    expect(ui.buffer.read().dirty).toBe(true);
    expect(ui.binding.session.content).toEqual(before);
    expect(ui.binding.session.canUndo).toBe(false);
    const headless = harness(),
      draft = { ...draftFor(headless.handle.context.basic.read(), target), ...patch };
    expect(headless.port.execute(draft).state).toBe('refused');
    expect(headless.binding.session.content).toEqual(before);
  }
});
it('cancel is explicit; empty/cancelled IME still pins target and blocks mutations/switches', () => {
  const h = harness(),
    before = h.binding.session.content;
  h.buffer.composition('longitude', true);
  h.registration.changed();
  expect(h.editor.applyInputs().state).toBe('refused');
  expect(h.port.undo().state).toBe('refused');
  expect(() => h.buffer.cancel(h.handle.context.basic.read())).toThrow('Composing');
  expect(() =>
    h.buffer.select(h.handle.context.basic.read(), { ...target, featureId: 'point-2' }),
  ).toThrow('Pending');
  h.buffer.composition('longitude', false);
  h.registration.changed();
  expect(h.buffer.read().dirty).toBe(true);
  expect(() =>
    h.buffer.select(h.handle.context.basic.read(), { ...target, featureId: 'point-2' }),
  ).toThrow('Pending');
  h.buffer.cancel(h.handle.context.basic.read());
  h.registration.changed();
  h.buffer.select(h.handle.context.basic.read(), { ...target, featureId: 'point-2' });
  expect(h.binding.session.content).toEqual(before);
  expect(h.binding.session.canUndo).toBe(false);
});
it('validated no-op clears buffer without changing revision or destroying Redo', () => {
  const h = harness();
  h.buffer.change({ scalar: '20' });
  h.registration.changed();
  h.editor.applyInputs();
  h.port.undo();
  h.buffer.select(h.handle.context.basic.read(), target);
  const revision = h.binding.session.revision;
  h.buffer.change({ longitude: '12.0', scalar: '10' });
  h.registration.changed();
  expect(h.editor.applyInputs().state).toBe('unchanged');
  expect(h.binding.session.revision).toEqual(revision);
  expect(h.binding.session.canRedo).toBe(true);
  expect(h.buffer.read().dirty).toBe(false);
  expect(h.port.redo().state).toBe('applied');
});
it('stale buffer refuses without clearing; fresh authority loss revokes whole scope', () => {
  const h = harness();
  h.buffer.change({ scalar: '20' });
  h.registration.changed();
  h.binding.session.execute(
    command('host-test', 'Host replacement', (content) => ({
      ...content,
      layers: content.layers.map((l) => ({ ...l, name: 'Host changed' })),
    })),
  );
  const before = h.binding.session.content;
  expect(h.editor.applyInputs().state).toBe('refused');
  expect(h.buffer.read().dirty).toBe(true);
  expect(h.binding.session.content).toEqual(before);
  const active = harness(),
    draft = draftFor(active.handle.context.basic.read(), target);
  draft.scalar = '20';
  const prepared = active.port.prepare(active.handle.context.basic.read(), draft);
  active.revoke();
  expect(active.editor.getSnapshot().state).toBe('revoked');
  expect(active.editor.execute(prepared).state).toBe('refused');
  expect(active.binding.session.canUndo).toBe(false);
});
it('execution rechecks stale revision after pure preparation, not just UI state', () => {
  const h = harness(),
    snapshot = h.handle.context.basic.read(),
    draft = { ...draftFor(snapshot, target), scalar: '20' },
    prepared = h.port.prepare(snapshot, draft);
  h.binding.session.execute(command('host-test', 'Host changed', (content) => content));
  expect(h.editor.execute(prepared).state).toBe('refused');
  expect(h.binding.session.content.layers[0].features[0].values.metric).toBe(10);
});
it('source-bearing/null/LineString targets are refused and kept, never coerced', () => {
  const source = harness('source'),
    snapshot = source.handle.context.basic.read(),
    draft = draftFor(snapshot, {
      layerId: 'synthetic-sites',
      featureId: 'site-01',
      fieldId: 'code',
    });
  expect(source.port.execute({ ...draft, longitude: '12.5' }).state).toBe('refused');
  expect(source.binding.session.content).toEqual(snapshot.content);
  expect(source.port.undo().state).toBe('refused');
  expect(source.port.redo().state).toBe('refused');
  for (const featureId of ['point-4', 'point-5']) {
    const h = harness(),
      before = h.binding.session.content,
      d = draftFor(h.handle.context.basic.read(), { ...target, featureId });
    expect(h.port.execute({ ...d, longitude: '12', latitude: '34' }).state).toBe('refused');
    expect(h.binding.session.content).toEqual(before);
  }
});
it('one selected scalar is typed, supports explicit null, leaves other fields intact', () => {
  const h = harness();
  for (const [fieldId, scalar, scalarNull, value] of [
    ['code', '<img src=x>', false, '<img src=x>'],
    ['active', 'false', false, false],
    ['metric', '', true, null],
  ] as const) {
    const draft = draftFor(h.handle.context.basic.read(), { ...target, fieldId });
    expect(h.port.execute({ ...draft, scalar, scalarNull }).state).toBe('applied');
    expect(h.binding.session.content.layers[0].features[0].values[fieldId]).toBe(value);
  }
  const invalid = draftFor(h.handle.context.basic.read(), { ...target, fieldId: 'active' });
  expect(h.port.execute({ ...invalid, scalar: 'yes', scalarNull: false }).state).toBe('refused');
});

it('oversized raw scalar is rejected before commit by the input profile', () => {
  const h = harness(),
    before = h.binding.session.content;
  const draft = draftFor(h.handle.context.basic.read(), { ...target, fieldId: 'code' });
  const result = h.port.execute({ ...draft, scalar: 'x'.repeat(65536) });
  expect(result).toMatchObject({ state: 'refused', message: 'GeoDraftTextLimit' });
  expect(h.binding.session.content).toEqual(before);
  expect(h.binding.session.canUndo).toBe(false);
  expect(h.editor.getSnapshot().state).toBe('open');
});

it('explicit Cancel can discard a stale deleted target without rebinding its edits', () => {
  const h = harness();
  h.buffer.change({ scalar: '99' });
  h.registration.changed();
  h.binding.session.execute(
    command('host-delete', 'Synthetic external deletion', (content) => ({
      ...content,
      layers: content.layers.map((l) => ({
        ...l,
        features: l.features.filter((f) => f.id !== 'point-1'),
      })),
    })),
  );
  const before = h.binding.session.content;
  expect(h.editor.applyInputs().state).toBe('refused');
  expect(h.buffer.draft()?.target.featureId).toBe('point-1');
  h.buffer.cancel(h.handle.context.basic.read());
  h.registration.changed();
  expect(h.buffer.draft()).toBeNull();
  expect(h.buffer.read().dirty).toBe(false);
  h.buffer.select(h.handle.context.basic.read(), { ...target, featureId: 'point-2' });
  expect(h.buffer.draft()?.scalar).toBe('10');
  expect(h.binding.session.content).toEqual(before);
});

it('bounded raw input still cannot overflow the unchanged controlled view limit', () => {
  const h = harness();
  h.binding.session.execute(
    command('host-fixture', 'Large native fixture', (content) => ({
      ...content,
      layers: content.layers.map((l) => ({
        ...l,
        features: l.features.map((f) =>
          f.id === 'point-2' ? { ...f, values: { ...f.values, code: 'x'.repeat(62000) } } : f,
        ),
      })),
    })),
  );
  const snapshot = h.handle.context.basic.read(),
    before = h.binding.session.content,
    revision = h.binding.session.revision;
  const draft = { ...draftFor(snapshot, { ...target, fieldId: 'code' }), scalar: 'x'.repeat(4096) };
  expect(() => h.port.prepare(snapshot, draft)).toThrow('GeoControlledCapacity');
  expect(h.binding.session.content).toEqual(before);
  expect(h.binding.session.revision).toEqual(revision);
});
