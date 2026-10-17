import { expect, it, vi } from 'vitest';
import { ReferenceRegistry } from '../draft2';
import { ManualClock } from '../draft2/reference';
import {
  SchemaEditExperimentRegistry,
  createSchemaEditController,
} from '../schema-edit-experiment';
import { parseManifest, parseBinding } from './admission';
import { definition, setup } from './fixture';
it.each([
  { kind: 'numeric', value: 1 },
  { kind: 'literal', value: 'test-native-v0' },
] as const)('admits genuine %j, advancing revision on one fixed session/generation', (identity) => {
  const h = setup({ identity }),
    scope = h.handle.scope;
  expect(h.execute(2).state).toBe('applied');
  expect(h.handle.context.basic.read().content.value).toBe(2);
  expect(h.handle.scope).toEqual(scope);
  expect(h.session.revision.sequence).toBe(1);
  expect(h.handle.context).not.toHaveProperty('resources');
  expect(h.handle.context.addons).not.toHaveProperty('resources');
  expect(() => createSchemaEditController(h.old.context as never, { onError: () => {} })).toThrow(
    'contract',
  );
});
it.each(['schemaVersion', 'extra', Symbol('hidden')])(
  'rejects mixed/extra field %s without invoking it',
  (key) => {
    const value = definition().manifest,
      read = vi.fn(() => 1);
    Object.defineProperty(value, key, { enumerable: false, get: read });
    expect(() => parseManifest(value)).toThrow();
    expect(read).not.toHaveBeenCalled();
  },
);
it('rejects inherited fields, accessors, wrong identities/tokens and resource requests', () => {
  for (const patch of [
    { contractVersion: '1.0.0-draft.2' },
    { contractVersion: '1.0.0-experiment.schema.1' },
    { schemaIdentity: { kind: 'literal', value: 1 } },
    { schemaIdentity: { kind: 'numeric', value: '1' } },
    { schemaIdentity: { kind: 'numeric', value: 0 } },
    { permissions: ['artifact:read', 'resource:read'] },
    {
      addons: {
        ...definition().manifest.addons,
        resources: { version: 'resources@0-draft', requirement: 'optional' },
      },
    },
  ])
    expect(() => parseManifest({ ...definition().manifest, ...patch })).toThrow();
  const getter = vi.fn(() => 1);
  const value = definition().manifest;
  Object.defineProperty(value.schemaIdentity, 'value', { get: getter });
  expect(() => parseManifest(value)).toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(() => parseManifest(Object.create(definition().manifest))).toThrow();
  const list = ['artifact:read'];
  Object.setPrototypeOf(list, { ...Array.prototype });
  expect(() => parseManifest({ ...definition().manifest, permissions: list })).toThrow();
});
it('captures binding once and rejects old/mixed/accessor/hidden binding fields without invoking', () => {
  const h = setup();
  for (const key of ['schemaVersion', 'resources', 'extra'])
    expect(() => parseBinding({ ...h.binding, [key]: undefined })).toThrow();
  const getter = vi.fn(() => h.session);
  const v = { ...h.binding };
  Object.defineProperty(v, 'session', { get: getter });
  expect(() => parseBinding(v)).toThrow();
  expect(getter).not.toHaveBeenCalled();
  const copied = parseBinding(h.binding);

  expect(copied.session).toBe(h.session);
});
it('requires trusted pin and exact supported kind/identity pairs', () => {
  const d = definition(),
    r = new SchemaEditExperimentRegistry(new ReferenceRegistry(new ManualClock()), [
      { artifactKind: 'other', schemaIdentity: d.manifest.schemaIdentity },
    ]);
  expect(() =>
    r.install(d, {
      trust: 'trusted',
      verifiedPin: {
        id: d.manifest.id,
        version: d.manifest.version,
        packageHash: d.manifest.packageHash,
      },
    }),
  ).toThrow('schema');
  expect(() =>
    r.install(d, {
      trust: 'untrusted',
      verifiedPin: {
        id: d.manifest.id,
        version: d.manifest.version,
        packageHash: d.manifest.packageHash,
      },
    }),
  ).toThrow('trust');
  const h = setup();
  expect(
    h.installed.open({ ...h.binding, schemaIdentity: { kind: 'literal', value: '1' } }),
  ).toEqual({ state: 'refused', code: 'schema' });
  expect(h.installed.open({ ...h.binding, artifactKind: 'other' })).toEqual({
    state: 'refused',
    code: 'schema',
  });
  expect(() => new SchemaEditExperimentRegistry(new ManualClock() as never, [])).toThrow('Owner');
});
it('rejects invalid native before open and refuses invalid schema/native before commit', () => {
  const h = setup();
  expect(h.execute(-1).state).toBe('refused');
  expect(h.session.revision.sequence).toBe(0);
  expect(() => {
    const edit = h.handle.context.addons.edit;
    if (edit.state === 'granted')
      edit.api.execute({ type: 'bad', label: 'bad', apply: (v) => ({ ...v, schemaVersion: 2 }) });
  }).toThrow('schema');
  expect(h.session.revision.sequence).toBe(0);
  h.session.execute({ type: 'external', label: 'external', apply: (v) => ({ ...v, value: -1 }) });
  expect(() => h.open()).toThrow('InvalidContent');
});
it.each([false, true])(
  'missing Inputs / edit grant leaves canonical state readonly: %s',
  (noInputs) => {
    const h = setup(noInputs ? { inputs: false } : { grants: ['artifact:read'] });
    expect(h.controller.getSnapshot()).toMatchObject({ state: 'open', canEdit: false });
    expect(h.execute(2).state).toBe('refused');
    expect(h.session.content.value).toBe(0);
  },
);
it('grant loss revokes entire scope and fresh readonly stays independent', async () => {
  const h = setup();
  h.grants(['artifact:read']);
  expect(h.controller.getSnapshot().state).toBe('revoked');
  expect(h.execute(3).state).toBe('refused');
  expect(await h.handle.drain({ deadlineMs: 1000 })).toMatchObject({
    state: 'drained',
    failed: [],
  });
  const fresh = h.open();
  expect(fresh.scope.generation).not.toBe(h.handle.scope.generation);
  expect(fresh.context.addons.edit.state).toBe('unavailable');
});
