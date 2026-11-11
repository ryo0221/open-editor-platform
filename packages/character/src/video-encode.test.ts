import { describe, expect, it } from 'vitest';
import { blockyFigure } from '@editor-platform/character-core';
import { inspectVideoFile } from '@editor-platform/video-metadata/file-admission';
import {
  exportMp4,
  h264Codecs,
  mp4Clock,
  videoBitrate,
  type EncodedChunkLike,
  type EncoderConfigLike,
  type EncoderLike,
  type FrameLike,
  type VideoEncodeSource,
  type VideoEncoding,
} from './video-encode';
import { mp4Overhead, writeMp4 } from './mp4-writer';
import { videoSettingsProblems, type VideoSettings } from './video-export';

const doc = () => blockyFigure().doc;
const fps = (numerator: number, denominator = 1) => ({ numerator, denominator });
const wave = (over: Partial<VideoSettings> = {}): VideoSettings => ({
  actionId: 'wave',
  start: 0,
  end: 240_000,
  width: 320,
  height: 180,
  fps: fps(30),
  ...over,
});
const avcC = Uint8Array.of(
  1,
  0x64,
  0,
  0x1f,
  0xff,
  0xe1,
  0,
  4,
  0x67,
  0x64,
  0,
  0x1f,
  1,
  0,
  2,
  0x68,
  0xee,
);

class Frame implements FrameLike {
  closed = false;
  constructor(
    readonly tick: number,
    readonly timestamp: number,
  ) {}
  close() {
    this.closed = true;
  }
}
class Source implements VideoEncodeSource {
  frames: Frame[] = [];
  ended = 0;
  constructor(private readonly onFrame?: (k: number) => void) {}
  begin() {}
  async frame(tick: number, timestamp: number) {
    this.onFrame?.(this.frames.length);
    const f = new Frame(tick, timestamp);
    this.frames.push(f);
    await Promise.resolve();
    return f;
  }
  end() {
    this.ended++;
  }
}
/** Encodes each frame as a few bytes naming it, a turn of the event loop later. */
class FakeEncoding implements VideoEncoding {
  configs: EncoderConfigLike[] = [];
  closed = 0;
  constructor(
    private readonly accept: (c: EncoderConfigLike) => boolean = () => true,
    private readonly fail?: (k: number) => Error | undefined,
  ) {}
  async supported(c: EncoderConfigLike) {
    this.configs.push(c);
    return this.accept(c);
  }
  create(
    output: (c: EncodedChunkLike, meta?: { decoderConfig?: { description?: Uint8Array } }) => void,
    error: (e: Error) => void,
  ): EncoderLike {
    const pending: Promise<void>[] = [];
    let queue = 0;
    let k = 0;
    const fail = this.fail;
    const closeOne = () => this.closed++;
    return {
      get encodeQueueSize() {
        return queue;
      },
      configure() {},
      encode(frame, { keyFrame }) {
        const f = frame as Frame;
        const n = k++;
        queue++;
        pending.push(
          Promise.resolve().then(() => {
            queue--;
            const e = fail?.(n);
            if (e) return error(e);
            const data = new TextEncoder().encode(`${keyFrame ? 'K' : 'D'}${f.tick}`);
            output(
              {
                type: keyFrame ? 'key' : 'delta',
                timestamp: f.timestamp,
                byteLength: data.length,
                copyTo: (d) => d.set(data),
              },
              n === 0 ? { decoderConfig: { description: avcC } } : undefined,
            );
          }),
        );
      },
      async flush() {
        await Promise.all(pending);
      },
      close() {
        closeOne();
      },
    };
  }
}

/** The boxes along a path, for reading fields back. */
function find(bytes: Uint8Array, path: string[], from = 0, to = bytes.length): [number, number] {
  const v = new DataView(bytes.buffer, bytes.byteOffset);
  let at = from;
  while (at < to) {
    const size = v.getUint32(at);
    const type = String.fromCharCode(...bytes.slice(at + 4, at + 8));
    if (type === path[0]) {
      if (path.length === 1) return [at + 8, at + size];
      const skip = type === 'stsd' ? 8 : type === 'avc1' ? 78 : 0;
      return find(bytes, path.slice(1), at + 8 + skip, at + size);
    }
    at += size;
  }
  throw new Error(`no ${path[0]}`);
}

