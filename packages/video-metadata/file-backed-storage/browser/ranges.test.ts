import { expect, it } from 'vitest';
import { chunksFromReader } from './ranges';
import { CHUNK } from './journal';
it('async Reader yields bounded independent chunks and a short final range', async () => {
  const sizes: number[] = [],
    parts: Uint8Array[] = [];
  const shared = new Uint8Array(CHUNK).fill(7);
  for await (const part of chunksFromReader(
    {
      size: CHUNK + 3,
      async read(_offset, length) {
        sizes.push(length);
        return shared.subarray(0, length);
      },
    },
    new AbortController().signal,
  ))
    parts.push(part);
  shared.fill(0);
  expect(sizes).toEqual([CHUNK, 3]);
  expect(parts.every((p) => p.every((b) => b === 7))).toBe(true);
});
it('short reader and cancellation do not yield unverified partial chunks', async () => {
  const bad = chunksFromReader(
    {
      size: 5,
      async read() {
        return new Uint8Array(4);
      },
    },
    new AbortController().signal,
  );
  await expect(bad.next()).rejects.toThrow('Short reader');
  const abort = new AbortController();
  const cancelled = chunksFromReader(
    {
      size: 5,
      async read() {
        abort.abort();
        return new Uint8Array(5);
      },
    },
    abort.signal,
  );
  await expect(cancelled.next()).rejects.toThrow();
});
