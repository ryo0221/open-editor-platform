/** Private platform-neutral bounded I/O; Host supplies streaming digest capability. */
export const CHUNK = 65536;
export const MAX_ARCHIVE = 8n * 1024n ** 3n;
export const MAX_ORIGINALS = 4n * 1024n ** 3n;
export interface Reader {
  readonly size: bigint;
  read(offset: bigint, length: number, signal: AbortSignal): Promise<Uint8Array>;
}
export interface Sink {
  write(bytes: Uint8Array, signal: AbortSignal): Promise<void>;
}
export function need(ok: unknown, message: string): asserts ok {
  if (!ok) throw Error(message);
}
export async function read(r: Reader, offset: bigint, length: number, signal: AbortSignal) {
  signal.throwIfAborted();
  need(
    Number.isSafeInteger(length) &&
      length >= 0 &&
      length <= CHUNK &&
      offset >= 0n &&
      offset + BigInt(length) <= r.size,
    'Range budget',
  );
  const bytes = await r.read(offset, length, signal);
  signal.throwIfAborted();
  need(bytes instanceof Uint8Array && bytes.length === length, 'Short read');
  return bytes;
}
export function memory(bytes: Uint8Array): Reader {
  const owned = Uint8Array.from(bytes);
  return {
    size: BigInt(owned.length),
    async read(offset, length) {
      return owned.slice(Number(offset), Number(offset) + length);
    },
  };
}
export function range(r: Reader, offset: bigint, size: bigint): Reader {
  need(offset >= 0n && size >= 0n && offset + size <= r.size, 'Entry interval');
  return {
    size,
    async read(at, length, signal) {
      need(at >= 0n && at + BigInt(length) <= size, 'Entry range');
      return read(r, offset + at, length, signal);
    },
  };
}
const table = Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export interface Digest {
  update(bytes: Uint8Array): void;
  hex(): string;
  dispose(): void;
}
export type DigestFactory = () => Digest;
export function createScanner(createDigest: DigestFactory) {
  return async function scan(r: Reader, signal: AbortSignal, sink?: Sink) {
    need(r.size >= 0n && r.size <= MAX_ARCHIVE, 'Scan budget');
    const hash = createDigest();
    try {
      let crc = 0xffffffff;
      for (let at = 0n; at < r.size; ) {
        const b = await read(
          r,
          at,
          Number(r.size - at > BigInt(CHUNK) ? BigInt(CHUNK) : r.size - at),
          signal,
        );
        hash.update(b);
        for (const v of b) crc = table[(crc ^ v) & 255] ^ (crc >>> 8);
        if (sink) {
          await sink.write(b, signal);
          signal.throwIfAborted();
        }
        at += BigInt(b.length);
      }
      return { sha256: hash.hex(), crc: (crc ^ 0xffffffff) >>> 0 };
    } finally {
      hash.dispose();
    }
  };
}

export type Scanner = ReturnType<typeof createScanner>;
