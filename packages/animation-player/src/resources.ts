import type { AssetRef } from '@editor-platform/animation-core';
export interface ReadyImage {
  readonly width: number;
  readonly height: number;
  dispose(): void;
}
/** Separate readiness spike: verified bytes are not decoded readiness. No fetch or native image layer support. */
export async function preparePreviewImage(
  ref: AssetRef,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<ReadyImage> {
  const pin = { ...ref };
  const current = () => {
    if (signal.aborted) throw new Error('Image preparation aborted');
  };
  current();
  if (
    !/^[0-9a-f]{64}$/.test(pin.contentHash) ||
    !Number.isSafeInteger(pin.byteLength) ||
    pin.byteLength <= 0 ||
    pin.byteLength > 16 * 1024 * 1024 ||
    bytes.byteLength !== pin.byteLength ||
    !['image/png', 'image/jpeg'].includes(pin.mediaType)
  )
    throw new Error('Invalid image manifest');
  const owned = new Uint8Array(bytes);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', owned)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  current();
  if (hash !== pin.contentHash) throw new Error('Image hash mismatch');
  // Read dimensions before decoding; reject oversized allocations, not only the result.
  const { width, height } = imageDimensions(owned, pin.mediaType);
  if (
    width <= 0 ||
    height <= 0 ||
    width > 8192 ||
    height > 8192 ||
    width * height > 16 * 1024 * 1024
  )
    throw new Error('Image pixel limit');
  const bitmap = await createImageBitmap(new Blob([owned], { type: pin.mediaType }));
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener('abort', dispose);
    bitmap.close();
  };
  try {
    current();
    if (bitmap.width !== width || bitmap.height !== height)
      throw new Error('Image dimension mismatch');
    signal.addEventListener('abort', dispose, { once: true });
    return Object.freeze({ width, height, dispose });
  } catch (error) {
    dispose();
    throw error;
  }
}
function imageDimensions(bytes: Uint8Array, type: string): { width: number; height: number } {
  // PNG-only decoder spike for now; a JPEG manifest is recognized but explicitly unsupported.
  if (type !== 'image/png') throw new Error('JPEG readiness unsupported');
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    bytes.length < 33 ||
    signature.some((v, i) => bytes[i] !== v) ||
    bytes[12] !== 73 ||
    bytes[13] !== 72 ||
    bytes[14] !== 68 ||
    bytes[15] !== 82
  )
    throw new Error('Invalid PNG header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13) throw new Error('Invalid PNG IHDR');
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
