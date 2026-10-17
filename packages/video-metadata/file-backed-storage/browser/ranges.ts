import { CHUNK, type RangeReader } from './journal';
/** Stage an asynchronous reader without pretending it is already a synchronous Blob. */
export async function* chunksFromReader(reader: RangeReader, signal: AbortSignal) {
  if (!Number.isSafeInteger(reader.size) || reader.size <= 0 || reader.size > 8 * 1024 ** 3)
    throw Error('Reader size');
  for (let offset = 0; offset < reader.size; offset += CHUNK) {
    signal.throwIfAborted();
    const length = Math.min(CHUNK, reader.size - offset);
    const bytes = await reader.read(offset, length, signal);
    signal.throwIfAborted();
    if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw Error('Short reader');
    yield Uint8Array.from(bytes);
  }
}
