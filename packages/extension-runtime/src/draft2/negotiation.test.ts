import { describe, it, expect, vi } from 'vitest';
import type { Basic, Context, ManifestD2 } from '@editor-platform/extension-contract/draft2';
import { ReferenceRegistry, adaptLegacy } from '../draft2';
import { ManualClock, referenceBinding, toyDefinition, toyManifest } from './reference';
import { api, harness, setValue } from './harness';
import { parseManifest } from './manifest';
import { copyData } from './primitives';

describe('draft.2 negotiation', () => {
  it('N01 exact pins and requested immutable slots; no Host controller in context', () => {
    const h = harness();
    expect(Object.isFrozen(h.handle.scope)).toBe(true);
    expect(Object.keys(h.handle.context)).toEqual(['basic', 'addons']);
    expect(h.handle.context.basic.read().content).toEqual({ value: 0 });
    expect(h.installed.pin.packageHash).toBe(toyManifest.packageHash);
    h.definition.manifest.permissions = [];
    api(h.handle, 'edit').execute(setValue(1));
    expect(h.handle.context.basic.read().content.value).toBe(1);
  });
  it.each(['unsupported', 'version-mismatch'] as const)(
    'N02 required %s refuses before effects',
    (reason) => {
      const def = toyDefinition();
      if (reason === 'version-mismatch')
        Object.assign(def.manifest.addons.edit!, { version: 'future' });
      const registry = new ReferenceRegistry(
        new ManualClock(),
        reason === 'unsupported' ? ['lifecycle'] : undefined,
      );
      const entry = registry.install(def, { trust: 'trusted', verifiedPin: def.manifest });
      expect(entry.open(referenceBinding({ value: 0 }))).toMatchObject({
        state: 'refused',
        code: 'required-addon',
        addon: 'edit',
      });
    },
  );
  it('N03 optional mismatch/unsupported and absent request remain explicit', () => {
    const def = toyDefinition();
    def.manifest.addons = {
      save: { version: 'future', requirement: 'optional' },
    } as unknown as ManifestD2['addons'];
    const registry = new ReferenceRegistry(new ManualClock());
    const entry = registry.install(def, { trust: 'trusted', verifiedPin: def.manifest });
    const result = entry.open(referenceBinding({ value: 0 }));
    expect(result.state).toBe('opened');
    if (result.state === 'opened') {
      expect(result.handle.context.addons.save).toEqual({
        state: 'unavailable',
        reason: 'version-mismatch',
      });
      expect(result.handle.context.addons.edit).toEqual({
        state: 'unavailable',
        reason: 'not-requested',
      });
    }
  });
  it.each([
    { extra: true },
    { permissions: ['artifact:read', 'artifact:read'] },
    { addons: { foo: { version: '1', requirement: 'required' } } },
    { addons: { edit: { version: 3, requirement: 'required' } } },
    { surface: true, addons: {} },
    { schemaVersion: 'video/1' },
  ])('N04/N06 rejects malformed manifest %j', (patch) => {
    expect(() => parseManifest({ ...toyManifest, ...patch })).toThrow();
  });
  it('N04 rejects accessor JSON without calling it', () => {
    const getter = vi.fn();
    expect(() =>
      copyData({
        get x() {
          getter();
          return 1;
        },
      }),
    ).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it('N05 untrusted or wrong pin cannot invoke any module hook', () => {
    const definition = toyDefinition();
    definition.mount = vi.fn();
    const registry = new ReferenceRegistry(new ManualClock());
    expect(() =>
      registry.install(definition, { trust: 'untrusted', verifiedPin: definition.manifest }),
    ).toThrow('trust');
    expect(() =>
      registry.install(definition, {
        trust: 'trusted',
        verifiedPin: { ...definition.manifest, packageHash: 'b'.repeat(64) },
      }),
    ).toThrow('pin');
    expect(definition.mount).not.toHaveBeenCalled();
  });
  it('N06 wrong artifact/schema refuses', () => {
    const h = harness();
    expect(h.installed.open({ ...h.binding, schemaVersion: 2 })).toEqual({
      state: 'refused',
      code: 'schema',
    });
    expect(h.installed.open({ ...h.binding, artifactKind: 'video' })).toEqual({
      state: 'refused',
      code: 'schema',
    });
  });
  it('N07 read-only surface mounts once and closes without mutation', async () => {
    const definition = toyDefinition();
    definition.manifest.permissions = ['artifact:read'];
    definition.manifest.addons = {
      lifecycle: { version: 'lifecycle@0-draft', requirement: 'required' },
    };
    definition.manifest.surface = true;
    const cleanup = vi.fn();
    definition.mount = (_container, context) => {
      if (context.addons.lifecycle.state === 'granted')
        context.addons.lifecycle.api.registerDisposable('surface', cleanup);
    };
    const binding = referenceBinding({ value: 1 });
    binding.setGrants(['artifact:read']);
    const result = new ReferenceRegistry(new ManualClock())
      .install(definition, { trust: 'trusted', verifiedPin: definition.manifest })
      .open(binding);
    if (result.state !== 'opened') throw new Error();
    expect(result.handle.context.basic.read().content.value).toBe(1);
    result.handle.mount({} as HTMLElement);
    expect(() => result.handle.mount({} as HTMLElement)).toThrow('Mount');
    expect(result.handle.context.addons.edit.state).toBe('unavailable');
    expect(result.handle.requestClose().state).toBe('revoked');
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(binding.session.revision.sequence).toBe(0);
  });
  it.each(['artifact:read', 'artifact:edit', 'artifact:save', 'resource:read'] as const)(
    'N08 %s loss immediately revokes and restore never resurrects',
    (grant) => {
      const h = harness();
      const lifecycle = api(h.handle, 'lifecycle');
      h.binding.setGrants(toyManifest.permissions.filter((value) => value !== grant));
      expect(lifecycle.signal.aborted).toBe(true);
      h.binding.setGrants(toyManifest.permissions);
      expect(() => h.handle.context.basic.read()).toThrow('ScopeRevoked');
      expect(h.open().scope.generation).not.toBe(h.handle.scope.generation);
    },
  );
  it.each(['save', 'resources'] as const)('N09 %s requires lifecycle', (id) => {
    const h = harness();
    h.registry.uninstall('toy');
    const def = toyDefinition();
    def.manifest.addons = { [id]: { ...def.manifest.addons[id], requirement: 'required' } };
    const result = h.registry
      .install(def, { trust: 'trusted', verifiedPin: def.manifest })
      .open(h.binding);
    expect(result).toMatchObject({ state: 'refused', code: 'required-addon', addon: id });
  });
  it('C05 failed D2 token never falls back to available legacy runtime', () => {
    const h = harness();
    expect(() =>
      h.registry.install(
        {
          ...h.definition,
          manifest: {
            ...h.definition.manifest,
            contractVersion: '1.0.0-draft.1',
          } as unknown as ManifestD2,
        },
        { trust: 'trusted', verifiedPin: h.definition.manifest },
      ),
    ).toThrow('contract');
  });
  it('C01/C02/C03 explicitly pinned legacy subset; no grant expansion or selection stub', () => {
    const old = {
      manifest: {
        contractVersion: '1.0.0-draft.1' as const,
        id: 'old',
        version: '1',
        packageHash: 'c'.repeat(64),
        artifactKind: 'toy',
        schemaVersion: 1,
        capabilities: ['local-edit', 'persistence'] as const,
        permissions: ['artifact:read', 'artifact:write'] as const,
        licenseNotices: [],
      },
      validate: toyDefinition().validate,
    };
    const review = {
      originalPin: old.manifest,
      adapterPin: { id: 'adapter', version: '1', packageHash: 'd'.repeat(64) },
      eligibleSynchronousToy: true as const,
    };
    const adapted = adaptLegacy(old, review);
    expect(adapted.evidence.originalContract).toBe('1.0.0-draft.1');
    expect(old.manifest.contractVersion).toBe('1.0.0-draft.1');
    const binding = referenceBinding({ value: 0 });
    binding.setGrants(['artifact:read', 'artifact:edit']);
    const registry = new ReferenceRegistry(new ManualClock());
    expect(
      registry
        .install(adapted.definition, { trust: 'trusted', verifiedPin: review.adapterPin })
        .open({ ...binding, resources: undefined }),
    ).toMatchObject({ state: 'refused', addon: 'save' });
    expect(() =>
      adaptLegacy({ ...old, manifest: { ...old.manifest, capabilities: ['selection'] } }, review),
    ).toThrow('LegacyCapability');
    expect(() => adaptLegacy(old, { ...review, eligibleSynchronousToy: false as true })).toThrow(
      'LegacyAdmission',
    );
  });
});
// C06: compile-only negative public consumer checks; never erase the contract with any.
function typeChecks(basic: Basic<{ value: number }>, context: Context<{ value: number }, string>) {
  // @ts-expect-error Basic intentionally has no execute.
  basic.execute(setValue(1));
  // @ts-expect-error Basic intentionally has no save.
  basic.save();
  // @ts-expect-error Unavailable slots must be narrowed before access.
  context.addons.edit.api.execute(setValue(1));
}
void typeChecks;
it('N03 optional unsupported slot and N09 missing input recovery policy refuse honestly', () => {
  const definition = toyDefinition();
  definition.manifest.addons = {
    resources: { version: 'resources@0-draft', requirement: 'optional' },
  };
  const registry = new ReferenceRegistry(new ManualClock(), ['lifecycle']);
  const result = registry
    .install(definition, { trust: 'trusted', verifiedPin: definition.manifest })
    .open(referenceBinding({ value: 0 }));
  if (result.state !== 'opened') throw new Error();
  expect(result.handle.context.addons.resources).toEqual({
    state: 'unavailable',
    reason: 'unsupported',
  });
  const h = harness();
  expect(h.installed.open({ ...h.binding, recovery: undefined })).toMatchObject({
    state: 'refused',
    code: 'required-addon',
    addon: 'inputs',
  });
});
