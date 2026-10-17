import { StreamTarget } from 'mediabunny';
/** Explicit small-output staging budget, independent of source duration/PCM. */
export function boundedTarget(limit = 32 * 1024 * 1024) {
  const pageBytes = 65536,
    pages = new Map();
  let length = 0,
    maxWrite = 0;
  const target = new StreamTarget(
    new globalThis.WritableStream({
      write({ position, data }) {
        if (!Number.isSafeInteger(position) || position < 0 || position + data.byteLength > limit)
          throw Error('Output staging quota');
        maxWrite = Math.max(maxWrite, data.byteLength);
        for (let from = 0; from < data.length; ) {
          const at = position + from,
            id = Math.floor(at / pageBytes),
            offset = at % pageBytes,
            n = Math.min(pageBytes - offset, data.length - from);
          let page = pages.get(id);
          if (!page) {
            page = new Uint8Array(pageBytes);
            pages.set(id, page);
          }
          page.set(data.subarray(from, from + n), offset);
          from += n;
        }
        length = Math.max(length, position + data.length);
      },
    }),
    { chunked: true, chunkSize: pageBytes },
  );
  return {
    target,
    read() {
      const bytes = new Uint8Array(length);
      for (const [id, page] of pages)
        bytes.set(page.subarray(0, Math.min(pageBytes, length - id * pageBytes)), id * pageBytes);
      return bytes.buffer;
    },
    evidence() {
      return { limit, stagedBytes: length, pageBytes, pages: pages.size, maxWrite };
    },
  };
}
