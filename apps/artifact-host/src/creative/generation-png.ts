import { Unzlib } from 'fflate';
import { designPngInfo } from '@editor-platform/design/model';

/** Bounded bitmap admission for generation results; metadata supplied by an AI is not evidence. */
export function inspectGeneratedPng(src: unknown) {
  const info = designPngInfo(src);
  const bytes = Uint8Array.from(atob((src as string).split(',')[1]), (c) => c.charCodeAt(0));
  const channels = bytes[25] === 6 ? 4 : bytes[25] === 2 ? 3 : 0;
  if (bytes[24] !== 8 || !channels || bytes[26] || bytes[27] || bytes[28])
    throw Error('生成結果は8bit RGB/RGBA・非interlaceのPNGにしてください。');
  const stride = info.width * channels,
    expected = (stride + 1) * info.height;
  const raw = new Uint8Array(expected);
  let written = 0;
  const decoder = new Unzlib((chunk) => {
    if (written + chunk.length > expected) throw Error('PNGの展開サイズが一致しません。');
    raw.set(chunk, written);
    written += chunk.length;
  });
  const view = new DataView(bytes.buffer),
    compressed: Uint8Array[] = [];
  for (let offset = 8; offset < bytes.length; ) {
    const size = view.getUint32(offset),
      type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
    if (type === 'IDAT') compressed.push(bytes.subarray(offset + 8, offset + 8 + size));
    else if (
      type === 'tRNS' ||
      (!['IHDR', 'IEND'].includes(type) && type[0] === type[0].toUpperCase())
    )
      throw Error('生成PNGのchunkに対応していません。');
    offset += size + 12;
  }
  const packed = new Uint8Array(compressed.reduce((n, c) => n + c.length, 0));
  let packedOffset = 0;
  for (const c of compressed) {
    packed.set(c, packedOffset);
    packedOffset += c.length;
  }
  if (
    packed.length < 6 ||
    (packed[0] & 15) !== 8 ||
    packed[0] >> 4 > 7 ||
    ((packed[0] << 8) | packed[1]) % 31 ||
    packed[1] & 32
  )
    throw Error('PNG zlib headerが不正です。');
  // Small compressed pushes bound expansion before the callback checks declared dimensions.
  for (let i = 0; i < packed.length; i += 256)
    decoder.push(packed.subarray(i, i + 256), i + 256 >= packed.length);
  if (written !== expected) throw Error('PNGの画素データが不足しています。');
  let a = 1,
    b = 0;
  for (let offset = 0; offset < raw.length; offset += 5552) {
    for (const v of raw.subarray(offset, offset + 5552)) {
      a += v;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  const checksum = new DataView(packed.buffer).getUint32(packed.length - 4);
  if (checksum !== ((b << 16) | a) >>> 0) throw Error('PNG zlib checksumが一致しません。');
  let previous = new Uint8Array(stride),
    transparent = false,
    visible = false;
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c,
      x = Math.abs(p - a),
      y = Math.abs(p - b),
      z = Math.abs(p - c);
    return x <= y && x <= z ? a : y <= z ? b : c;
  };
  for (let y = 0; y < info.height; y++) {
    const row = new Uint8Array(stride),
      filter = raw[y * (stride + 1)];
    if (filter > 4) throw Error('PNG filterが不正です。');
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0,
        b = previous[x],
        c = x >= channels ? previous[x - channels] : 0;
      row[x] =
        (raw[y * (stride + 1) + 1 + x] +
          (filter === 0
            ? 0
            : filter === 1
              ? a
              : filter === 2
                ? b
                : filter === 3
                  ? Math.floor((a + b) / 2)
                  : paeth(a, b, c))) &
        255;
    }
    for (let x = 0; x < info.width; x++) {
      const alpha = channels === 4 ? row[x * channels + 3] : 255;
      if (alpha === 0) transparent = true;
      if (alpha > 0) visible = true;
    }
    previous = row;
  }
  return { ...info, transparent, visible };
}
