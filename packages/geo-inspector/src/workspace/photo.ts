/** Inspect dimensions before decoding. No URL, SVG, HTML, EXIF lookup or external request. */
export function inspectGeoPhoto(bytes: Uint8Array): {
  format: 'png' | 'jpeg';
  width: number;
  height: number;
} {
  if (bytes.length > 100000 || bytes.length < 24)
    throw Error('Photo byte budget or truncated header');
  const bounded = (format: 'png' | 'jpeg', width: number, height: number) => {
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 2048 ||
      height > 2048 ||
      width * height > 4_000_000
    )
      throw Error('Photo pixel budget');
    return { format, width, height };
  };
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)) {
    if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') throw Error('PNG header');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return bounded('png', view.getUint32(16), view.getUint32(20));
  }
  if (bytes[0] !== 255 || bytes[1] !== 216) throw Error('Only local PNG/JPEG are supported');
  let cursor = 2;
  while (cursor + 4 <= bytes.length) {
    if (bytes[cursor++] !== 255) throw Error('JPEG segment header');
    while (bytes[cursor] === 255) cursor++;
    const marker = bytes[cursor++];
    if (marker === 0xda || marker === 0xd9) break;
    const length = (bytes[cursor] << 8) | bytes[cursor + 1];
    if (length < 2 || cursor + length > bytes.length) throw Error('JPEG segment length');
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8) throw Error('JPEG frame header');
      return bounded(
        'jpeg',
        (bytes[cursor + 5] << 8) | bytes[cursor + 6],
        (bytes[cursor + 3] << 8) | bytes[cursor + 4],
      );
    }
    cursor += length;
  }
  throw Error('Unsupported JPEG frame');
}
