import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { requireAnimation as check } from '../model';
import type { Asset2 } from './model';
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// Character code -> sextet, -1 for '=' and every non-alphabet code (as indexOf did).
const sextets = new Int8Array(128).fill(-1);
for (let i = 0; i < alphabet.length; i++) sextets[alphabet.charCodeAt(i)] = i;
/** Byte identity and both retained notices define whether an owned resource can be reused. */
export function equivalentAnimationAsset2(a: Asset2, b: Asset2) {
  return (
    a.contentHash === b.contentHash &&
    a.mediaType === b.mediaType &&
    a.attribution === b.attribution &&
    a.license === b.license
  );
}
export const hashAnimationBytes2 = (bytes: Uint8Array) => bytesToHex(sha256(bytes));
export function decodeAnimationBase64(base64: string): Uint8Array {
  check(
    typeof base64 === 'string' &&
      base64.length <= 2800000 &&
      base64.length % 4 === 0 &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(base64),
    'asset-base64',
    'asset',
  );
  const bytes = new Uint8Array(
    (base64.length / 4) * 3 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0),
  );
  let offset = 0;
  for (let i = 0; i < base64.length; i += 4) {
    // The regex above admits only ASCII alphabet characters and trailing padding.
    const a = sextets[base64.charCodeAt(i)],
      b = sextets[base64.charCodeAt(i + 1)],
      c = sextets[base64.charCodeAt(i + 2)],
      d = sextets[base64.charCodeAt(i + 3)];
    check(
      (c >= 0 || (b & 15) === 0) && (d >= 0 || c < 0 || (c & 3) === 0),
      'asset-base64-padding',
      'asset',
    );
    bytes[offset++] = (a << 2) | (b >> 4);
    if (offset < bytes.length) bytes[offset++] = ((b & 15) << 4) | (c >> 2);
    if (offset < bytes.length) bytes[offset++] = ((c & 3) << 6) | d;
  }
  return bytes;
}
export function encodeAnimationBase64(bytes: Uint8Array): string {
  check(bytes.byteLength <= 2 * 1024 * 1024, 'asset-bytes', 'asset');
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i],
      b = bytes[i + 1] ?? 0,
      c = bytes[i + 2] ?? 0;
    out +=
      alphabet[a >> 2] +
      alphabet[((a & 3) << 4) | (b >> 4)] +
      (i + 1 < bytes.length ? alphabet[((b & 15) << 2) | (c >> 6)] : '=') +
      (i + 2 < bytes.length ? alphabet[c & 63] : '=');
  }
  return out;
}
/** Header admission precedes browser decoding. Browser readiness still has to succeed. */
export function inspectAnimationAsset2(asset: Asset2) {
  const bytes = decodeAnimationBase64(asset.base64);
  check(bytes.length > 0 && bytes.length <= 2 * 1024 * 1024, 'asset-bytes', asset.id);
  check(hashAnimationBytes2(bytes) === asset.contentHash, 'asset-hash', asset.id);
  let width = 0,
    height = 0;
  if (asset.mediaType === 'image/png') {
    check(
      bytes.length >= 33 &&
        [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n) &&
        String.fromCharCode(...bytes.slice(12, 16)) === 'IHDR',
      'png-header',
      asset.id,
    );
    const view = new DataView(bytes.buffer);
    check(view.getUint32(8) === 13, 'png-header', asset.id);
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (asset.mediaType === 'image/jpeg') {
    check(bytes[0] === 255 && bytes[1] === 216, 'jpeg-header', asset.id);
    let p = 2;
    while (p + 4 < bytes.length) {
      check(bytes[p++] === 255, 'jpeg-header', asset.id);
      while (bytes[p] === 255) p++;
      const marker = bytes[p++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = (bytes[p] << 8) | bytes[p + 1];
      check(length >= 2 && p + length <= bytes.length, 'jpeg-length', asset.id);
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        check(length >= 8, 'jpeg-frame', asset.id);
        height = (bytes[p + 3] << 8) | bytes[p + 4];
        width = (bytes[p + 5] << 8) | bytes[p + 6];
        break;
      }
      p += length;
    }
  } else {
    const magic = String.fromCharCode(...bytes.slice(0, 4));
    check(
      bytes.length >= 12 &&
        (asset.mediaType === 'font/otf'
          ? magic === 'OTTO'
          : asset.mediaType === 'font/woff2'
            ? magic === 'wOF2'
            : asset.mediaType === 'font/ttf' &&
              bytes[0] === 0 &&
              bytes[1] === 1 &&
              bytes[2] === 0 &&
              bytes[3] === 0),
      'font-header',
      asset.id,
    );
    return { bytes, width, height };
  }
  check(
    width > 0 &&
      height > 0 &&
      width <= 8192 &&
      height <= 8192 &&
      width * height <= 16 * 1024 * 1024,
    'image-pixels',
    asset.id,
  );
  return { bytes, width, height };
}
