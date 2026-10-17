/** Private Node reference backend. No filesystem picker or browser capability API. */
import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { CHUNK, MAX_ARCHIVE, need, createScanner, type Reader } from './portable/io';
export * from './portable/io';
export function handleReader(handle: FileHandle, size: bigint): Reader {
  return {
    size,
    async read(offset, length, signal) {
      signal.throwIfAborted();
      need(
        offset >= 0n && offset <= BigInt(Number.MAX_SAFE_INTEGER) && length <= CHUNK,
        'File range',
      );
      const bytes = new Uint8Array(length);
      let done = 0;
      while (done < length) {
        signal.throwIfAborted();
        const n = (await handle.read(bytes, done, length - done, Number(offset) + done)).bytesRead;
        need(n > 0, 'Short file');
        done += n;
      }
      return bytes;
    },
  };
}
export async function fileReader(path: string) {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat({ bigint: true });
    need(stat.isFile() && stat.size <= MAX_ARCHIVE, 'Regular bounded file required');
    return { ...handleReader(handle, stat.size), close: () => handle.close() };
  } catch (e) {
    await handle.close();
    throw e;
  }
}
export const scan = createScanner(() => {
  const hash = createHash('sha256');
  return {
    update(bytes) {
      hash.update(bytes);
    },
    hex: () => hash.digest('hex'),
    dispose() {
      hash.destroy();
    },
  };
});
