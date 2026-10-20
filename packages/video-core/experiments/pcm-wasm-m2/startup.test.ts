import { expect, it, vi } from 'vitest';
import type { Ledger } from '../../src/pcm/kernel';
import { configureM2PcmFactory, m2PcmDiagnostics } from '../../src/pcm/owners';
import { selectedPcmSession } from '../../src/pcm/selection';
it('normal factory admission precedes construction and failed forced preparation leaves no input held', async () => {
  const realm = (globalThis as unknown as Record<symbol, Ledger>)[
    Symbol.for('editor-platform.private-pcm-budget.v1')
  ];
  const held = realm.reserve(8 * 1024 * 1024);
  const factory = vi.fn(() => {
    expect(realm.bytes).toBe(8);
    return new Uint8Array(8);
  });
  expect(() => configureM2PcmFactory(8, factory)).toThrow('admission');
  expect(factory).not.toHaveBeenCalled();
  held();
  configureM2PcmFactory(8, factory);
  expect(factory).toHaveBeenCalledTimes(1);
  expect(m2PcmDiagnostics()).toMatchObject({
    configured: 'wasm',
    moduleBytes: 8,
    realmBytes: 8,
    sessions: [],
  });
  const decoder = {
    async decode(): Promise<never> {
      throw Error('No decoder call expected');
    },
  };
  await expect(
    selectedPcmSession(decoder, 'edge-hold-v0', new AbortController().signal),
  ).rejects.toThrow('hash mismatch');
  expect(m2PcmDiagnostics()).toMatchObject({
    configured: 'wasm',
    moduleBytes: 0,
    realmBytes: 0,
    sessions: [],
  });
  await expect(
    selectedPcmSession(decoder, 'edge-hold-v0', new AbortController().signal),
  ).rejects.toThrow('hash mismatch');
  expect(factory).toHaveBeenCalledTimes(1);
  expect(realm.bytes).toBe(0);
});
