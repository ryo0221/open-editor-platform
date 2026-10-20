import { expect, it, vi } from 'vitest';
import { Ledger, ModuleInput, prepareModule } from '../../src/pcm/kernel';
const make = (length: number) => () => new Uint8Array(length);
it('refuses full-ledger startup before constructing input and rolls back factory failures', () => {
  const realm = new Ledger(64),
    held = realm.reserve(64),
    allocate = vi.fn(make(8));
  expect(() => ModuleInput.allocate(8, allocate, realm)).toThrow('admission');
  expect(allocate).not.toHaveBeenCalled();
  expect(realm.bytes).toBe(64);
  held();
  expect(() =>
    ModuleInput.allocate(
      8,
      () => {
        expect(realm.bytes).toBe(8);
        throw Error('factory');
      },
      realm,
    ),
  ).toThrow('factory');
  expect(realm.bytes).toBe(0);
  expect(() => ModuleInput.allocate(8, make(9), realm)).toThrow('extent');
  expect(realm.bytes).toBe(0);
  const input = ModuleInput.allocate(8, make(8), realm);
  expect(input.chargedBytes).toBe(8);
  input.dispose();
  input.dispose();
  expect(input.available).toBe(false);
  expect(realm.bytes).toBe(0);
});
it('failed preparation admission releases the transferred input, preserving other owners', async () => {
  const realm = new Ledger(64),
    held = realm.reserve(56);
  const input = ModuleInput.allocate(8, make(8), realm);
  await expect(prepareModule(input, '0'.repeat(64), realm)).rejects.toThrow('admission');
  expect(input.available).toBe(false);
  expect(input.chargedBytes).toBe(0);
  expect(realm.bytes).toBe(56);
  input.dispose();
  held();
  expect(realm.bytes).toBe(0);
});
it('holds transferred input/snapshot/digest until failed asynchronous hashing settles', async () => {
  const realm = new Ledger(48),
    input = ModuleInput.allocate(8, make(8), realm);
  let finish!: (value: ArrayBuffer) => void;
  const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementation(
    () =>
      new Promise<ArrayBuffer>((resolve) => {
        finish = resolve;
      }),
  );
  try {
    const pending = prepareModule(input, '1'.repeat(64), realm);
    expect(input.available).toBe(false);
    expect(realm.bytes).toBe(48);
    expect(input.chargedBytes).toBe(48);
    input.dispose();
    expect(realm.bytes).toBe(48);
    finish(new ArrayBuffer(32));
    await expect(pending).rejects.toThrow('hash mismatch');
    expect(realm.bytes).toBe(0);
    expect(input.chargedBytes).toBe(0);
    await expect(prepareModule(input, '1'.repeat(64), realm)).rejects.toThrow('ownership');
  } finally {
    digest.mockRestore();
  }
});
it('refuses foreign-ledger transfer without releasing the original reservation', async () => {
  const realm = new Ledger(64),
    other = new Ledger(64),
    input = ModuleInput.allocate(8, make(8), realm);
  await expect(prepareModule(input, '0'.repeat(64), other)).rejects.toThrow('ownership');
  expect(realm.bytes).toBe(8);
  expect(other.bytes).toBe(0);
  expect(input.available).toBe(true);
  input.dispose();
  expect(realm.bytes).toBe(0);
});

it('failed compilation after a matching hash releases the entire transferred owner', async () => {
  // Correct fixed-memory section but invalid magic: actual WebAssembly.compile fails.
  const bytes = new Uint8Array([0, 0, 0, 0, 1, 0, 0, 0, 5, 4, 1, 1, 12, 12]);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (x) =>
    x.toString(16).padStart(2, '0'),
  ).join('');
  const realm = new Ledger(2 * bytes.length + 32);
  const input = ModuleInput.allocate(bytes.length, () => bytes.slice(), realm);
  await expect(prepareModule(input, hash, realm)).rejects.toThrow();
  expect(realm.bytes).toBe(0);
  expect(input.chargedBytes).toBe(0);
  expect(input.available).toBe(false);
});
