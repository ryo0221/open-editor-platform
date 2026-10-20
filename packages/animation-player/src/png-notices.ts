const encoder = new TextEncoder();
/** PNG iTXt carries UTF-8 provenance/notices without changing raster pixels. */
export async function animationPngNotices(png: Blob, metadata: string): Promise<Blob> {
  const bytes = new Uint8Array(await png.arrayBuffer()),
    view = new DataView(bytes.buffer);
  if (bytes.length < 20 || [137, 80, 78, 71, 13, 10, 26, 10].some((value, i) => bytes[i] !== value))
    throw Error('Invalid PNG export');
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    if (length > bytes.length - offset - 12) throw Error('Truncated PNG export');
    if (
      bytes[offset + 4] === 73 &&
      bytes[offset + 5] === 69 &&
      bytes[offset + 6] === 78 &&
      bytes[offset + 7] === 68
    ) {
      if (length !== 0 || offset + 12 !== bytes.length) throw Error('Invalid PNG end');
      const keyword = encoder.encode('Animation provenance'),
        text = encoder.encode(metadata),
        data = new Uint8Array(keyword.length + 5 + text.length);
      data.set(keyword);
      data.set(text, keyword.length + 5);
      const chunk = new Uint8Array(data.length + 12),
        chunkView = new DataView(chunk.buffer);
      chunkView.setUint32(0, data.length);
      chunk.set([105, 84, 88, 116], 4);
      chunk.set(data, 8);
      let crc = 0xffffffff;
      for (const byte of chunk.subarray(4, chunk.length - 4)) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
      chunkView.setUint32(chunk.length - 4, (crc ^ 0xffffffff) >>> 0);
      return new Blob([bytes.subarray(0, offset), chunk, bytes.subarray(offset)], {
        type: 'image/png',
      });
    }
    offset += length + 12;
  }
  throw Error('Missing PNG end');
}
