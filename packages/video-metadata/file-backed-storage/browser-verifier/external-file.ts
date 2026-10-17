/** Full external portable verification before exposing any original. No persistence or migration. */
import {
  createScanner,
  need,
  CHUNK,
  MAX_ARCHIVE,
  type DigestFactory,
  type Reader,
} from '../portable/io';
import { createPortableProjects } from '../portable/versioned';
import { createZip } from '../portable/zip64';
import { blobReader } from './adapter';
export interface OriginalLease {
  readonly size: number;
  read(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array>;
  blob(): Blob;
}
export async function openPortableFile(
  file: Blob,
  digest: DigestFactory,
  signal: AbortSignal,
  maxBytes: number,
) {
  need(
    Number.isSafeInteger(maxBytes) &&
      maxBytes > 0 &&
      BigInt(maxBytes) <= MAX_ARCHIVE &&
      file.size <= maxBytes,
    'External archive byte budget',
  );
  let owned: Blob | undefined = file;
  let released = false;
  const check = () => {
    signal.throwIfAborted();
    need(!released && owned, 'Portable lease released');
  };
  const reader: Reader = {
    size: BigInt(file.size),
    async read(at, n, abort) {
      check();
      const b = await blobReader(owned!).read(at, n, abort);
      check();
      return b;
    },
  };
  const scan = createScanner(digest);
  try {
    const opened = await createPortableProjects(scan).open(reader, signal);
    const receipt = {
      operationId: opened.project.operationId,
      capture: structuredClone(opened.project.capture),
      bytes: file.size,
      sha256: (await scan(reader, signal)).sha256,
    };
    const entries = await createZip(scan).readZip(reader, signal);
    const originals = new Map<string, OriginalLease>();
    for (const e of entries)
      if (e.name.startsWith('originals/')) {
        const at = Number(e.dataOffset),
          size = Number(e.size);
        originals.set(e.name.slice(10, -4), {
          size,
          async read(offset, length, abort) {
            check();
            need(
              Number.isSafeInteger(offset) &&
                offset >= 0 &&
                Number.isSafeInteger(length) &&
                length >= 0 &&
                length <= CHUNK &&
                offset + length <= size,
              'Original range budget',
            );
            const bytes = await reader.read(BigInt(at + offset), length, abort);
            check();
            return bytes;
          },
          blob() {
            check();
            return owned!.slice(at, at + size);
          },
        });
      }
    check();
    const release = () => {
      released = true;
      owned = undefined;
      originals.clear();
      opened.project.originals.clear();
    };
    // Readers from the shared parser are backed by the same revocable root reader.
    // Blobs already handed to consumers are immutable but not revocable; consumers own their release.
    return { ...opened, receipt, originals, release };
  } catch (e) {
    released = true;
    owned = undefined;
    throw e;
  }
}
