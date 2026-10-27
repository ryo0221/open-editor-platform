import type { FontInterpretationV3 } from './fixed-font';
import { inspectOfficeImage } from '@editor-platform/office-adapters';
import {
  add,
  time,
  assertVideoContentV3,
  type VideoContentV3,
  type MediaAssetRef,
} from '@editor-platform/video-core';
import type { MediaImportSetV2 } from '../host-media/m2/media-profile-v2';
import { decodedFrameRealm } from '../host-media/indexed-media/frame-budget';
export interface ImageInterpretationV3 {
  format: 'video-image-interpretation-v3';
  profile: 'image-v3';
  mime: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  orientation: number;
}
export type VisualImportSetV3 = MediaImportSetV2 | ImageInterpretationV3 | FontInterpretationV3;
export function assertImageInterpretationV3(
  value: unknown,
): asserts value is ImageInterpretationV3 {
  const p = value as ImageInterpretationV3;
  if (
    !p ||
    Object.keys(p).sort().join() !== 'format,height,mime,orientation,profile,width' ||
    p.format !== 'video-image-interpretation-v3' ||
    p.profile !== 'image-v3' ||
    !['image/png', 'image/jpeg'].includes(p.mime) ||
    ![p.width, p.height].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 8192) ||
    p.width * p.height > 16 * 1024 * 1024 ||
    !Number.isInteger(p.orientation) ||
    p.orientation < 1 ||
    p.orientation > 8 ||
    (p.mime === 'image/png' && p.orientation !== 1)
  )
    throw Error('Unsupported image interpretation');
}
function exifOrientation(bytes: Uint8Array): number {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (at: number, n: number) => String.fromCharCode(...bytes.subarray(at, at + n));
  if (ascii(0, 6) !== 'Exif\0\0' || bytes.length < 14)
    throw Error('Unsupported JPEG APP1 metadata');
  const little = ascii(6, 2) === 'II';
  if (!little && ascii(6, 2) !== 'MM') throw Error('Invalid EXIF byte order');
  if (v.getUint16(8, little) !== 42) throw Error('Invalid EXIF header');
  const at = 6 + v.getUint32(10, little);
  if (at < 14 || at + 2 > bytes.length) throw Error('Invalid EXIF directory');
  const count = v.getUint16(at, little);
  if (count > 1024 || at + 2 + count * 12 + 4 > bytes.length) throw Error('Invalid EXIF entries');
  let orientation = 1,
    found = false;
  for (let i = 0; i < count; i++) {
    const p = at + 2 + i * 12;
    if (v.getUint16(p, little) === 0x8769) {
      if (v.getUint16(p + 2, little) !== 4 || v.getUint32(p + 4, little) !== 1)
        throw Error('Invalid EXIF subdirectory');
      const sub = 6 + v.getUint32(p + 8, little);
      if (sub < 14 || sub + 2 > bytes.length) throw Error('Invalid EXIF subdirectory');
      const entries = v.getUint16(sub, little);
      if (entries > 1024 || sub + 2 + entries * 12 + 4 > bytes.length)
        throw Error('Invalid EXIF subdirectory');
      for (let j = 0; j < entries; j++) {
        const field = sub + 2 + j * 12;
        if (
          v.getUint16(field, little) === 0xa001 &&
          (v.getUint16(field + 2, little) !== 3 ||
            v.getUint32(field + 4, little) !== 1 ||
            v.getUint16(field + 8, little) !== 1)
        )
          throw Error('Unsupported EXIF color space');
      }
    }
    if (v.getUint16(p, little) !== 0x112) continue;
    if (found || v.getUint16(p + 2, little) !== 3 || v.getUint32(p + 4, little) !== 1)
      throw Error('Invalid EXIF orientation');
    orientation = v.getUint16(p + 8, little);
    found = true;
  }
  return orientation;
}
/** Existing image header bounds plus explicit still/SDR admission before native allocation. */
export function inspectImageBytesV3(bytes: Uint8Array): ImageInterpretationV3 {
  const asset = inspectOfficeImage(bytes);
  if (asset.mime !== 'image/png' && asset.mime !== 'image/jpeg')
    throw Error('Video accepts still PNG/JPEG only');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (at: number, n: number) => String.fromCharCode(...bytes.subarray(at, at + n));
  let orientation = 1;
  if (asset.mime === 'image/png') {
    if (bytes[24] !== 8 || ![0, 2, 3, 4, 6].includes(bytes[25]))
      throw Error('Only 8-bit SDR PNG supported');
    for (let at = 8; at < bytes.length; ) {
      const size = v.getUint32(at),
        kind = ascii(at + 4, 4),
        data = at + 8;
      if (['acTL', 'fcTL', 'fdAT', 'iCCP', 'cICP', 'eXIf'].includes(kind))
        throw Error('Unsupported animated/color/oriented PNG');
      if (kind === 'gAMA' && (size !== 4 || v.getUint32(data) !== 45455))
        throw Error('Unsupported PNG gamma');
      if (kind === 'sRGB' && (size !== 1 || bytes[data] > 3))
        throw Error('Invalid PNG sRGB intent');
      if (kind === 'cHRM') {
        const srgb = [31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000];
        if (size !== 32 || srgb.some((n, i) => v.getUint32(data + i * 4) !== n))
          throw Error('Unsupported PNG chromaticity');
      }
      at += 12 + size;
    }
  } else {
    let exif = false;
    for (let at = 2; at + 4 <= bytes.length; ) {
      if (bytes[at++] !== 255) throw Error('Invalid JPEG marker');
      while (bytes[at] === 255) at++;
      const marker = bytes[at++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const size = v.getUint16(at);
      if (size < 2 || at + size > bytes.length) throw Error('Invalid JPEG segment');
      if (marker === 0xe2 || marker === 0xeb) throw Error('Unsupported JPEG ICC/auxiliary profile');
      if ([0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker))
        throw Error('Unsupported JPEG coding process');
      if (marker === 0xee && (size !== 14 || ascii(at + 2, 5) !== 'Adobe' || bytes[at + 13] > 1))
        throw Error('Unsupported JPEG Adobe color transform');
      if (marker === 0xe1) {
        if (exif) throw Error('Duplicate JPEG EXIF');
        orientation = exifOrientation(bytes.subarray(at + 2, at + size));
        exif = true;
      }
      if (
        [0xc0, 0xc1, 0xc2].includes(marker) &&
        (bytes[at + 2] !== 8 || ![1, 3].includes(bytes[at + 7]))
      )
        throw Error('Only 8-bit SDR JPEG supported');
      at += size;
    }
  }
  const plan: ImageInterpretationV3 = {
    format: 'video-image-interpretation-v3',
    profile: 'image-v3',
    mime: asset.mime,
    width: asset.width,
    height: asset.height,
    orientation,
  };
  assertImageInterpretationV3(plan);
  return plan;
}
export async function inspectImageOriginalV3(file: Blob, signal: AbortSignal) {
  signal.throwIfAborted();
  if (file.size > 16 * 1024 * 1024) throw Error('Image exceeds 16 MiB');
  const plan = inspectImageBytesV3(new Uint8Array(await file.arrayBuffer()));
  signal.throwIfAborted();
  const pixels = plan.width * plan.height;
  const owner = decodedFrameRealm.session({ pixels, bytes: pixels * 4 });
  const reservation = owner.reserve({ pixels, bytes: pixels * 4 });
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    signal.throwIfAborted();
    const swap = plan.orientation >= 5;
    if (
      bitmap.width !== (swap ? plan.height : plan.width) ||
      bitmap.height !== (swap ? plan.width : plan.height)
    )
      throw Error('Image decode dimensions/orientation differ');
    return { plan };
  } finally {
    bitmap?.close();
    reservation.release();
    owner.close();
  }
}
export function prepareImageImportV3(
  content: VideoContentV3,
  plan: ImageInterpretationV3,
  asset: MediaAssetRef,
  id: string,
): VideoContentV3 {
  assertVideoContentV3(content);
  assertImageInterpretationV3(plan);
  const track = content.sequence.tracks.find((t) => t.kind === 'visual');
  if (!track || track.locked) throw Error('Missing or locked visual track');
  const result = structuredClone(content),
    start = content.sequence.duration,
    duration = time(1);
  result.sources.push({
    id,
    kind: 'image',
    asset: { ...asset },
    mime: plan.mime,
    width: plan.width,
    height: plan.height,
    orientation: plan.orientation,
  });
  result.sequence.duration = add(start, duration);
  result.sequence.clips.push({
    id: id + ':image',
    kind: 'image',
    sourceId: id,
    trackId: track.id,
    start,
    duration,
    sourceIn: time(0),
    sourceOut: duration,
    rate: time(1),
  });
  assertVideoContentV3(result);
  return result;
}
