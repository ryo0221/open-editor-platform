import { it, expect, vi } from 'vitest';
import { ConsumerOwner, m2PcmDiagnostics, m2PcmRealm } from './owners';
it('retains closed owners, includes resident allocations in shared peak, refuses over unchanged realm', () => {
  const realm = m2PcmRealm();
  const resident = realm.reserve(7 * 1024 * 1024);
  const first = new ConsumerOwner('first', 1024 * 1024);
  const held = first.reserve(1024 * 1024, 'native-held');
  first.close();
  const next = new ConsumerOwner('next', 1024 * 1024);
  expect(() => next.reserve(1)).toThrow();
  expect(m2PcmDiagnostics().realmBytes).toBe(8 * 1024 * 1024);
  expect(m2PcmDiagnostics().realmPeak).toBe(8 * 1024 * 1024);
  held();
  held();
  resident();
  next.close();
  expect(m2PcmDiagnostics().realmBytes).toBe(0);
  expect(() => first.reserve(1)).toThrow();
});

it('shares admission across independently loaded private module instances', async () => {
  const first = m2PcmRealm();
  const held = first.reserve(7 * 1024 * 1024);
  vi.resetModules();
  const second = await import('./owners');
  const owner = new second.ConsumerOwner('independent-bundle', 2 * 1024 * 1024);
  expect(second.m2PcmRealm()).not.toBe(first);
  expect(second.m2PcmRealm().bytes).toBe(7 * 1024 * 1024);
  expect(() => owner.reserve(2 * 1024 * 1024)).toThrow();
  held();
  const release = owner.reserve(2 * 1024 * 1024);
  expect(first.bytes).toBe(2 * 1024 * 1024);
  owner.close();
  expect(first.bytes).toBe(2 * 1024 * 1024);
  release();
  expect(first.bytes).toBe(0);
});
