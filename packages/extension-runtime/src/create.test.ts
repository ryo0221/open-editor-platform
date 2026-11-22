import { describe, expect, it, vi } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import { counterExtension, type Counter } from '@editor-platform/extension-sample';
import {
  CREATE_ADDON,
  OPERATIONS_ADDON,
  type ExtensionDefinition,
  type HostAdapter,
} from '@editor-platform/extension-contract';
import { ExtensionRegistry, parseManifest } from './index';

const hash = `sha256:${'3'.repeat(64)}`;
const admission = { trust: 'trusted' as const, verifiedPackageHash: hash };

function withCreate(create: () => unknown = () => ({ id: 'counter', value: 0 })) {
  const base = counterExtension(hash);
  return {
    ...base,
    manifest: { ...base.manifest, addons: { create: { version: CREATE_ADDON } } },
    create,
  } as ExtensionDefinition<Counter>;
}

describe('create@0-draft manifest', () => {
  it('accepts the exact token alone or beside operations, and keeps it in the canonical manifest', () => {
    const m = parseManifest(withCreate().manifest);
    expect(m.addons).toEqual({ create: { version: 'create@0-draft' } });
    expect(Object.isFrozen(m.addons!.create)).toBe(true);
    const both = parseManifest({
      ...withCreate().manifest,
      addons: {
        create: { version: CREATE_ADDON },
        operations: {
          version: OPERATIONS_ADDON,
          declarations: [
            {
              id: 'counter.reset',
              version: '1.0.0',
              title: 'Reset',
              inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            },
          ],
        },
      },
    });
    expect(Object.keys(both.addons!).sort()).toEqual(['create', 'operations']);
  });

  it('refuses unknown versions, extra fields, other shapes and an empty add-on object', () => {
    const base = withCreate().manifest;
    for (const create of [
      { version: 'create@1' },
      { version: CREATE_ADDON, input: {} },
      {},
      CREATE_ADDON,
      [CREATE_ADDON],
      null,
    ])
      expect(() => parseManifest({ ...base, addons: { create } })).toThrow(
        'Unsupported create add-on',
      );
    expect(() => parseManifest({ ...base, addons: {} })).toThrow('Unsupported add-ons');
    expect(() =>
      parseManifest({ ...base, addons: { create: { version: CREATE_ADDON }, other: {} } }),
    ).toThrow('Unsupported add-ons');
  });
});

describe('create@0-draft registration', () => {
  it('requires the package function exactly when the manifest declares the add-on', () => {
    const declared = withCreate();
    expect(() =>
      new ExtensionRegistry().install({ ...declared, create: undefined }, admission),
    ).toThrow('Create add-on/adapter mismatch');
    expect(() =>
      new ExtensionRegistry().install(
        { ...counterExtension(hash), create: () => ({ id: 'counter' as const, value: 0 }) },
        admission,
      ),
    ).toThrow('Create add-on/adapter mismatch');
    expect(new ExtensionRegistry().install(counterExtension(hash), admission).create).toBe(
      undefined,
    );
  });

  it('returns a detached, frozen JSON copy that passed the validator, once per call', () => {
    const made = { id: 'counter', value: 0 };
    const make = vi.fn(() => made);
    const registration = new ExtensionRegistry().install(withCreate(make), admission);
    const first = registration.create!();
    expect(first).toEqual({ id: 'counter', value: 0 });
    expect(first).not.toBe(made);
    expect(Object.isFrozen(first)).toBe(true);
    made.value = 9;
    expect(first.value).toBe(0);
    expect(registration.create!()).toEqual({ id: 'counter', value: 9 });
    expect(make).toHaveBeenCalledTimes(2);
  });

  it('keeps only JSON data and refuses content the validator refuses', () => {
    const keepsData = new ExtensionRegistry().install(
      withCreate(() => ({ id: 'counter', value: 0, extra: undefined })),
      admission,
    );
    expect(Object.keys(keepsData.create!())).toEqual(['id', 'value']);
    for (const result of [
      { id: 'counter', value: -1 },
      { id: 'counter', value: 0, more: 1 },
      undefined,
      () => ({ id: 'counter', value: 0 }),
      { id: 'counter', value: Number.NaN },
    ]) {
      const r = new ExtensionRegistry().install(
        withCreate(() => result),
        admission,
      );
      expect(() => r.create!()).toThrow('Invalid domain content');
    }
    const throwing = new ExtensionRegistry().install(
      withCreate(() => {
        throw new Error('package failed');
      }),
      admission,
    );
    expect(() => throwing.create!()).toThrow('package failed');
  });

  it('created content opens like any other content and stays out of history', () => {
    const registration = new ExtensionRegistry().install(withCreate(), admission);
    const session = new EditorSession<Counter>(registration.create!());
    const host: HostAdapter<Counter> = {
      artifactKind: 'example.counter',
      schemaVersion: 1,
      allowed: () => true,
      readOnly: () => false,
      read: () => session.content,
      execute: (c) => void session.execute(c),
      undo: () => void session.undo(),
      redo: () => void session.redo(),
      save: vi.fn(async () => {}),
      select: vi.fn(),
    };
    const handle = registration.open(host);
    expect(handle.api.read()).toEqual({ id: 'counter', value: 0 });
    expect(session.canUndo).toBe(false);
  });

  it('revoked registrations and Host pin checks refuse create', () => {
    const registration = new ExtensionRegistry().install(withCreate(), admission);
    registration.uninstall();
    expect(() => registration.create!()).toThrow('Registration revoked');
    let trusted = true;
    const pinned = new ExtensionRegistry().install(withCreate(), {
      ...admission,
      assertTrusted: () => {
        if (!trusted) throw new Error('Pin no longer trusted');
      },
    });
    expect(pinned.create!()).toEqual({ id: 'counter', value: 0 });
    trusted = false;
    expect(() => pinned.create!()).toThrow('Pin no longer trusted');
  });
});