describe('MP4 export (C8b, TS-1293)', () => {
  it('chooses the H.264 level, bitrate and clock for the size and rate', () => {
    expect(h264Codecs(1280, 720, fps(30))).toEqual(['avc1.64001f', 'avc1.4d001f', 'avc1.42e01f']);
    expect(h264Codecs(1920, 1080, fps(30))[0]).toBe('avc1.640028');
    expect(h264Codecs(1920, 1080, fps(60))[0]).toBe('avc1.64002a');
    expect(h264Codecs(3840, 2160, fps(30))[0]).toBe('avc1.640033');
    expect(h264Codecs(4096, 4096, fps(60))[0]).toBe('avc1.64003c');
    expect(h264Codecs(4096, 4096, fps(120))[0]).toBe('avc1.64003d');
    expect(videoBitrate(1280, 720, fps(30))).toBe(2_764_800);
    expect(videoBitrate(64, 36, fps(24))).toBe(1_000_000);
    expect(mp4Clock(fps(30))).toEqual({ timescale: 90_000, sampleDuration: 3000 });
    expect(mp4Clock(fps(30000, 1001))).toEqual({ timescale: 90_000, sampleDuration: 3003 });
    expect(mp4Clock(fps(7))).toEqual({ timescale: 7, sampleDuration: 1 });
    // An unreduced rate is the same clock as its reduced one.
    expect(mp4Clock(fps(7_000_000, 1_000_000))).toEqual({ timescale: 7, sampleDuration: 1 });
    expect(mp4Clock(fps(60_000, 2_000))).toEqual({ timescale: 90_000, sampleDuration: 3000 });
  });

  it('writes an MP4 the video importer reads, a keyframe every two seconds', async () => {
    const encoding = new FakeEncoding();
    const source = new Source();
    const steps: number[] = [];
    const mp4 = await exportMp4(doc(), wave({ end: 240_000, fps: fps(2) }), source, encoding, (d) =>
      steps.push(d),
    );
    expect(mp4.type).toBe('video/mp4');
    expect(source.frames.map((f) => [f.tick, f.timestamp])).toEqual([
      [0, 0],
      [120_000, 500_000],
    ]);
    expect(source.frames.every((f) => f.closed)).toBe(true);
    expect(source.ended).toBe(1);
    expect(encoding.closed).toBe(1);
    expect(steps).toEqual([1, 2]);
    expect(encoding.configs[0]).toMatchObject({ codec: 'avc1.64001f' });
    const set = (await inspectVideoFile(mp4, new AbortController().signal)).plan;
    expect(set.streams).toHaveLength(1);
    expect(set.streams[0]).toMatchObject({ kind: 'video' });
    expect(set.streams[0]!.mediaEnd).toEqual({ value: 1, timescale: 1 });

    // 30 fps over one second: 30 samples of 3000 ticks, keys at 0 only (every 60 frames).
    const long = new Uint8Array(
      await (await exportMp4(doc(), wave(), new Source(), new FakeEncoding())).arrayBuffer(),
    );
    const v = new DataView(long.buffer);
    const [stts] = find(long, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stts']);
    expect([v.getUint32(stts + 4), v.getUint32(stts + 8), v.getUint32(stts + 12)]).toEqual([
      1, 30, 3000,
    ]);
    const [stss] = find(long, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stss']);
    expect([v.getUint32(stss + 4), v.getUint32(stss + 8)]).toEqual([1, 1]);
    const [mdhd] = find(long, ['moov', 'trak', 'mdia', 'mdhd']);
    expect([v.getUint32(mdhd + 12), v.getUint32(mdhd + 16)]).toEqual([90_000, 90_000]);
    // The sample offset points at the first sample, which is the first frame's bytes.
    const [stco] = find(long, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stco']);
    const offset = v.getUint32(stco + 8);
    expect(new TextDecoder().decode(long.slice(offset, offset + 2))).toBe('K0');
    const [avc] = find(long, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'avc1', 'avcC']);
    expect(long.slice(avc, avc + avcC.length)).toEqual(avcC);
    // faststart: moov before mdat.
    expect(find(long, ['moov'])[0]).toBeLessThan(find(long, ['mdat'])[0]);
  });

  it('refuses without H.264, falls back to Main, and stays within the size cap', async () => {
    await expect(exportMp4(doc(), wave(), new Source(), undefined)).rejects.toMatchObject({
      code: 'video-encoder-unsupported',
    });
    const none = new FakeEncoding(() => false);
    const source = new Source();
    await expect(exportMp4(doc(), wave(), source, none)).rejects.toMatchObject({
      code: 'video-encoder-unsupported',
      message: expect.stringContaining('Export frames (PNG) instead'),
    });
    expect(none.configs.map((c) => c.codec)).toEqual(['avc1.64001f', 'avc1.4d001f', 'avc1.42e01f']);
    expect(source.frames).toHaveLength(0);
    const main = new FakeEncoding((c) => c.codec.startsWith('avc1.4d'));
    await exportMp4(doc(), wave({ fps: fps(10) }), new Source(), main);
    expect(main.configs.at(-1)!.codec).toBe('avc1.4d001f');

    const small = await exportMp4(doc(), wave({ fps: fps(10) }), new Source(), new FakeEncoding());
    const capped = new Source();
    await expect(
      exportMp4(
        doc(),
        wave({ fps: fps(10) }),
        capped,
        new FakeEncoding(),
        undefined,
        undefined,
        200,
      ),
    ).rejects.toMatchObject({ code: 'video-size' });
    expect(capped.ended).toBe(1);
    expect(small.size).toBeLessThan(2 ** 30);
  });

  it('a cancel while the encoder flushes stops at once; a clock that overflows is refused first', async () => {
    let release: () => void = () => {};
    const slow = new FakeEncoding();
    const create = slow.create.bind(slow);
    slow.create = (output, error) => {
      const e = create(output, error);
      return {
        get encodeQueueSize() {
          return e.encodeQueueSize;
        },
        configure: (c) => e.configure(c),
        encode: (f, o) => e.encode(f, o),
        flush: () => new Promise<void>((r) => (release = r)).then(() => e.flush()),
        close: () => e.close(),
      };
    };
    const abort = new AbortController();
    const source = new Source();
    const run = exportMp4(doc(), wave({ fps: fps(10) }), source, slow, undefined, abort.signal);
    await expect.poll(() => source.ended + source.frames.length).toBe(10);
    abort.abort();
    await expect(run).rejects.toMatchObject({ code: 'video-cancelled' });
    expect(slow.closed).toBe(1);
    expect(source.ended).toBe(1);
    release();
    // 7000001/1000000 fps cannot be reduced: over 700 s its 4,901 frames of a million ticks
    // each pass the frame limit but not the MP4's 32-bit duration.
    const long = doc();
    long.actions[0]!.duration = 240_000 * 700;
    const settings = wave({
      end: 240_000 * 700,
      fps: fps(7_000_001, 1_000_000),
      width: 64,
      height: 36,
    });
    expect(videoSettingsProblems(long, settings)).toEqual([]);
    const odd = new Source();
    await expect(exportMp4(long, settings, odd, new FakeEncoding())).rejects.toMatchObject({
      code: 'video-settings',
    });
    expect(odd.frames).toHaveLength(0);
  });

  it('a cancel or an encoder error stops, closes the encoder and hands nothing over', async () => {
    const abort = new AbortController();
    const encoding = new FakeEncoding();
    const source = new Source((k) => k === 4 && abort.abort());
    await expect(
      exportMp4(doc(), wave(), source, encoding, undefined, abort.signal),
    ).rejects.toMatchObject({ code: 'video-cancelled' });
    expect(source.frames.length).toBeLessThanOrEqual(6);
    expect(source.ended).toBe(1);
    expect(encoding.closed).toBe(1);
    const failing = new FakeEncoding(undefined, (k) => (k === 3 ? new Error('boom') : undefined));
    const s2 = new Source();
    await expect(exportMp4(doc(), wave(), s2, failing)).rejects.toMatchObject({
      code: 'video-encoder-unsupported',
    });
    expect(failing.closed).toBe(1);
    expect(s2.ended).toBe(1);
  });

  it('the writer: overhead estimate covers the boxes, and the first sample must be a key', () => {
    const samples = Array.from({ length: 100 }, (_, i) => ({
      data: new Uint8Array(10),
      key: i % 30 === 0,
    }));
    const parts = writeMp4({
      width: 64,
      height: 36,
      timescale: 90_000,
      sampleDuration: 3000,
      avcC,
      samples,
    });
    const total = parts.reduce((s, p) => s + p.length, 0);
    expect(total - 1000).toBeLessThanOrEqual(mp4Overhead(100, 4, avcC.length));
    expect(() =>
      writeMp4({
        width: 64,
        height: 36,
        timescale: 90_000,
        sampleDuration: 3000,
        avcC,
        samples: [{ data: new Uint8Array(1), key: false }],
      }),
    ).toThrow(/sync sample/);
  });
});
