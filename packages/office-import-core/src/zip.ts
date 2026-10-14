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
/** Validates both ZIP indices, observes actual expansion incrementally, and never writes files. */
export async function readOfficeZip(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<Map<string, Uint8Array>> {
  checkImportAbort(signal);
  const fail = (message: string): never => {
    throw new ImportError('INVALID_ZIP', message);
  };
  if (bytes.length > importLimits.compressedBytes)
    throw new ImportError('COMPRESSED_LIMIT', 'Office file exceeds 32 MiB');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (p: number) => {
    if (p < 0 || p + 2 > bytes.length) return fail('Truncated header');
    return v.getUint16(p, true);
  };
  const u32 = (p: number) => {
    if (p < 0 || p + 4 > bytes.length) return fail('Truncated header');
    return v.getUint32(p, true);
  };
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--)
    if (u32(p) === 0x06054b50 && p + 22 + u16(p + 20) === bytes.length) {
      end = p;
      break;
    }
  if (end < 0) fail('Missing ZIP central directory');
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
    fail('Multi-disk and ZIP64 archives are not supported');
  if (count > importLimits.entries)
    throw new ImportError('ENTRY_LIMIT', 'More than 10,000 ZIP entries');
  if (start + directoryBytes !== end) fail('Invalid central-directory extent');
  const entries: Entry[] = [],
    names = new Set<string>();
  let declared = 0,
    cursor = start;
  const decodeName = (p: number, n: number, flags: number) => {
    if (!n || p + n > bytes.length) return fail('Empty or truncated ZIP name');
    const raw = bytes.subarray(p, p + n);
    if (!(flags & 0x800) && raw.some((b) => b > 127))
      fail('Non-UTF-8 part names are not supported');
    let name: string;
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      return fail('Invalid UTF-8 part name');
    }
    if (
      /[\\\u0000-\u0020%:#?]/.test(name) ||
      name.startsWith('/') ||
      name.split('/').some((s, i, a) => s === '.' || s === '..' || (!s && i < a.length - 1))
    )
      fail('Unsafe or unsupported part path');
    return name;
  };
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || u32(cursor) !== 0x02014b50) fail('Invalid central-directory entry');
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
      fail('Encrypted, ZIP64 or unsupported compression');
    const name = decodeName(cursor + 46, nl, flags);
    if (names.has(name)) fail('Duplicate ZIP part');
    names.add(name);
    declared += size;
    if (declared > importLimits.expandedBytes)
      throw new ImportError('EXPANDED_LIMIT', 'Expanded archive exceeds 128 MiB');
    if (/\.(xml|rels)$/i.test(name) && size > importLimits.xmlBytes)
      throw new ImportError('XML_LIMIT', name);
    if (u32(offset) !== 0x04034b50 || u16(offset + 6) !== flags || u16(offset + 8) !== method)
      fail('Local-header mismatch');
    const ln = u16(offset + 26),
      le = u16(offset + 28),
      data = offset + 30 + ln + le;
    if (decodeName(offset + 30, ln, flags) !== name || data + compressed > start)
      fail('Part extent or name mismatch');
    let recordEnd = data + compressed;
    if (flags & 8) {
      const dp = recordEnd + (u32(recordEnd) === 0x08074b50 ? 4 : 0);
      if (u32(dp) !== crc || u32(dp + 4) !== compressed || u32(dp + 8) !== size)
        fail('Invalid ZIP data descriptor');
      recordEnd = dp + 12;
      if (
        [u32(offset + 14), u32(offset + 18), u32(offset + 22)].some(
          (n, index) => n !== 0 && n !== [crc, compressed, size][index],
        )
      )
        fail('Contradictory local header');
    } else if (
      u32(offset + 14) !== crc ||
      u32(offset + 18) !== compressed ||
      u32(offset + 22) !== size
    )
      fail('Local size/CRC mismatch');
    if (recordEnd > start || (name.endsWith('/') && size)) fail('Invalid part boundary');
    entries.push({ name, size, compressed, crc, method, flags, offset, data, end: recordEnd });
    cursor += 46 + nl + extra + comment;
  }
  if (cursor !== end) fail('Central-directory length mismatch');
  let position = 0;
  for (const e of [...entries].sort((a, b) => a.offset - b.offset)) {
    if (e.offset !== position) fail('Overlapping, missing, or prefixed ZIP records');
    position = e.end;
  }
  if (position !== start) fail('Unindexed ZIP bytes');
  const result = new Map<string, Uint8Array>();
  let actual = 0,
    work = 0;
  for (const entry of entries) {
    checkImportAbort(signal);
    const chunks: Uint8Array[] = [];
    let length = 0,
      crc = 0;
    const receive = (data: Uint8Array) => {
      length += data.length;
      work += data.length;
      actual += data.length;
      if (actual > importLimits.expandedBytes)
        throw new ImportError('EXPANDED_LIMIT', 'Actual expansion exceeds 128 MiB');
      if (length > entry.size) fail('Actual expansion exceeds declared size');
      crc = crc32(data, crc);
      chunks.push(data.slice());
    };
    if (entry.method === 0) receive(bytes.subarray(entry.data, entry.data + entry.compressed));
    else {
      const inflater = new Inflate(receive);
      try {
        // A small compressed chunk bounds temporary inflater allocation, even for a forged bomb.
        for (let at = 0; at < entry.compressed; at += 256) {
          inflater.push(
            bytes.subarray(entry.data + at, entry.data + Math.min(at + 256, entry.compressed)),
            at + 256 >= entry.compressed,
          );
          if (work >= 1024 * 1024) {
            work = 0;
            await new Promise((r) => setTimeout(r, 0));
            checkImportAbort(signal);
          }
        }
      } catch (e) {
        if (e instanceof ImportError) throw e;
        fail(`Invalid deflate stream: ${String(e)}`);
      }
    }
    if (length !== entry.size || crc !== entry.crc) fail('Expanded size or CRC mismatch');
    if (!entry.name.endsWith('/')) {
      const out = new Uint8Array(length);
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.length;
      }
      result.set(entry.name, out);
    }
    if (result.size % 16 === 0) {
      await new Promise((r) => setTimeout(r, 0));
      checkImportAbort(signal);
    }
  }
  return result;
}
