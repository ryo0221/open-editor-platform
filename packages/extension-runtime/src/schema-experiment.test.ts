import { expect, it } from 'vitest';
import { EditorSession, command } from '@editor-platform/editor-core';
import {
  SCHEMA_EXPERIMENT_VERSION,
  type SchemaExperimentDefinition,
} from '@editor-platform/extension-contract/schema-experiment';
import {
  SchemaExperimentRegistry,
  type SchemaExperimentBinding,
} from '@editor-platform/extension-runtime/schema-experiment';
import { ReferenceRegistry } from '@editor-platform/extension-runtime/draft2';
import { ManualClock } from '@editor-platform/extension-runtime/reference';

type Content = { schema: 'video-core-prototype-v0'; value: string };
const schemaIdentity = { kind: 'literal', value: 'video-core-prototype-v0' } as const;
function setup() {
  const clock = new ManualClock();
  const registry = new SchemaExperimentRegistry(clock, [{ artifactKind: 'video', schemaIdentity }]);
  const definition: SchemaExperimentDefinition<Content> = {
    manifest: {
      id: 'test',
      version: '0',
      packageHash: 'a'.repeat(64),
      contractVersion: SCHEMA_EXPERIMENT_VERSION,
      artifactKind: 'video',
      schemaIdentity,
      surface: false,
      permissions: ['artifact:read'],
      addons: { lifecycle: { version: 'lifecycle@0-draft', requirement: 'required' } },
      licenseNotices: [],
    },
    validate: (c): c is Content =>
      typeof c === 'object' && c !== null && (c as Content).schema === schemaIdentity.value,
    schemaOf: (c) => ({ kind: 'literal', value: c.schema }),
  };
  let allowed = true;
  const listeners = new Set<() => void>();
  const binding: SchemaExperimentBinding<Content> = {
    artifactId: 'video-1',
    artifactKind: 'video',
    schemaIdentity,
    session: new EditorSession({ schema: schemaIdentity.value, value: 'initial' }),
    allowedRead: () => allowed,
    subscribeReadPermission(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  const install = () =>
    registry.install(definition, { trust: 'trusted', verifiedPin: definition.manifest });
  const deny = () => {
    allowed = false;
    for (const fn of [...listeners]) fn();
  };
  return { clock, registry, definition, binding, install, deny, listeners };
}
it('admits an exact native discriminator, copies snapshots and drains owned lifecycle', async () => {
  const h = setup(),
    opened = h.install().open(h.binding);
  if (opened.state !== 'opened') throw new Error(opened.code);
  const { handle } = opened;
  const snapshot = handle.context.basic.read();
  expect(Object.isFrozen(snapshot.content)).toBe(true);
  let disposed = 0;
  handle.context.lifecycle.registerDisposable('view', () => {
    disposed++;
  });
  h.deny();
  expect(handle.context.lifecycle.signal.aborted).toBe(true);
  expect(() => handle.context.basic.read()).toThrow('ScopeRevoked');
  expect(h.listeners.size).toBe(0);
  expect(disposed).toBe(1);
  await Promise.resolve();
  expect(await handle.drain({ deadlineMs: 0 })).toMatchObject({ state: 'drained' });
});
it('rejects trust, pin, unsupported capability, version and schema without coercion', () => {
  for (const change of [
    { permissions: ['artifact:read', 'artifact:edit'] },
    { contractVersion: '1.0.0-draft.2' },
    { schemaIdentity: { kind: 'numeric', value: 1 } },
    { schemaIdentity: { kind: 'literal', value: '1' } },
    { addons: { lifecycle: { version: 'lifecycle@0-draft', requirement: 'optional' } } },
  ]) {
    const h = setup();
    Object.assign(h.definition.manifest, change);
    expect(h.install).toThrow();
  }
  const h = setup();
  expect(() =>
    h.registry.install(h.definition, { trust: 'untrusted', verifiedPin: h.definition.manifest }),
  ).toThrow('trust');
  expect(() =>
    h.registry.install(h.definition, {
      trust: 'trusted',
      verifiedPin: { ...h.definition.manifest, packageHash: 'b'.repeat(64) },
    }),
  ).toThrow('pin');
  const old = new ReferenceRegistry(h.clock);
  // Runtime rejection matters even if a consumer bypasses TypeScript.
  expect(() =>
    old.install(h.definition as never, { trust: 'trusted', verifiedPin: h.definition.manifest }),
  ).toThrow();
});
it('checks native content before delivery and preserves Basic data limits', () => {
  const invalid = setup();
  invalid.binding.session = new EditorSession({ schema: 'wrong', value: '' } as unknown as Content);
  expect(() => invalid.install().open(invalid.binding)).toThrow('InvalidContent');
  const large = setup();
  large.binding.session.execute(
    command('large', 'large', (c) => ({ ...c, value: 'a'.repeat(65536) })),
  );
  expect(() => large.install().open(large.binding)).toThrow('DataLimit');
  const h = setup(),
    installed = h.install();
  expect(installed.open({ ...h.binding, schemaIdentity: { kind: 'numeric', value: 1 } })).toEqual({
    state: 'refused',
    code: 'schema',
  });
  h.deny();
  expect(installed.open(h.binding)).toEqual({ state: 'refused', code: 'grant' });
});
it('copies admission metadata and rejects reads when native schema later changes', () => {
  const h = setup(),
    installed = h.install();
  Object.assign(h.definition.manifest, { artifactKind: 'changed' });
  const opened = installed.open(h.binding);
  if (opened.state !== 'opened') throw new Error(opened.code);
  h.binding.session.execute(
    command('bad', 'bad', (c) => ({ ...c, schema: 'other' }) as unknown as Content),
  );
  expect(() => opened.handle.context.basic.read()).toThrow('ScopeRevoked');
  h.registry.uninstall('test');
  expect(() => installed.open(h.binding)).toThrow('Uninstalled');
});
it('unsubscribes a subscription returned after synchronous revocation', () => {
  const h = setup();
  let stopped = 0;
  h.binding.subscribeReadPermission = (fn) => {
    h.deny();
    fn();
    return () => {
      stopped++;
    };
  };
  expect(() => h.install().open(h.binding)).toThrow('ScopeRevoked');
  expect(stopped).toBe(1);
});
it('reports disposal failure instead of claiming drained', async () => {
  const h = setup(),
    opened = h.install().open(h.binding);
  if (opened.state !== 'opened') throw new Error(opened.code);
  opened.handle.context.lifecycle.registerDisposable('failing', () => {
    throw new Error('cleanup-failed');
  });
  opened.handle.revoke();
  expect(await opened.handle.drain({ deadlineMs: 0 })).toMatchObject({
    state: 'incomplete',
    failed: [{ resourceId: 'extension:failing', reason: 'Error: cleanup-failed' }],
  });
});
it('refuses mixed old binding fields before invoking any provider', () => {
  const h = setup();
  expect(() => h.install().open({ ...h.binding, schemaVersion: 1 } as typeof h.binding)).toThrow(
    'binding',
  );
});
it('rejects accessors on every binding field without evaluating them', () => {
  for (const field of [
    'artifactId',
    'artifactKind',
    'schemaIdentity',
    'session',
    'allowedRead',
    'subscribeReadPermission',
  ]) {
    const h = setup();
    let calls = 0;
    Object.defineProperty(h.binding, field, {
      enumerable: true,
      get() {
        calls++;
        throw new Error('getter-ran');
      },
    });
    expect(() => h.install().open(h.binding)).toThrow('binding');
    expect(calls).toBe(0);
  }
});
it('rejects hidden/unknown fields, malformed providers and nested schema getters', () => {
  for (const field of ['schema', 'schemaVersion', 'unknown', Symbol('hidden')]) {
    const h = setup();
    Object.defineProperty(h.binding, field, { value: 1, enumerable: false });
    expect(() => h.install().open(h.binding)).toThrow('binding');
  }
  for (const change of [
    { artifactId: '' },
    { artifactKind: '' },
    { session: {} },
    { allowedRead: 1 },
    { subscribeReadPermission: null },
  ]) {
    const h = setup();
    Object.assign(h.binding, change);
    expect(() => h.install().open(h.binding)).toThrow('binding');
  }
  const h = setup();
  let calls = 0;
  h.binding.schemaIdentity = {
    kind: 'literal',
    get value() {
      calls++;
      return 'video-core-prototype-v0' as const;
    },
  };
  expect(() => h.install().open(h.binding)).toThrow('Data');
  expect(calls).toBe(0);
});
it('pins binding wiring while retaining live authority provider closures', () => {
  const h = setup(),
    opened = h.install().open(h.binding);
  if (opened.state !== 'opened') throw Error(opened.code);
  Object.defineProperty(h.binding, 'session', {
    get() {
      throw Error('late-getter');
    },
  });
  expect(opened.handle.context.basic.read().content.value).toBe('initial');
  h.deny();
  expect(() => opened.handle.context.basic.read()).toThrow('ScopeRevoked');
});

it('rejects inherited mixed fields but accepts an explicit null-prototype provider record', () => {
  const h = setup(),
    installed = h.install();
  expect(() =>
    installed.open(Object.assign(Object.create({ schemaVersion: 1 }), h.binding)),
  ).toThrow('binding');
  expect(installed.open(Object.assign(Object.create(null), h.binding)).state).toBe('opened');
});
