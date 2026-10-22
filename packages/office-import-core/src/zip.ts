/* eslint-disable no-control-regex -- Reject C0 characters in untrusted Office paths and URLs. */
import { Inflate } from 'fflate';
import { checkImportAbort, ImportError, importLimits } from './types';
const crcTable = new Uint32Array(256).map((_, n) => {
  for (let j = 0; j < 8; j++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(bytes: Uint8Array, previous = 0): number {
  let crc = previous ^ -1;
  for (const value of bytes) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}
interface Entry {
  name: string;
  size: number;
  compressed: number;
  crc: number;
  method: number;
  flags: number;
  offset: number;
  data: number;
  end: number;
}
interface ZipReader {
  readonly bytes: Uint8Array;
  u16(p: number): number;
  u32(p: number): number;
}
interface CentralDirectory {
  count: number;
  start: number;
  end: number;
}
interface DeclaredTotals {
  names: Set<string>;
  declared: number;
}
interface ExpansionTotals {
  actual: number;
  work: number;
}
const zipFail = (message: string): never => {
  throw new ImportError('INVALID_ZIP', message);
};
const yieldToEventLoop = () => new Promise((r) => setTimeout(r, 0));
function createZipReader(bytes: Uint8Array): ZipReader {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    bytes,
    u16(p) {
      if (p < 0 || p + 2 > bytes.length) return zipFail('Truncated header');
      return v.getUint16(p, true);
    },
    u32(p) {
      if (p < 0 || p + 4 > bytes.length) return zipFail('Truncated header');
      return v.getUint32(p, true);
    },
  };
}
function findEndOfCentralDirectory({ bytes, u16, u32 }: ZipReader): number {
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--)
    if (u32(p) === 0x06054b50 && p + 22 + u16(p + 20) === bytes.length) return p;
  return zipFail('Missing ZIP central directory');
}
function readCentralDirectory(reader: ZipReader): CentralDirectory {
  const { u16, u32 } = reader;
  const end = findEndOfCentralDirectory(reader);
  const count = u16(end + 10),
    start = u32(end + 16),
    directoryBytes = u32(end + 12);
  if (
    u16(end + 4) ||
    u16(end + 6) ||
    u16(end + 8) !== count ||
    count === 65535 ||
    start === 0xffffffff
  )
    zipFail('Multi-disk and ZIP64 archives are not supported');
  if (count > importLimits.entries)
    throw new ImportError('ENTRY_LIMIT', 'More than 10,000 ZIP entries');
  if (start + directoryBytes !== end) zipFail('Invalid central-directory extent');
  return { count, start, end };
}
function decodeZipName(bytes: Uint8Array, p: number, n: number, flags: number): string {
  if (!n || p + n > bytes.length) return zipFail('Empty or truncated ZIP name');
  const raw = bytes.subarray(p, p + n);
  if (!(flags & 0x800) && raw.some((b) => b > 127))
    zipFail('Non-UTF-8 part names are not supported');
  let name: string;
  try {
    name = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    return zipFail('Invalid UTF-8 part name');
  }
  if (
    /[\\\u0000- %:#?]/.test(name) ||
    name.startsWith('/') ||
    name.split('/').some((s, i, a) => s === '.' || s === '..' || (!s && i < a.length - 1))
  )
    zipFail('Unsafe or unsupported part path');
  return name;
}
function readCentralHeader({ u16, u32 }: ZipReader, cursor: number, end: number) {
  if (cursor + 46 > end || u32(cursor) !== 0x02014b50) zipFail('Invalid central-directory entry');
  const flags = u16(cursor + 8),
    method = u16(cursor + 10),
    crc = u32(cursor + 16),
    compressed = u32(cursor + 20),
    size = u32(cursor + 24);
  const nl = u16(cursor + 28),
    extra = u16(cursor + 30),
    comment = u16(cursor + 32),
    offset = u32(cursor + 42);
  if (
    flags & ~0x80e ||
    (method !== 0 && method !== 8) ||
    u16(cursor + 34) ||
    compressed === 0xffffffff ||
    size === 0xffffffff
  )
    zipFail('Encrypted, ZIP64 or unsupported compression');
  return { flags, method, crc, compressed, size, nl, extra, comment, offset };
}
type CentralHeader = ReturnType<typeof readCentralHeader>;
function declareEntryName(
  reader: ZipReader,
  header: CentralHeader,
  cursor: number,
  totals: DeclaredTotals,
): string {
  const name = decodeZipName(reader.bytes, cursor + 46, header.nl, header.flags);
  if (totals.names.has(name)) zipFail('Duplicate ZIP part');
  totals.names.add(name);
  totals.declared += header.size;
  if (totals.declared > importLimits.expandedBytes)
    throw new ImportError('EXPANDED_LIMIT', 'Expanded archive exceeds 128 MiB');
  if (/\.(xml|rels)$/i.test(name) && header.size > importLimits.xmlBytes)
    throw new ImportError('XML_LIMIT', name);
  return name;
}
function readDescriptorRecordEnd({ u32 }: ZipReader, header: CentralHeader, dataEnd: number) {
  const { crc, compressed, size, offset } = header;
  const dp = dataEnd + (u32(dataEnd) === 0x08074b50 ? 4 : 0);
  if (u32(dp) !== crc || u32(dp + 4) !== compressed || u32(dp + 8) !== size)
    zipFail('Invalid ZIP data descriptor');
  if (
    [u32(offset + 14), u32(offset + 18), u32(offset + 22)].some(
      (n, index) => n !== 0 && n !== [crc, compressed, size][index],
    )
  )
    zipFail('Contradictory local header');
  return dp + 12;
}
function readLocalRecord(
  reader: ZipReader,
  header: CentralHeader,
  name: string,
  start: number,
): { data: number; end: number } {
  const { u16, u32 } = reader;
  const { flags, method, crc, compressed, size, offset } = header;
  if (u32(offset) !== 0x04034b50 || u16(offset + 6) !== flags || u16(offset + 8) !== method)
    zipFail('Local-header mismatch');
  const ln = u16(offset + 26),
    le = u16(offset + 28),
    data = offset + 30 + ln + le;
  if (decodeZipName(reader.bytes, offset + 30, ln, flags) !== name || data + compressed > start)
    zipFail('Part extent or name mismatch');
  let recordEnd = data + compressed;
  if (flags & 8) recordEnd = readDescriptorRecordEnd(reader, header, recordEnd);
  else if (u32(offset + 14) !== crc || u32(offset + 18) !== compressed || u32(offset + 22) !== size)
    zipFail('Local size/CRC mismatch');
  if (recordEnd > start || (name.endsWith('/') && size)) zipFail('Invalid part boundary');
  return { data, end: recordEnd };
}
function readEntries(reader: ZipReader, { count, start, end }: CentralDirectory): Entry[] {
  const entries: Entry[] = [];
  const totals: DeclaredTotals = { names: new Set<string>(), declared: 0 };
  let cursor = start;
  for (let i = 0; i < count; i++) {
    const header = readCentralHeader(reader, cursor, end);
    const name = declareEntryName(reader, header, cursor, totals);
    const record = readLocalRecord(reader, header, name, start);
    const { size, compressed, crc, method, flags, offset } = header;
    entries.push({ name, size, compressed, crc, method, flags, offset, ...record });
    cursor += 46 + header.nl + header.extra + header.comment;
  }
  if (cursor !== end) zipFail('Central-directory length mismatch');
  return entries;
}
function checkRecordLayout(entries: readonly Entry[], start: number) {
  let position = 0;
  for (const e of [...entries].sort((a, b) => a.offset - b.offset)) {
    if (e.offset !== position) zipFail('Overlapping, missing, or prefixed ZIP records');
    position = e.end;
  }
  if (position !== start) zipFail('Unindexed ZIP bytes');
}
function createEntrySink(entry: Entry, totals: ExpansionTotals) {
  const sink = {
    chunks: [] as Uint8Array[],
    length: 0,
    crc: 0,
    receive(data: Uint8Array) {
      sink.length += data.length;
      totals.work += data.length;
      totals.actual += data.length;
      if (totals.actual > importLimits.expandedBytes)
        throw new ImportError('EXPANDED_LIMIT', 'Actual expansion exceeds 128 MiB');
      if (sink.length > entry.size) zipFail('Actual expansion exceeds declared size');
      sink.crc = crc32(data, sink.crc);
      sink.chunks.push(data.slice());
    },
  };
  return sink;
}
type EntrySink = ReturnType<typeof createEntrySink>;
// A small compressed chunk bounds temporary inflater allocation, even for a forged bomb.
function pushInflateChunks(
  bytes: Uint8Array,
  entry: Entry,
  inflater: Inflate,
  totals: ExpansionTotals,
  from: number,
): number {
  let at = from;
  try {
    while (at < entry.compressed) {
      inflater.push(
        bytes.subarray(entry.data + at, entry.data + Math.min(at + 256, entry.compressed)),
        at + 256 >= entry.compressed,
      );
      at += 256;
      if (totals.work >= 1024 * 1024) break;
    }
  } catch (e) {
    if (e instanceof ImportError) throw e;
    zipFail(`Invalid deflate stream: ${String(e)}`);
  }
  return at;
}
function finishEntry(entry: Entry, sink: EntrySink, result: Map<string, Uint8Array>) {
  if (sink.length !== entry.size || sink.crc !== entry.crc)
    zipFail('Expanded size or CRC mismatch');
  if (entry.name.endsWith('/')) return;
  const out = new Uint8Array(sink.length);
  let at = 0;
  for (const c of sink.chunks) {
    out.set(c, at);
    at += c.length;
  }
  result.set(entry.name, out);
}
/** Validates both ZIP indices, observes actual expansion incrementally, and never writes files. */
export async function readOfficeZip(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<Map<string, Uint8Array>> {
  checkImportAbort(signal);
  if (bytes.length > importLimits.compressedBytes)
    throw new ImportError('COMPRESSED_LIMIT', 'Office file exceeds 32 MiB');
  const reader = createZipReader(bytes);
  const directory = readCentralDirectory(reader);
  const entries = readEntries(reader, directory);
  checkRecordLayout(entries, directory.start);
  const result = new Map<string, Uint8Array>();
  const totals: ExpansionTotals = { actual: 0, work: 0 };
  for (const entry of entries) {
    checkImportAbort(signal);
    const sink = createEntrySink(entry, totals);
    if (entry.method === 0) sink.receive(bytes.subarray(entry.data, entry.data + entry.compressed));
    else {
      const inflater = new Inflate(sink.receive);
      for (let at = 0; at < entry.compressed; ) {
        at = pushInflateChunks(bytes, entry, inflater, totals, at);
        if (totals.work >= 1024 * 1024) {
          totals.work = 0;
          await yieldToEventLoop();
          checkImportAbort(signal);
        }
      }
    }
    finishEntry(entry, sink, result);
    if (result.size % 16 === 0) {
      await yieldToEventLoop();
      checkImportAbort(signal);
    }
  }
  return result;
}
