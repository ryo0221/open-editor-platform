import { exportAssetLimits, ownExportAsset, type ExportAsset } from '@editor-platform/export-core';

/** Read dimensions before allocating a decoder surface. The decoder must verify them again. */
export function inspectOfficeImage(bytes: Uint8Array): ExportAsset {
  if (bytes.length > exportAssetLimits.bytesPerImage) throw Error('Image exceeds 16 MiB');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (at: number, n: number) => String.fromCharCode(...bytes.subarray(at, at + n));
  let mime: ExportAsset['mime'],
    width = 0,
    height = 0;
  if (bytes.length >= 24 && ascii(1, 3) === 'PNG') {
    mime = 'image/png';
    width = view.getUint32(16);
    height = view.getUint32(20);
    // Reject truncated chunks before invoking native codecs (some versions crash on them).
    if (ascii(0, 8) !== '\x89PNG\r\n\x1a\n' || view.getUint32(8) !== 13 || ascii(12, 4) !== 'IHDR')
      throw Error('Invalid PNG header');
    let at = 8,
      data = false,
      ended = false;
    while (at + 12 <= bytes.length) {
      const length = view.getUint32(at),
        kind = ascii(at + 4, 4);
      if (at + 12 + length > bytes.length) throw Error('Truncated PNG chunk');
      data ||= kind === 'IDAT';
      at += 12 + length;
      if (kind === 'IEND') {
        ended = length === 0;
        break;
      }
    }
    if (!data || !ended || at !== bytes.length) throw Error('Truncated or invalid PNG container');
  } else if (bytes.length >= 10 && /^GIF8[79]a$/.test(ascii(0, 6))) {
    mime = 'image/gif';
    width = view.getUint16(6, true);
    height = view.getUint16(8, true);
  } else if (bytes.length >= 20 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    mime = 'image/webp';
    const kind = ascii(12, 4);
    const u24 = (at: number) => bytes[at] + bytes[at + 1] * 256 + bytes[at + 2] * 65536;
    if (kind === 'VP8X' && bytes.length >= 30) {
      width = u24(24) + 1;
      height = u24(27) + 1;
    } else if (kind === 'VP8 ' && bytes.length >= 30 && ascii(23, 3) === '\x9d\x01\x2a') {
      width = view.getUint16(26, true) & 0x3fff;
      height = view.getUint16(28, true) & 0x3fff;
    } else if (kind === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    }
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    mime = 'image/jpeg';
    for (let at = 2; at + 4 <= bytes.length; ) {
      if (bytes[at++] !== 0xff) throw Error('Invalid JPEG marker');
      while (bytes[at] === 0xff) at++;
      const marker = bytes[at++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (at + 2 > bytes.length) break;
      const size = view.getUint16(at);
      if (size < 2 || at + size > bytes.length) throw Error('Invalid JPEG segment');
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        ) &&
        size >= 7
      ) {
        height = view.getUint16(at + 3);
        width = view.getUint16(at + 5);
        break;
      }
      at += size;
    }
  } else throw Error('Only PNG, JPEG, WebP and GIF images are supported');
  return ownExportAsset({ bytes, mime, width, height });
}
export function imageDataUri(asset: Pick<ExportAsset, 'bytes' | 'mime'>): string {
  let raw = '';
  for (let i = 0; i < asset.bytes.length; i += 0x8000)
    raw += String.fromCharCode(...asset.bytes.subarray(i, i + 0x8000));
  return `data:${asset.mime};base64,${btoa(raw)}`;
}
