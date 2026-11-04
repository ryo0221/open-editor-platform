import { zlibSync } from 'fflate';

/** Small actual RGBA fixture; no remote generation or painted-content acceptance claim. */
export function generatedPng(
  width = 2,
  height = 2,
  opaque = false,
  empty = false,
  filter = 0,
  fault?: 'checksum' | 'short' | 'overrun',
  ancillaryBytes = 0,
) {
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of bytes) {
      c ^= b;
      for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(data.length + 12),
      view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(
      Array.from(type, (c) => c.charCodeAt(0)),
      4,
    );
    out.set(data, 8);
    view.setUint32(data.length + 8, crc(out.subarray(4, data.length + 8)));
    return out;
  };
  const header = new Uint8Array(13),
    hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header[8] = 8;
  header[9] = 6;
  const raw = new Uint8Array((width * 4 + 1) * height);
  const rows = Array.from({ length: height }, (_, y) =>
    Uint8Array.from({ length: width * 4 }, (_, i) =>
      i % 4 === 3 ? (empty || (!opaque && i === 3 && y === 0) ? 0 : 255) : [42, 99, 120][i % 4],
    ),
  );
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c,
      x = Math.abs(p - a),
      y = Math.abs(p - b),
      z = Math.abs(p - c);
    return x <= y && x <= z ? a : y <= z ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const offset = y * (width * 4 + 1);
    raw[offset] = filter;
    for (let x = 0; x < width * 4; x++) {
      const a = x >= 4 ? rows[y][x - 4] : 0,
        b = y ? rows[y - 1][x] : 0,
        c = y && x >= 4 ? rows[y - 1][x - 4] : 0;
      raw[offset + 1 + x] =
        (rows[y][x] -
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
  }
  const packed = zlibSync(
    fault === 'short'
      ? raw.slice(0, -1)
      : fault === 'overrun'
        ? new Uint8Array(raw.length * 10000)
        : raw,
  );
  if (fault === 'checksum') packed[packed.length - 1] ^= 1;
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', packed),
    ...(ancillaryBytes ? [chunk('tEXt', new Uint8Array(ancillaryBytes))] : []),
    chunk('IEND', new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return 'data:image/png;base64,' + btoa(Array.from(out, (b) => String.fromCharCode(b)).join(''));
}
