/** Reopen/relink runs the same bounded image admission as initial import. */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { verifyOriginal } from '../host-media/m2/verify-original-v2.mjs';
import { readFixedFontAsset } from './fixed-font';
import { inspectImageOriginalV3 } from './image-source';
export async function verifyVisualOriginalV3(source, bytes, signal) {
  if (!('kind' in source)) return verifyOriginal(source, bytes, signal);
  if (source.kind === 'font') {
    if (
      !(bytes instanceof globalThis.Blob) ||
      bytes.size !== source.asset.byteLength ||
      bytes.size > 18 * 1024 * 1024
    )
      throw Error('Font original identity/size');
    const raw = new Uint8Array(await bytes.arrayBuffer());
    signal.throwIfAborted();
    if (bytesToHex(sha256(raw)) !== source.asset.sha256) throw Error('Font original SHA');
    await readFixedFontAsset(
      raw,
      {
        format: 'video-font-interpretation-v3',
        profile: 'font-v3',
        fontProfile: source.fontProfile,
        weight: source.weight,
      },
      signal,
    );
    return 'font-v3';
  }
  if (source.kind !== 'image') throw Error('Unsupported visual original');
  signal.throwIfAborted();
  if (
    !(bytes instanceof globalThis.Blob) ||
    bytes.size !== source.asset.byteLength ||
    bytes.size > 16 * 1024 * 1024
  )
    throw Error('Image original identity/size');
  const raw = new Uint8Array(await bytes.arrayBuffer());
  signal.throwIfAborted();
  if (bytesToHex(sha256(raw)) !== source.asset.sha256) throw Error('Image original SHA');
  const { plan } = await inspectImageOriginalV3(bytes, signal);
  if (['mime', 'width', 'height', 'orientation'].some((key) => source[key] !== plan[key]))
    throw Error('Image original interpretation mismatch');
  return 'image-v3';
}
