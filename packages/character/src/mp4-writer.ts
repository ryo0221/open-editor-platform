/**
 * C8b: a minimal MP4 writer for one H.264 video track (no audio): `ftyp`, then `moov` (so a
 * player can start before the end, "faststart"), then one `mdat` with every sample in one
 * chunk. 32-bit sizes and offsets throughout: the caller keeps the file under 1 GiB.
 *
 * It writes what the existing reader (`video-metadata`'s MP4 probe) admits: version 0 boxes,
 * the identity matrix, a self-contained `url ` reference, `avc1` with `avcC` and an explicit
 * BT.709 `colr`, and no edit list.
 */
export interface Mp4Sample {
  data: Uint8Array;
  /** A sync sample (IDR). */
  key: boolean;
}
export interface Mp4Video {
  width: number;
  height: number;
  /** Media ticks per second, and each sample's duration in them (constant frame rate). */
  timescale: number;
  sampleDuration: number;
  /** The `AVCDecoderConfigurationRecord` (WebCodecs' `decoderConfig.description`). */
  avcC: Uint8Array;
  samples: readonly Mp4Sample[];
}

/** The movie clock (`mvhd`, `tkhd`): milliseconds. */
const movieScale = 1000;
const identity = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];

class Out {
  private parts: Uint8Array[] = [];
  size = 0;
  u8(v: number) {
    return this.raw(Uint8Array.of(v));
  }
  u16(v: number) {
    return this.raw(Uint8Array.of(v >>> 8, v & 255));
  }
  u32(v: number) {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new RangeError('MP4 field');
    return this.raw(Uint8Array.of(v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255));
  }
  zeros(n: number) {
    return this.raw(new Uint8Array(n));
  }
  str(s: string) {
    return this.raw(Uint8Array.from(s, (c) => c.charCodeAt(0)));
  }
  raw(b: Uint8Array) {
    this.parts.push(b);
    this.size += b.length;
    return this;
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.size);
    let at = 0;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}
/** A box: its size, type and body. */
function box(type: string, body: (o: Out) => void): Uint8Array {
  const o = new Out();
  body(o);
  const head = new Out().u32(o.size + 8).str(type);
  return new Out().raw(head.bytes()).raw(o.bytes()).bytes();
}
/** A full box (version 0) with `flags`. */
const full = (type: string, flags: number, body: (o: Out) => void) =>
  box(type, (o) => {
    o.u32(flags & 0xffffff);
    body(o);
  });
const boxes = (type: string, children: Uint8Array[]) =>
  box(type, (o) => children.forEach((c) => o.raw(c)));

/** The moov box, with the first sample's file offset (`stco`). */
function moov(v: Mp4Video, mediaDuration: number, dataOffset: number): Uint8Array {
  const n = v.samples.length;
  const movieDuration = Math.round((mediaDuration * movieScale) / v.timescale);
  const mvhd = full('mvhd', 0, (o) => {
    o.u32(0).u32(0).u32(movieScale).u32(movieDuration);
    o.u32(0x10000).u16(0x100).zeros(10);
    identity.forEach((x) => o.u32(x));
    o.zeros(24).u32(2);
  });
  // Enabled, in the movie and in the preview.
  const tkhd = full('tkhd', 3, (o) => {
    o.u32(0).u32(0).u32(1).u32(0).u32(movieDuration);
    o.zeros(8).u16(0).u16(0).u16(0).u16(0);
    identity.forEach((x) => o.u32(x));
    o.u32(v.width * 0x10000).u32(v.height * 0x10000);
  });
  const mdhd = full('mdhd', 0, (o) => {
    // Language "und" (ISO-639-2/T packed).
    o.u32(0).u32(0).u32(v.timescale).u32(mediaDuration).u16(0x55c4).u16(0);
  });
  const hdlr = full('hdlr', 0, (o) => {
    o.u32(0).str('vide').zeros(12).str('Video').u8(0);
  });
  const vmhd = full('vmhd', 1, (o) => o.zeros(8));
  const dinf = boxes('dinf', [
    full('dref', 0, (o) => {
      o.u32(1);
      o.raw(full('url ', 1, () => {}));
    }),
  ]);
  const avc1 = box('avc1', (o) => {
    o.zeros(6).u16(1); // reserved, data reference index
    o.zeros(16); // pre-defined, reserved
    o.u16(v.width).u16(v.height);
    o.u32(0x480000).u32(0x480000); // 72 dpi
    o.u32(0).u16(1); // reserved, frame count
    o.zeros(32); // compressor name
    o.u16(0x18).u16(0xffff); // depth, pre-defined −1
    o.raw(box('avcC', (c) => c.raw(v.avcC)));
    // BT.709 primaries, transfer and matrix; limited range.
    o.raw(box('colr', (c) => c.str('nclx').u16(1).u16(1).u16(1).u8(0)));
  });
  const stsd = full('stsd', 0, (o) => {
    o.u32(1).raw(avc1);
  });
  const stts = full('stts', 0, (o) => {
    o.u32(1).u32(n).u32(v.sampleDuration);
  });
  const keys = v.samples.flatMap((s, i) => (s.key ? [i + 1] : []));
  const stss = full('stss', 0, (o) => {
    o.u32(keys.length);
    keys.forEach((k) => o.u32(k));
  });
  const stsc = full('stsc', 0, (o) => {
    o.u32(1).u32(1).u32(n).u32(1);
  });
  const stsz = full('stsz', 0, (o) => {
    o.u32(0).u32(n);
    v.samples.forEach((s) => o.u32(s.data.length));
  });
  const stco = full('stco', 0, (o) => {
    o.u32(1).u32(dataOffset);
  });
  const stbl = boxes('stbl', [stsd, stts, stss, stsc, stsz, stco]);
  const minf = boxes('minf', [vmhd, dinf, stbl]);
  const mdia = boxes('mdia', [mdhd, hdlr, minf]);
  const trak = boxes('trak', [tkhd, mdia]);
  return boxes('moov', [mvhd, trak]);
}

/** The whole file, as parts to hand to a `Blob` (the samples are not copied). */
export function writeMp4(v: Mp4Video): Uint8Array[] {
  if (!v.samples.length) throw new RangeError('An MP4 needs at least one sample.');
  if (!v.samples[0]!.key) throw new RangeError('The first sample must be a sync sample.');
  const mediaDuration = v.samples.length * v.sampleDuration;
  const ftyp = box('ftyp', (o) =>
    o.str('isom').u32(0x200).str('isom').str('iso2').str('avc1').str('mp41'),
  );
  // The moov's size does not depend on the offset's value: measure it, then write it for real.
  const moovSize = moov(v, mediaDuration, 0).length;
  const dataOffset = ftyp.length + moovSize + 8;
  const data = v.samples.reduce((s, x) => s + x.data.length, 0);
  const mdatHead = new Out()
    .u32(data + 8)
    .str('mdat')
    .bytes();
  return [ftyp, moov(v, mediaDuration, dataOffset), mdatHead, ...v.samples.map((s) => s.data)];
}
/** Bytes `writeMp4` adds around the samples, for the size cap before the samples are kept. */
export function mp4Overhead(sampleCount: number, keyCount: number, avcC: number): number {
  // Fixed boxes plus 4 bytes per sample (stsz) and per sync sample (stss).
  return 700 + avcC + 4 * sampleCount + 4 * keyCount;
}
