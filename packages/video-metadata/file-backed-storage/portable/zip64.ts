/** Closed ZIP64 STORE candidate, deliberately not a generic ZIP extractor. */
import { MAX_ARCHIVE, need, read, range, type Scanner, type Reader, type Sink } from './io';
export interface Entry {
  name: string;
  size: bigint;
  crc: number;
  sha256: string;
  reader: Reader;
}
function view(b: Uint8Array) {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}
export function createZip(scan: Scanner) {
  const namePattern = /^(manifest\.json|native\/[a-f0-9]{64}\.json|originals\/[a-f0-9]{64}\.bin)$/;
  const ascii = new TextEncoder();
  function names(entries: { name: string }[]) {
    need(entries.length > 0 && entries.length <= 109, 'Entry count');
    const seen = new Set<string>();
    for (const e of entries) {
      need(namePattern.test(e.name) && !seen.has(e.name), 'Path/duplicate');
      seen.add(e.name);
    }
    need(entries[0].name === 'manifest.json', 'Manifest first');
  }
  function header(e: Pick<Entry, 'name' | 'size' | 'crc'>, offset?: bigint) {
    const central = offset !== undefined,
      base = central ? 46 : 30,
      extra = central ? 28 : 20;
    const b = new Uint8Array(base + e.name.length + extra);
    view(b).setUint32(0, central ? 0x02014b50 : 0x04034b50, true);
    if (central) view(b).setUint16(4, 0x032d, true);
    const p = central ? 6 : 4;
    view(b).setUint16(p, 45, true);
    view(b).setUint16(p + 2, 0x800, true);
    view(b).setUint16(p + 8, 33, true); // 1980-01-01, time zero
    view(b).setUint32(p + 10, e.crc, true);
    view(b).setUint32(p + 14, 0xffffffff, true);
    view(b).setUint32(p + 18, 0xffffffff, true);
    view(b).setUint16(p + 22, e.name.length, true);
    view(b).setUint16(p + 24, extra, true);
    if (central) {
      view(b).setUint32(38, 0x81800000, true);
      view(b).setUint32(42, 0xffffffff, true);
    }
    b.set(ascii.encode(e.name), base);
    const x = base + e.name.length;
    view(b).setUint16(x, 1, true);
    view(b).setUint16(x + 2, extra - 4, true);
    view(b).setBigUint64(x + 4, e.size, true);
    view(b).setBigUint64(x + 12, e.size, true);
    if (central) view(b).setBigUint64(x + 20, offset, true);
    return b;
  }
  function footer(count: number, start: bigint, size: bigint) {
    const b = new Uint8Array(98);
    view(b).setUint32(0, 0x06064b50, true);
    view(b).setBigUint64(4, 44n, true);
    view(b).setUint16(12, 0x032d, true);
    view(b).setUint16(14, 45, true);
    view(b).setBigUint64(24, BigInt(count), true);
    view(b).setBigUint64(32, BigInt(count), true);
    view(b).setBigUint64(40, size, true);
    view(b).setBigUint64(48, start, true);
    view(b).setUint32(56, 0x07064b50, true);
    view(b).setBigUint64(64, start + size, true);
    view(b).setUint32(72, 1, true);
    view(b).setUint32(76, 0x06054b50, true);
    view(b).setUint16(84, 65535, true);
    view(b).setUint16(86, 65535, true);
    view(b).setUint32(88, 0xffffffff, true);
    view(b).setUint32(92, 0xffffffff, true);
    return b;
  }
  function equal(a: Uint8Array, b: Uint8Array) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  function archiveSize(entries: Entry[]) {
    return entries.reduce(
      (n, e) => n + e.size + BigInt(30 + 20 + 46 + 28 + 2 * e.name.length),
      98n,
    );
  }
  async function writeZip(entries: Entry[], sink: Sink, signal: AbortSignal) {
    names(entries);
    need(archiveSize(entries) <= MAX_ARCHIVE, 'Archive budget');
    let offset = 0n;
    const centers: Uint8Array[] = [];
    for (const e of entries) {
      need(e.size === e.reader.size && e.size > 0n, 'Entry size');
      const local = header(e);
      centers.push(header(e, offset));
      await sink.write(local, signal);
      const actual = await scan(e.reader, signal, sink);
      need(actual.sha256 === e.sha256 && actual.crc === e.crc, 'Source changed');
      offset += BigInt(local.length) + e.size;
    }
    const start = offset;
    for (const b of centers) {
      await sink.write(b, signal);
      offset += BigInt(b.length);
    }
    await sink.write(footer(entries.length, start, offset - start), signal);
  }
  async function readZip(
    reader: Reader,
    signal: AbortSignal,
  ): Promise<(Entry & { dataOffset: bigint })[]> {
    need(reader.size >= 98n && reader.size <= MAX_ARCHIVE, 'Archive budget');
    const tail = await read(reader, reader.size - 98n, 98, signal);
    const count64 = view(tail).getBigUint64(24, true),
      start = view(tail).getBigUint64(48, true),
      size = view(tail).getBigUint64(40, true);
    need(
      count64 > 0n && count64 <= 109n && start + size === reader.size - 98n,
      'Directory bounds/count',
    );
    need(equal(tail, footer(Number(count64), start, size)), 'ZIP64 footer');
    let pos = start,
      local = 0n;
    const entries: (Entry & { dataOffset: bigint })[] = [];
    for (let i = 0; i < Number(count64); i++) {
      need(pos + 46n <= start + size, 'Central bounds');
      const c = await read(reader, pos, 46, signal);
      const length = view(c).getUint16(28, true);
      need(
        length > 0 &&
          length <= 80 &&
          view(c).getUint16(30, true) === 28 &&
          pos + BigInt(46 + length + 28) <= start + size,
        'Name/extra bounds',
      );
      const rest = await read(reader, pos + 46n, length + 28, signal);
      const name = new TextDecoder('utf-8', { fatal: true }).decode(rest.subarray(0, length));
      need(
        namePattern.test(name) && equal(rest.subarray(0, length), ascii.encode(name)),
        'Canonical path',
      );
      const bytes = view(rest).getBigUint64(length + 4, true),
        at = view(rest).getBigUint64(length + 20, true);
      const e = { name, size: bytes, crc: view(c).getUint32(16, true) };
      need(
        at === local && bytes > 0n && at + BigInt(50 + length) + bytes <= start,
        'Offset/overlap',
      );
      need(equal(new Uint8Array([...c, ...rest]), header(e, at)), 'Central profile');
      const expected = header(e);
      need(
        equal(await read(reader, at, expected.length, signal), expected),
        'Local/central mismatch',
      );
      const payload = range(reader, at + BigInt(expected.length), bytes);
      entries.push({ ...e, sha256: '', reader: payload, dataOffset: at + BigInt(expected.length) });
      local += BigInt(expected.length) + bytes;
      pos += BigInt(46 + length + 28);
    }
    need(pos === start + size && local === start, 'Directory extent/gaps');
    names(entries);
    return entries;
  }

  return { archiveSize, writeZip, readZip };
}
