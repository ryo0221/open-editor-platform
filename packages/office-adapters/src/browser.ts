import {
  checkExportAbort,
  exportAssetLimits,
  type ExportAsset,
} from '@editor-platform/export-core';
import { ownedOfficeFonts, type OfficeFonts } from './fonts';
import { inspectOfficeImage } from './image';

export async function installBrowserOfficeFonts(fonts: OfficeFonts, signal?: AbortSignal) {
  const faces = await Promise.all(
    ownedOfficeFonts(fonts).map(async (bytes, i) => {
      checkExportAbort(signal);
      const face = new FontFace(fonts.profile.family, new Uint8Array(bytes), {
        weight: fonts.profile.faces[i].weight === 'bold' ? '700' : '400',
      });
      return face.load();
    }),
  );
  checkExportAbort(signal);
  for (const face of faces) document.fonts.add(face);
  return () => {
    for (const face of faces) document.fonts.delete(face);
  };
}
export async function decodeBrowserOfficeImage(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<ExportAsset> {
  const asset = inspectOfficeImage(bytes);
  checkExportAbort(signal);
  const bitmap = await createImageBitmap(
    new Blob([new Uint8Array(asset.bytes)], { type: asset.mime }),
  );
  try {
    if (bitmap.width !== asset.width || bitmap.height !== asset.height)
      throw Error('Image dimensions changed while decoding');
    checkExportAbort(signal);
    return asset;
  } finally {
    bitmap.close();
  }
}
export async function browserOfficeImagePng(
  asset: ExportAsset,
  signal?: AbortSignal,
): Promise<ExportAsset> {
  checkExportAbort(signal);
  const bitmap = await createImageBitmap(
    new Blob([new Uint8Array(asset.bytes)], { type: asset.mime }),
  );
  try {
    const canvas = new OffscreenCanvas(asset.width, asset.height),
      context = canvas.getContext('2d');
    if (!context) throw Error('Image conversion unavailable');
    context.drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    checkExportAbort(signal);
    return inspectOfficeImage(new Uint8Array(await blob.arrayBuffer()));
  } finally {
    bitmap.close();
  }
}
/** Reference Host policy: CORS-readable HTTP(S), data and blob images, no credentials. */
export async function fetchOfficeImage(source: string, signal?: AbortSignal): Promise<ExportAsset> {
  if (!/^(https?:|data:|blob:)/i.test(source)) throw Error('Image URL scheme is not permitted');
  const combined = AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]);
  const response = await fetch(source, { signal: combined, credentials: 'omit' });
  if (!response.ok || !response.body) throw Error('Image request failed');
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > exportAssetLimits.bytesPerImage) throw Error('Image exceeds 16 MiB');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return decodeBrowserOfficeImage(bytes, signal);
}
