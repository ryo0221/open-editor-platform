import { expect, it } from 'vitest';
import { command } from '@editor-platform/editor-core';
import {
  SchemaEditExperimentRegistry,
  createSchemaEditController,
} from '../schema-edit-experiment';
import { setup, definition, type Native } from './fixture';
import { granted } from '../draft2/harness';
it('refuses stale outer commit after a Host callback advances the same Core revision', () => {
  const h = setup();
  let once = true;
  const result = h.controller.execute({
    baseRevision: h.session.revision,
    command: command<Native>('outer', 'outer', (v) => {
      if (once) {
        once = false;
        h.session.execute(command('host', 'host', (v) => ({ ...v, value: 3 })));
      }
      return { ...v, value: 8 };
    }),
  });
  expect(result.state).toBe('refused');
  expect(h.session.content.value).toBe(3);
  expect(h.session.revision.sequence).toBe(1);
});
it('captures native validators once and checks native changes on every read', () => {
  const h = setup(),
    base = definition(),
    d = { ...base, manifest: { ...base.manifest, id: 'second' } };
  const registry = new SchemaEditExperimentRegistry(h.owner, [
    { artifactKind: 'test', schemaIdentity: d.manifest.schemaIdentity },
  ]);
  const installed = registry.install(d, {
    trust: 'trusted',
    verifiedPin: {
      id: d.manifest.id,
      version: d.manifest.version,
      packageHash: d.manifest.packageHash,
    },
  });
  d.validate = (_v: unknown): _v is Native => true;
  h.session.execute(command('host', 'host', (v) => ({ ...v, value: -1 })));
  expect(() => installed.open(h.binding)).toThrow('InvalidContent');
});
it('checks scope again when native validator revokes synchronously, before commit or delivery', () => {
  const h = setup(),
    base = definition(),
    d = { ...base, manifest: { ...base.manifest, id: 'reentrant' } };
  let revoke = () => {};
  const native = d.validate;
  d.validate = (v: unknown): v is Native => {
    revoke();
    return native(v);
  };
  const registry = new SchemaEditExperimentRegistry(h.owner, [
    { artifactKind: 'test', schemaIdentity: d.manifest.schemaIdentity },
  ]);
  const installed = registry.install(d, {
    trust: 'trusted',
    verifiedPin: {
      id: d.manifest.id,
      version: d.manifest.version,
      packageHash: d.manifest.packageHash,
    },
  });
  const r = installed.open(h.binding);
  if (r.state !== 'opened') throw Error(r.code);
  const editor = createSchemaEditController(r.handle.context, { onError: () => {} });
  revoke = () => {
    r.handle.revoke('host-close');
  };
  expect(
    editor.execute({
      baseRevision: h.session.revision,
      command: command<Native>('set', 'set', (v) => ({ ...v, value: 9 })),
    }).state,
  ).toBe('refused');
  expect(h.session.revision.sequence).toBe(0);
  expect(() =>
    granted(r.handle.context.addons.edit).execute(
      command('set', 'set', (v) => ({ ...v, value: 9 })),
    ),
  ).toThrow('ScopeRevoked');
});
it('rechecks permission callback-induced revoke before save/edit', () => {
  const h = setup();
  let revoke = () => {};
  const r = h.installed.open({
    ...h.binding,
    allowed: (g) => {
      revoke();
      return h.binding.allowed(g);
    },
  });
  if (r.state !== 'opened') throw Error(r.code);
  revoke = () => {
    r.handle.revoke('host-close');
  };
  expect(() =>
    granted(r.handle.context.addons.edit).execute(
      command('set', 'set', (v) => ({ ...v, value: 9 })),
    ),
  ).toThrow('ScopeRevoked');
  expect(h.session.revision.sequence).toBe(0);
});
