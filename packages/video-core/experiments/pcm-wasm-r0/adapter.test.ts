import { expect, it } from 'vitest';
import { time } from '@editor-platform/video-core';
import { PcmBackend } from './adapter';
import { ARENA_BYTES, Ledger, prepareModule } from './kernel';
const signal = () => new AbortController().signal;
const mapping = { start: time(0), end: time(1), sourceStart: time(0), speed: time(1) };
const edge = { mode: 'edge-hold-v0' as const, valid: { start: time(0), end: time(1) } };
const pcm = () => ({ first: 0, rate: 48000, planes: [new Float32Array(4800)] });
it('forced WASM cannot count JS fallback as success', async () => {
  const ledger = new Ledger(2 ** 22);
  expect(() => new PcmBackend({ mode: 'wasm', realm: ledger })).toThrow('WASM unavailable');
  expect(ledger.bytes).toBe(0);
  const fallback = new PcmBackend({ mode: 'auto', realm: ledger });
  expect(fallback.diagnostics).toMatchObject({ backend: 'js', fallback: true, invocations: 0 });
  const result = await fallback.render(mapping, 0, 64, 48000, pcm(), signal(), edge);
  result.release();
  await fallback.close();
  expect(ledger.bytes).toBe(0);
});
it('refuses session/realm admission before retaining work and rolls back', () => {
  const ledger = new Ledger(ARENA_BYTES - 1);
  expect(() => new PcmBackend({ mode: 'js', realm: ledger })).toThrow('admission');
  expect(ledger.bytes).toBe(0);
  expect(() => new PcmBackend({ mode: 'js', sessionBytes: 2 ** 22 })).toThrow('ceiling');
});
it('counts source backing buffers, overlapping staging and output; output survives close until released', async () => {
  const realm = new Ledger(2 ** 22),
    backend = new PcmBackend({ mode: 'js', realm });
  const source = pcm();
  const pending = backend.render(mapping, 0, 127, 48000, source, signal(), edge);
  expect(realm.bytes).toBe(ARENA_BYTES + source.planes[0].buffer.byteLength + 127 * 4);
  const result = await pending;
  expect(realm.bytes).toBe(ARENA_BYTES + 127 * 4);
  await backend.close();
  expect(realm.bytes).toBe(127 * 4);
  result.release();
  result.release();
  expect(realm.bytes).toBe(0);
});
it('rejects views retaining an oversized source buffer before allocating output', async () => {
  const realm = new Ledger(2 ** 22),
    backend = new PcmBackend({ mode: 'js', realm });
  const source = pcm();
  source.planes[0] = new Float32Array(new ArrayBuffer(2 ** 20), 0, 4800);
  expect(() => backend.render(mapping, 0, 64, 48000, source, signal(), edge)).toThrow(
    'backing buffer',
  );
  expect(realm.bytes).toBe(ARENA_BYTES);
  await backend.close();
  expect(realm.bytes).toBe(0);
});
it('abort before start, during yield and before final publication discards output and drains exactly once', async () => {
  for (const count of [1, 127]) {
    const realm = new Ledger(2 ** 22),
      controller = new AbortController();
    let resume!: () => void, started!: () => void;
    const reached = new Promise<void>((resolve) => {
      started = resolve;
    });
    const backend = new PcmBackend({
      mode: 'js',
      realm,
      yieldTask: () => {
        started();
        return new Promise((resolve) => {
          resume = resolve;
        });
      },
    });
    controller.abort();
    expect(() =>
      backend.render(mapping, 0, count, 48000, pcm(), controller.signal, edge),
    ).toThrow();
    const controller2 = new AbortController();
    const pending = backend.render(mapping, 0, count, 48000, pcm(), controller2.signal, edge);
    const rejection = expect(pending).rejects.toThrow();
    await reached;
    controller2.abort();
    const close = backend.close();
    expect(backend.close()).toBe(close);
    expect(realm.bytes).toBeGreaterThan(ARENA_BYTES);
    resume();
    await rejection;
    await close;
    expect(realm.bytes).toBe(0);
  }
});
it('does not share arena with replacement and keeps immutable staged input across yields', async () => {
  const realm = new Ledger(2 ** 22);
  const source = pcm();
  source.planes[0].fill(0.25);
  const backend = new PcmBackend({
    mode: 'js',
    realm,
    yieldTask: async () => {
      source.planes[0].fill(0.9);
      source.first = 100000;
      source.rate = 8000;
      mapping.speed = time(2);
    },
  });
  const pending = backend.render(mapping, 0, 127, 48000, source, signal(), edge);
  expect(() => backend.render(mapping, 0, 1, 48000, source, signal(), edge)).toThrow('busy');
  const result = await pending;
  expect(result.pcm.planes[0].every((x) => x === 0.25)).toBe(true);
  result.release();
  await backend.close();
  mapping.speed = time(1);
  expect(realm.bytes).toBe(0);
});
it('semantic errors do not trigger automatic fallback', async () => {
  const realm = new Ledger(2 ** 22),
    backend = new PcmBackend({ mode: 'js', realm });
  const source = pcm();
  source.planes[0][0] = NaN;
  await expect(backend.render(mapping, 0, 64, 48000, source, signal(), edge)).rejects.toThrow(
    'Nonfinite PCM',
  );
  expect(backend.diagnostics.fallback).toBe(false);
  await backend.close();
  expect(realm.bytes).toBe(0);
});
it('module hashing refuses tampering and returns its reservation', async () => {
  const realm = new Ledger(2 ** 22);
  await expect(prepareModule(new Uint8Array(8), '0'.repeat(64), realm)).rejects.toThrow(
    'hash mismatch',
  );
  expect(realm.bytes).toBe(0);
});
