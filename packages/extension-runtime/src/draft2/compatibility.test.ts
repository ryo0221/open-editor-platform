import { it, expect, vi } from 'vitest';
import type { ExtensionDefinition } from '@editor-platform/extension-contract';
import { adaptLegacy, ReferenceRegistry } from '../draft2';
import { FakeStorage, ManualClock, referenceBinding, toyDefinition } from './reference';
import { setValue, turns } from './harness';
function fixture(surface = false) {
  const module: ExtensionDefinition<{ value: number }> = {
    manifest: {
      id: 'old',
      version: '1',
      packageHash: 'c'.repeat(64),
      contractVersion: '1.0.0-draft.1',
      artifactKind: 'toy',
      schemaVersion: 1,
      capabilities: ['local-edit', 'persistence', ...(surface ? ['surface' as const] : [])],
      permissions: ['artifact:read', 'artifact:write'],
      licenseNotices: [],
    },
    validate: toyDefinition().validate,
  };
  const adapterPin = { id: 'old-adapter', version: '1', packageHash: 'd'.repeat(64) };
  const clock = new ManualClock();
  const binding = referenceBinding({ value: 0 });
  const storage = new FakeStorage<{ value: number }>('old');
  binding.storage = storage;
  return {
    module,
    clock,
    binding,
    storage,
    open() {
      const adapted = adaptLegacy(module, {
        originalPin: module.manifest,
        adapterPin,
        eligibleSynchronousToy: true,
      });
      const registry = new ReferenceRegistry(clock);
      const result = registry
        .install(adapted.definition, { trust: 'trusted', verifiedPin: adapterPin })
        .open({ ...binding, resources: undefined });
      if (result.state !== 'opened') throw new Error(result.code);
      return { handle: result.handle, host: adapted.facade(result.handle.context), registry };
    },
  };
}
it('C01 synchronous legacy mount/read/edit and cleanup exactly once', async () => {
  const f = fixture(true);
  const cleanup = vi.fn();
  f.module.mount = (_container, host) => {
    host.execute(setValue(1));
    return cleanup;
  };
  const { handle, host } = f.open();
  handle.mount({} as HTMLElement);
  expect(host.read()).toEqual({ value: 1 });
  handle.revoke('replace');
  await turns();
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect((await handle.drain({ deadlineMs: 0 })).state).toBe('drained');
  handle.revoke('replace');
  expect(cleanup).toHaveBeenCalledTimes(1);
});
it.each(['committed', 'aborted', 'indeterminate'] as const)(
  'C04 legacy save %s distinct outcome/operationId',
  async (outcome) => {
    const f = fixture();
    const { host, registry } = f.open();
    const result = host.save().catch((error) => error);
    const request = await f.storage.nextRequest();
    if (outcome === 'committed') f.storage.commit(request.operationId);
    if (outcome === 'aborted') f.storage.noWrite(request.operationId);
    if (outcome === 'indeterminate') f.storage.fail(request.operationId);
    const received = await result;
    if (outcome === 'committed') expect(received).toBeUndefined();
    else
      expect(received).toMatchObject({
        code: outcome === 'aborted' ? 'SaveAborted' : 'SaveIndeterminate',
        operationId: request.operationId,
      });
    expect(registry.saves.observations()[0].outcome!.state).toBe(
      outcome === 'aborted' ? 'aborted-before-write' : outcome,
    );
  },
);
it('C04 legacy revoked delivery hides late committed receipt', async () => {
  const f = fixture();
  const { handle, host, registry } = f.open();
  const result = host.save().catch((error) => error);
  const request = await f.storage.nextRequest();
  handle.revoke('replace');
  f.storage.commit(request.operationId);
  expect(await result).toMatchObject({ code: 'ScopeRevoked' });
  await turns();
  expect(registry.saves.observations()[0].outcome!.state).toBe('committed');
});
it('C03 unexpected Promise cleanup stays owned and reported ineligible', async () => {
  const f = fixture(true);
  f.module.mount = () => async () => {};
  const { handle } = f.open();
  handle.mount({} as HTMLElement);
  handle.revoke('host-close');
  await turns();
  expect(await handle.drain({ deadlineMs: 0 })).toMatchObject({
    state: 'incomplete',
    failed: [{ resourceId: 'extension:legacy-surface', reason: 'Error: LegacyAsyncCleanup' }],
  });
});
it('draft.2 mount method retains definition receiver for validate and manifest', async () => {
  const base = toyDefinition();
  const mounted: string[] = [];
  const definition = {
    ...base,
    manifest: { ...base.manifest, surface: true },
    mount(_container: HTMLElement, context: Parameters<NonNullable<typeof base.mount>>[1]) {
      if (!this.validate(context.basic.read().content)) throw Error('UnexpectedContent');
      mounted.push(this.manifest.id);
    },
  };
  const registry = new ReferenceRegistry(new ManualClock());
  const opened = registry
    .install(definition, {
      trust: 'trusted',
      verifiedPin: definition.manifest,
    })
    .open(referenceBinding({ value: 0 }));
  if (opened.state !== 'opened') throw Error(opened.code);
  expect(() => opened.handle.mount({} as HTMLElement)).not.toThrow();
  expect(mounted).toEqual([definition.manifest.id]);
  expect(opened.handle.context.basic.read().content).toEqual({ value: 0 });
  opened.handle.revoke('host-close');
  await turns();
  expect(await opened.handle.drain({ deadlineMs: 0 })).toMatchObject({
    state: 'drained',
    pending: [],
    failed: [],
  });
});
