import { command } from '@editor-platform/editor-core';
import type {
  AddonApis,
  AddonId,
  HandleD2,
  Grant,
  Slot,
} from '@editor-platform/extension-contract/draft2';
import { ReferenceRegistry } from '../draft2';
import {
  FakeResources,
  FakeStorage,
  ManualClock,
  referenceBinding,
  toyDefinition,
} from './reference';
export type Toy = { value: number };
export function granted<A>(slot: Slot<A>): A {
  if (slot.state !== 'granted') throw new Error(slot.reason);
  return slot.api;
}
export function harness(grants?: readonly Grant[]) {
  const clock = new ManualClock();
  const registry = new ReferenceRegistry(clock);
  const binding = referenceBinding({ value: 0 });
  if (grants) binding.setGrants(grants);
  const storage = new FakeStorage<Toy>('toy');
  const resources = new FakeResources();
  binding.storage = storage;
  binding.resources = resources;
  const definition = toyDefinition();
  const installed = registry.install(definition, {
    trust: 'trusted',
    verifiedPin: definition.manifest,
  });
  const open = () => {
    const result = installed.open(binding);
    if (result.state !== 'opened') throw new Error(result.code);
    return result.handle;
  };
  const handle = open();
  return { clock, registry, binding, storage, resources, definition, installed, handle, open };
}
export function api<K extends AddonId>(
  handle: HandleD2<Toy, string>,
  id: K,
): AddonApis<Toy, string>[K] {
  return granted(handle.context.addons[id]);
}
export const setValue = (value: number) => command<Toy>('set', 'Set', () => ({ value }));
export async function turns() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
/** Explicit admission event; WebCrypto completion is not polled or timed. */
export async function admitted(h: ReturnType<typeof harness>) {
  const id =
    h.registry.saves.observations().at(-1)?.operationId ?? (await h.registry.saves.nextAdmission());
  await turns();
  return id;
}
