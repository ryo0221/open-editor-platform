import { afterEach, expect, it, vi } from 'vitest';
import { preparePreviewImage } from './resources';
const png = () =>
  new Uint8Array(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    ),
  );
async function ref(bytes: Uint8Array) {
  return {
    id: 'test',
    mediaType: 'image/png' as const,
    byteLength: bytes.length,
    contentHash: Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))),
      (b) => b.toString(16).padStart(2, '0'),
    ).join(''),
  };
}
afterEach(() => vi.unstubAllGlobals());
it('requires matching hash and valid bounded dimensions before invoking decoder', async () => {
  const decode = vi.fn();
  vi.stubGlobal('createImageBitmap', decode);
  const bytes = png(),
    pin = await ref(bytes);
  await expect(
    preparePreviewImage(
      { ...pin, contentHash: '0'.repeat(64) },
      bytes,
      new AbortController().signal,
    ),
  ).rejects.toThrow('hash mismatch');
  new DataView(bytes.buffer).setUint32(16, 999999);
  await expect(
    preparePreviewImage(await ref(bytes), bytes, new AbortController().signal),
  ).rejects.toThrow('pixel limit');
  expect(decode).not.toHaveBeenCalled();
});
it('owns bytes before async work, and release/abort close a ready bitmap once', async () => {
  const close = vi.fn();
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 1, height: 1, close })),
  );
  const bytes = png(),
    pin = await ref(bytes),
    abort = new AbortController();
  const pending = preparePreviewImage(pin, bytes, abort.signal);
  bytes.fill(0);
  pin.contentHash = '0'.repeat(64);
  const ready = await pending;
  expect(ready.width).toBe(1);
  abort.abort();
  ready.dispose();
  expect(close).toHaveBeenCalledTimes(1);
});
it('disposes a late decoder result after scope cancellation and never publishes ready', async () => {
  const close = vi.fn(),
    abort = new AbortController();
  let release!: (v: { width: number; height: number; close: () => void }) => void;
  let announce!: () => void;
  const started = new Promise<void>((resolve) => {
    announce = resolve;
  });
  vi.stubGlobal('createImageBitmap', () => {
    announce();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const bytes = png(),
    pending = preparePreviewImage(await ref(bytes), bytes, abort.signal);
  await started;
  abort.abort();
  release({ width: 1, height: 1, close });
  await expect(pending).rejects.toThrow('aborted');
  expect(close).toHaveBeenCalledTimes(1);
});
it('rejects missing decoder readiness and already-aborted scopes', async () => {
  vi.stubGlobal('createImageBitmap', async () => {
    throw new Error('decode failed');
  });
  const bytes = png(),
    pin = await ref(bytes),
    abort = new AbortController();
  await expect(preparePreviewImage(pin, bytes, abort.signal)).rejects.toThrow('decode failed');
  abort.abort();
  await expect(preparePreviewImage(pin, bytes, abort.signal)).rejects.toThrow('aborted');
});
