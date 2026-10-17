import { describe, expect, it, vi } from 'vitest';
import { EditorSession, command } from '@editor-platform/editor-core';
import { counterExtension, createCounter, setCounter } from '@editor-platform/extension-sample';
import type {
  HostAdapter,
  ExtensionDefinition,
  Permission,
} from '@editor-platform/extension-contract';
import { ExtensionRegistry, parseManifest, type ExtensionHandle } from './index';
const hash = `sha256:${'1'.repeat(64)}`;
const admission = { trust: 'trusted' as const, verifiedPackageHash: hash };
function fixture() {
  const registry = new ExtensionRegistry();
  const definition = counterExtension(hash);
  const registration = registry.install(definition, admission);
  const session = new EditorSession(createCounter());
  const access = {
    writable: true,
    permissions: {
      'artifact:read': true,
      'artifact:write': true,
      'selection:write': true,
    } as Record<Permission, boolean>,
  };
  const host: HostAdapter<ReturnType<typeof createCounter>> = {
    artifactKind: 'example.counter',
    schemaVersion: 1,
    allowed: (permission) => access.permissions[permission],
    readOnly: () => !access.writable,
    read: () => session.content,
    execute: (c) => {
      session.execute(c);
    },
    undo: () => {
      session.undo();
    },
    redo: () => {
      session.redo();
    },
    save: vi.fn(async () => {}),
    select: vi.fn(),
  };
  const handle = registration.open(host);
  return { registry, definition, registration, session, access, host, handle };
}
describe('draft extension boundary', () => {
  it('edits through existing atomic history and returns detached reads', () => {
    const { handle, session } = fixture();
    const copy = handle.api.read();
    copy.value = 999;
    handle.api.execute(setCounter(7));
    handle.api.undo();
    expect(session.content.value).toBe(0);
    handle.api.redo();
    expect(session.content.value).toBe(7);
    expect(session.content.id).toBe('counter');
  });
  it('invalid command result leaves content/revision/history unchanged', () => {
    const { handle, session } = fixture();
    const revision = session.revision;
    expect(() => handle.api.execute(setCounter(1001))).toThrow('Invalid domain');
    expect(session.content.value).toBe(0);
    expect(session.revision).toEqual(revision);
    expect(session.canUndo).toBe(false);
  });
  it('checks live read-only for all mutation APIs', async () => {
    const { handle, access, session, host } = fixture();
    handle.api.execute(setCounter(5));
    access.writable = false;
    for (const action of [
      () => handle.api.execute(setCounter(1)),
      handle.api.undo,
      handle.api.redo,
    ])
      expect(action).toThrow('Permission denied');
    await expect(handle.api.save()).rejects.toThrow('Permission denied');
    expect(host.save).not.toHaveBeenCalled();
    expect(session.content.value).toBe(5);
  });
  it('checks revocation after command computation before committing', () => {
    const { handle, access, session } = fixture();
    expect(() =>
      handle.api.execute(
        command('revoke', 'Revoke', (c) => {
          access.writable = false;
          return { ...c, value: 3 };
        }),
      ),
    ).toThrow('Permission denied');
    expect(session.canUndo).toBe(false);
    expect(session.content.value).toBe(0);
  });
  it('checks read permission on retained API references', () => {
    const { handle, access } = fixture();
    access.permissions['artifact:read'] = false;
    expect(handle.api.read).toThrow('Permission denied');
  });
  it.each(['artifact:read', 'artifact:write'] as const)(
    'refuses all content mutations when only %s is revoked',
    async (permission) => {
      const { handle, access, session, host } = fixture();
      handle.api.execute(setCounter(4));
      handle.api.execute(setCounter(7));
      handle.api.undo(); // Both past and future history are populated.
      const before = {
        content: session.content,
        revision: session.revision,
        undo: session.canUndo,
        redo: session.canRedo,
      };
      const execute = vi.spyOn(host, 'execute');
      const undo = vi.spyOn(host, 'undo');
      const redo = vi.spyOn(host, 'redo');
      const apply = vi.fn((content: ReturnType<typeof createCounter>) => content);
      access.permissions[permission] = false;
      if (permission === 'artifact:read') expect(handle.api.read).toThrow('Permission denied');
      else expect(handle.api.read()).toEqual(before.content);
      expect(() => handle.api.execute(command('capture', 'Capture', apply))).toThrow(
        'Permission denied',
      );
      expect(handle.api.undo).toThrow('Permission denied');
      expect(handle.api.redo).toThrow('Permission denied');
      await expect(handle.api.save()).rejects.toThrow('Permission denied');
      expect(apply).not.toHaveBeenCalled();
      for (const callback of [execute, undo, redo, host.save])
        expect(callback).not.toHaveBeenCalled();
      expect({
        content: session.content,
        revision: session.revision,
        undo: session.canUndo,
        redo: session.canRedo,
      }).toEqual(before);
    },
  );
  it.each(['artifact:read', 'artifact:write'] as const)(
    'rechecks %s after Host dispatch before exposing content to apply',
    (permission) => {
      const { registration, host, access, session } = fixture();
      const handle = registration.open({
        ...host,
        execute: (cmd) => {
          access.permissions[permission] = false;
          session.execute(cmd);
        },
      });
      const before = session.revision;
      const apply = vi.fn((content: ReturnType<typeof createCounter>) => content);
      expect(() => handle.api.execute(command('capture', 'Capture', apply))).toThrow(
        'Permission denied',
      );
      expect(apply).not.toHaveBeenCalled();
      expect(session.revision).toEqual(before);
      expect(session.canUndo).toBe(false);
    },
  );
  it.each(['artifact:read', 'artifact:write'] as const)(
    'rechecks %s after computation before committing history',
    (permission) => {
      const { handle, access, session } = fixture();
      const before = session.revision;
      expect(() =>
        handle.api.execute(
          command('revoke', 'Revoke', (content) => {
            access.permissions[permission] = false;
            return { ...content, value: 9 };
          }),
        ),
      ).toThrow('Permission denied');
      expect(session.content).toEqual(createCounter());
      expect(session.revision).toEqual(before);
      expect(session.canUndo).toBe(false);
    },
  );
  it('denies capabilities not declared or not implemented', () => {
    const { handle } = fixture();
    for (const cap of ['shared-editing', 'export', 'selection', 'unknown'])
      expect(() => handle.api.requireCapability(cap)).toThrow(`Unsupported capability: ${cap}`);
    expect(() => handle.api.select(['counter'])).toThrow('Unsupported capability');
  });
  it.each([
    { contractVersion: '1.0.0' },
    { capabilities: ['shared-editing'] },
    { capabilities: ['local-edit', 'local-edit'] },
    { permissions: ['credentials:read'] },
    { schemaVersion: 0 },
    { schemaVersion: Infinity },
    { id: '../x' },
    { packageHash: 'unverified' },
    { version: 'latest' },
    { licenseNotices: [1] },
  ])('rejects invalid manifest %j', (patch) => {
    expect(() => parseManifest({ ...counterExtension(hash).manifest, ...patch })).toThrow();
  });
  it('rejects untrusted before invoking validator or mounting code', () => {
    const def = counterExtension(hash);
    const validate = vi.fn(def.validate);
    const mount = vi.fn(def.mount!);
    expect(() =>
      new ExtensionRegistry().install(
        {
          ...def,
          validate: (value): value is ReturnType<typeof createCounter> => validate(value),
          mount,
        },
        { ...admission, trust: 'untrusted' },
      ),
    ).toThrow('Untrusted');
    expect(validate).not.toHaveBeenCalled();
    expect(mount).not.toHaveBeenCalled();
  });
  it('rejects hash mismatch and capability/adapter mismatch', () => {
    const registry = new ExtensionRegistry();
    const def = counterExtension(hash);
    expect(() => registry.install(def, { ...admission, verifiedPackageHash: 'different' })).toThrow(
      'hash mismatch',
    );
    expect(() => registry.install({ ...def, mount: undefined }, admission)).toThrow(
      'Surface capability',
    );
  });
  it('failed install/replacement preserves working old registration', () => {
    const { registry, definition, handle } = fixture();
    expect(() => registry.install(definition, admission)).toThrow('Already installed');
    const otherHash = `sha256:${'2'.repeat(64)}`;
    expect(() =>
      registry.install(counterExtension(otherHash), {
        ...admission,
        verifiedPackageHash: otherHash,
        replace: true,
      }),
    ).toThrow('Immutable');
    expect(handle.api.read().value).toBe(0);
  });
  it('replacement revokes old handles; stale uninstall does not remove replacement', () => {
    const { registry, definition, registration, handle, host } = fixture();
    const replacement = registry.install(
      { ...definition, manifest: { ...definition.manifest, version: '0.0.2' } },
      { ...admission, replace: true },
    );
    expect(handle.api.read).toThrow('revoked');
    registration.uninstall();
    expect(replacement.open(host).api.read().value).toBe(0);
    replacement.uninstall();
    expect(() => replacement.open(host)).toThrow('revoked');
  });
  it('checks kind, schema and content before opening', () => {
    const { registration, host } = fixture();
    expect(() => registration.open({ ...host, artifactKind: 'video' })).toThrow('kind/schema');
    expect(() => registration.open({ ...host, schemaVersion: 2 })).toThrow('kind/schema');
    expect(() =>
      registration.open({ ...host, read: () => ({ id: 'counter', value: NaN }) }),
    ).toThrow('Invalid domain');
  });
  it('uses immutable manifest snapshot and denies duplicate kind', () => {
    const { registry, definition, registration } = fixture();
    definition.manifest.version = '8.0.0';
    expect(registration.manifest.version).toBe('0.0.1');
    expect(() =>
      registry.install(
        { ...definition, manifest: { ...definition.manifest, id: 'different' } },
        admission,
      ),
    ).toThrow('kind already');
  });
  it('revokes all handles even when one cleanup throws', () => {
    const { host } = fixture();
    const cleanup = vi.fn(() => {
      throw new Error('cleanup failed');
    });
    const definition: ExtensionDefinition<ReturnType<typeof createCounter>> = {
      ...counterExtension(hash),
      mount: () => cleanup,
    };
    const reg = new ExtensionRegistry().install(definition, admission);
    const a = reg.open(host),
      b = reg.open(host);
    // Dummy container is never accessed by this trusted test adapter.
    a.mount({} as HTMLElement);
    b.mount({} as HTMLElement);
    reg.uninstall();
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(a.api.read).toThrow('revoked');
    expect(b.api.read).toThrow('revoked');
  });
  it.each(['replace', 'uninstall'] as const)(
    'rejects cleanup reentrancy during %s without orphaning handles',
    (transition) => {
      const { host } = fixture();
      const registry = new ExtensionRegistry();
      const definition = counterExtension(hash);
      const other = registry.install(
        {
          ...definition,
          manifest: { ...definition.manifest, id: 'other.counter', artifactKind: 'other.counter' },
        },
        admission,
      );
      const otherHost = { ...host, artifactKind: 'other.counter' };
      const errors: string[] = [];
      let nested: ExtensionHandle<ReturnType<typeof createCounter>> | undefined;
      const old = registry.install(
        {
          ...definition,
          mount: () => () => {
            const attempt = (fn: () => void) => {
              try {
                fn();
              } catch (error) {
                errors.push((error as Error).message);
              }
            };
            attempt(() => {
              nested = registry
                .install(
                  { ...definition, manifest: { ...definition.manifest, version: '0.0.3' } },
                  { ...admission, replace: true },
                )
                .open(host);
            });
            attempt(() => {
              other.open(otherHost);
            });
            attempt(() => other.uninstall());
          },
        },
        admission,
      );
      const oldHandle = old.open(host);
      oldHandle.mount({} as HTMLElement);
      if (transition === 'replace') {
        const replacement = registry.install(
          { ...definition, manifest: { ...definition.manifest, version: '0.0.2' } },
          { ...admission, replace: true },
        );
        replacement.uninstall();
      } else old.uninstall();
      // Previously nested C survived B.uninstall because B overwrote C's map entry.
      expect(nested?.api.read()).toBeUndefined();
      expect(errors).toEqual(Array(3).fill('Registry transition in progress'));
      expect(oldHandle.api.read).toThrow('revoked');
      expect(other.open(otherHost).api.read()).toEqual(createCounter());
      // The guard is released after completion, including prior validation failures.
      expect(() =>
        registry.install(
          { ...definition, manifest: { ...definition.manifest, packageHash: 'bad' } },
          admission,
        ),
      ).toThrow('hash');
      const fresh = registry.install(definition, admission);
      expect(fresh.open(host).api.read()).toEqual(createCounter());
    },
  );
  it('close is idempotent and mounting twice is rejected', () => {
    const { host } = fixture();
    const cleanup = vi.fn();
    const reg = new ExtensionRegistry().install(
      { ...counterExtension(hash), mount: () => cleanup },
      admission,
    );
    const h = reg.open(host);
    h.mount({} as HTMLElement);
    expect(() => h.mount({} as HTMLElement)).toThrow('Already mounted');
    h.close();
    h.close();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(h.api.read).toThrow('closed');
  });
  it('propagates persistence failure without changing history', async () => {
    const { registration, host, session } = fixture();
    const h = registration.open({
      ...host,
      save: async () => {
        throw new Error('Storage failure');
      },
    });
    await expect(h.api.save()).rejects.toThrow('Storage failure');
    expect(session.canUndo).toBe(false);
  });
});
