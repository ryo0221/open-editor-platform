import { designPngInfo, assertRasterRegion, type RasterRegion } from './raster';
export async function decodeDesignPng(src: string) {
  const info = designPngInfo(src),
    image = new Image();
  image.src = src;
  await image.decode();
  if (image.naturalWidth !== info.width || image.naturalHeight !== info.height)
    throw Error('PNGの画素サイズが一致しません。');
  return { image, ...info };
}

/** Repack browser PNG deflate bytes without changing filters, samples or alpha. */
async function compactCanvasPng(canvas: HTMLCanvasElement): Promise<string> {
  const original = canvas.toDataURL('image/png');
  designPngInfo(original);
  if (typeof CompressionStream === 'undefined' || typeof DecompressionStream === 'undefined')
    return original;
  const bytes = Uint8Array.from(atob(original.split(',')[1]), (c) => c.charCodeAt(0)),
    view = new DataView(bytes.buffer);
  const chunks: Uint8Array<ArrayBuffer>[] = [],
    idat: Uint8Array<ArrayBuffer>[] = [];
  for (let offset = 8; offset < bytes.length; ) {
    const size = view.getUint32(offset),
      end = offset + size + 12;
    if (String.fromCharCode(...bytes.slice(offset + 4, offset + 8)) === 'IDAT')
      idat.push(bytes.slice(offset + 8, end - 4));
    else chunks.push(bytes.slice(offset, end));
    offset = end;
  }
  const raw = await new Response(
    new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate')),
  ).arrayBuffer();
  const packed = new Uint8Array(
    await new Response(
      new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate')),
    ).arrayBuffer(),
  );
  const chunk = new Uint8Array(packed.length + 12),
    data = new DataView(chunk.buffer);
  data.setUint32(0, packed.length);
  chunk.set([73, 68, 65, 84], 4);
  chunk.set(packed, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, chunk.length - 4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  data.setUint32(chunk.length - 4, (crc ^ 0xffffffff) >>> 0);
  // Preserve every ancillary chunk and the final IEND; replace only IDAT bytes.
  const parts = [bytes.slice(0, 8), ...chunks.slice(0, -1), chunk, chunks.at(-1)!];
  const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  if (joined.length >= bytes.length) return original;
  const text: string[] = [];
  for (let i = 0; i < joined.length; i += 8192)
    text.push(String.fromCharCode(...joined.subarray(i, i + 8192)));
  const src = 'data:image/png;base64,' + btoa(text.join(''));
  designPngInfo(src);
  return src;
}
/** Replaces pixels inside the explicit source-pixel rectangle, including alpha. */
export async function compositeDesignRasterRegion(
  base: string,
  candidate: string,
  region: RasterRegion,
): Promise<string> {
  const [a, b] = await Promise.all([decodeDesignPng(base), decodeDesignPng(candidate)]);
  if (a.width !== b.width || a.height !== b.height)
    throw Error('AI画像は現在の画像と同じ画素サイズにしてください。');
  assertRasterRegion(region, a.width, a.height);
  const canvas = document.createElement('canvas');
  canvas.width = a.width;
  canvas.height = a.height;
  const context = canvas.getContext('2d')!;
  context.drawImage(a.image, 0, 0);
  const patch = document.createElement('canvas');
  patch.width = b.width;
  patch.height = b.height;
  const source = patch.getContext('2d')!;
  source.drawImage(b.image, 0, 0);
  context.putImageData(
    source.getImageData(region.x, region.y, region.width, region.height),
    region.x,
    region.y,
  );
  return compactCanvasPng(canvas);
}
