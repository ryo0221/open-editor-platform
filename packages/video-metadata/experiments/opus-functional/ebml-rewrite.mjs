/** Bounded fixture-only EBML rewriting; not a general container reader. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
export function elements(bytes) {
  assert(bytes.length <= 2 * 1024 * 1024, 'Fixture byte budget');
  const result = [];
  for (let at = 0; at < bytes.length; ) {
    assert(result.length < 4096, 'Element budget');
    function vint(offset, id = false) {
      assert(offset < bytes.length && bytes[offset], 'Invalid vint');
      let width = 1,
        mask = 128;
      while (!(bytes[offset] & mask)) {
        width++;
        mask >>= 1;
        assert(width <= (id ? 4 : 8));
      }
      assert(offset + width <= bytes.length, 'Short vint');
      let value = BigInt(id ? bytes[offset] : bytes[offset] & (mask - 1));
      for (let i = 1; i < width; i++) value = value * 256n + BigInt(bytes[offset + i]);
      return { width, value, unknown: !id && value === (1n << BigInt(width * 7)) - 1n };
    }
    const id = vint(at, true),
      size = vint(at + id.width),
      start = at + id.width + size.width;
    assert(!size.unknown || id.value === 0x18538067n, 'Only Segment may have unknown size');
    const end = size.unknown ? bytes.length : start + Number(size.value);
    assert(Number.isSafeInteger(end) && end <= bytes.length, 'Truncated element');
    result.push({ id: Number(id.value), data: bytes.subarray(start, end) });
    at = end;
  }
  return result;
}
export function integer(value, signed = false) {
  assert(typeof value === 'bigint' && value >= 0n);
  let hex = value.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let result = Buffer.from(hex, 'hex');
  if (signed && result[0] & 128) result = Buffer.concat([Buffer.from([0]), result]);
  assert(result.length <= 8, 'Integer budget');
  return result;
}
export function encode(elements) {
  return Buffer.concat(
    elements.map(({ id, data }) => {
      let width = 1;
      while (data.length >= 2 ** (7 * width) - 1) width++;
      assert(width <= 8);
      let size = BigInt(data.length) | (1n << BigInt(width * 7));
      const bytes = Buffer.alloc(width);
      for (let i = width - 1; i >= 0; i--) {
        bytes[i] = Number(size & 255n);
        size >>= 8n;
      }
      return Buffer.concat([integer(BigInt(id)), bytes, data]);
    }),
  );
}
