import type { Rational } from '@editor-platform/animation-core';
import type { CharacterDocument } from '@editor-platform/character-core';
import { mp4Overhead, writeMp4, type Mp4Sample } from './mp4-writer';
import {
  checkVideoSettings,
  videoFrameTicks,
  videoLimits,
  VideoExportError,
  type VideoProgress,
  type VideoSettings,
} from './video-export';

/** What C8b needs of an encoded chunk (WebCodecs' `EncodedVideoChunk`). */
export interface EncodedChunkLike {
  readonly type: 'key' | 'delta';
  readonly timestamp: number;
  readonly byteLength: number;
  copyTo(destination: Uint8Array): void;
}
export interface EncoderConfigLike {
  codec: string;
  width: number;
  height: number;
  bitrate: number;
  framerate: number;
  avc: { format: 'avc' };
  latencyMode: 'quality';
}
/** What C8b needs of an encoder (WebCodecs' `VideoEncoder`). */
export interface EncoderLike {
  readonly encodeQueueSize: number;
  configure(config: EncoderConfigLike): void;
  encode(frame: FrameLike, options: { keyFrame: boolean }): void;
  flush(): Promise<void>;
  close(): void;
}
export interface FrameLike {
  close(): void;
}
/** The browser's WebCodecs, or a fake in the unit tests. */
export interface VideoEncoding {
  supported(config: EncoderConfigLike): Promise<boolean>;
  create(
    output: (
      chunk: EncodedChunkLike,
      meta?: { decoderConfig?: { description?: AllowSharedBufferSource } },
    ) => void,
    error: (e: Error) => void,
  ): EncoderLike;
}
/** Draws the frames for the encoder (the viewport, or a fake). */
export interface VideoEncodeSource {
  begin(width: number, height: number): void;
  /** The frame at `tick`, stamped with its presentation time and duration (microseconds). */
  frame(tick: number, timestamp: number, duration: number): Promise<FrameLike>;
  end(): void;
}

/** WebCodecs in this browser, or undefined where there is none (or no secure context). */
export function browserVideoEncoding(): VideoEncoding | undefined {
  const g = globalThis as {
    VideoEncoder?: typeof VideoEncoder;
  };
  const Encoder = g.VideoEncoder;
  if (!Encoder) return undefined;
  return {
    async supported(config) {
      try {
        return !!(await Encoder.isConfigSupported(config)).supported;
      } catch {
        return false;
      }
    },
    create: (output, error) =>
      new Encoder({
        output: (chunk, meta) => output(chunk, meta),
        error: (e) => error(e),
      }) as unknown as EncoderLike,
  };
}

/** H.264 levels by the most macroblocks per frame and per second they allow. */
const levels: readonly [level: number, frame: number, rate: number][] = [
  [0x1f, 3600, 108_000],
  [0x20, 5120, 216_000],
  [0x28, 8192, 245_760],
  [0x2a, 8704, 522_240],
  [0x32, 22_080, 589_824],
  [0x33, 36_864, 983_040],
  [0x34, 36_864, 2_073_600],
  [0x3c, 139_264, 4_177_920],
  [0x3d, 139_264, 8_355_840],
  [0x3e, 139_264, 16_711_680],
];
/**
 * The `avc1` codec strings to try for a size and rate: the lowest level that holds them, in
 * High, then Main, then Constrained Baseline profile.
 */
export function h264Codecs(width: number, height: number, fps: Rational): string[] {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const rate = (mbs * fps.numerator) / fps.denominator;
  const fit = levels.find(([, f, r]) => mbs <= f && rate <= r);
  if (!fit) return [];
  const level = fit[0].toString(16).padStart(2, '0');
  return [`avc1.6400${level}`, `avc1.4d00${level}`, `avc1.42e0${level}`];
}
/** A default bitrate: 0.1 bit per pixel per frame, from 1 to 80 Mbit/s. */
export function videoBitrate(width: number, height: number, fps: Rational): number {
  const bits = width * height * (fps.numerator / fps.denominator) * 0.1;
  return Math.round(Math.min(Math.max(bits, 1_000_000), 80_000_000));
}
/**
 * The MP4 clock: 90,000 ticks per second when each frame lasts a whole number of them (24, 25,
 * 30, 50, 60 and 30000/1001 fps do), otherwise the rate's own numerator.
 */
export function mp4Clock(fps: Rational): { timescale: number; sampleDuration: number } {
  // Reduced first: 7000000/1000000 is 7 fps, a clock of 7 rather than of seven million.
  const g = gcd(fps.numerator, fps.denominator);
  const n = fps.numerator / g,
    d = fps.denominator / g;
  const t = 90_000 * d;
  if (t % n === 0) return { timescale: 90_000, sampleDuration: t / n };
  return { timescale: n, sampleDuration: d };
}
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
/** A keyframe every two seconds (and the first frame). */
export const keyframeEvery = (fps: Rational) =>
  Math.max(1, Math.round((2 * fps.numerator) / fps.denominator));
/** Frames waiting in the encoder before the next one is drawn. */
const maxQueue = 4;

/**
 * C8b: draws every frame of the settings, encodes them with H.264 (WebCodecs) and writes an
 * MP4. Refuses with `video-encoder-unsupported` when no H.264 encoder takes the size and rate;
 * a cancel stops before the next frame (`video-cancelled`) and hands nothing over.
 */
export async function exportMp4(
  doc: CharacterDocument,
  settings: VideoSettings,
  source: VideoEncodeSource,
  encoding: VideoEncoding | undefined,
  progress?: VideoProgress,
  signal?: AbortSignal,
  maxBytes: number = videoLimits.maxOutputBytes,
): Promise<Blob> {
  checkVideoSettings(doc, settings);
  return encodeMp4(
    { ...settings, ticks: videoFrameTicks(settings) },
    source,
    encoding,
    progress,
    signal,
    maxBytes,
  );
}

/** The frames of a video: their size, rate, and the tick each is drawn at. */
export interface Mp4Frames {
  width: number;
  height: number;
  fps: Rational;
  ticks: readonly number[];
}

/**
 * Draws `frames.ticks` from `source`, encodes them with H.264 (WebCodecs) and writes an MP4 (the
 * size and rate already checked by the caller). Shared by the character video (C8b) and the
 * construction schedule video (CS6c).
 */
export async function encodeMp4(
  frames: Mp4Frames,
  source: VideoEncodeSource,
  encoding: VideoEncoding | undefined,
  progress?: VideoProgress,
  signal?: AbortSignal,
  maxBytes: number = videoLimits.maxOutputBytes,
): Promise<Blob> {
  const { width, height, fps, ticks } = frames;
  const unsupported = () =>
    new VideoExportError(
      'video-encoder-unsupported',
      `This browser cannot encode H.264 video at ${width} × ${height}, ${fps.numerator / fps.denominator} fps. Export frames (PNG) instead.`,
    );
  if (!encoding) throw unsupported();
  const bitrate = videoBitrate(width, height, fps);
  let config: EncoderConfigLike | undefined;
  for (const codec of h264Codecs(width, height, fps)) {
    const c: EncoderConfigLike = {
      codec,
      width,
      height,
      bitrate,
      framerate: fps.numerator / fps.denominator,
      avc: { format: 'avc' },
      latencyMode: 'quality',
    };
    if (await encoding.supported(c)) {
      config = c;
      break;
    }
  }
  if (!config) throw unsupported();
  const cancelled = () => new VideoExportError('video-cancelled', 'The export was cancelled.');
  if (signal?.aborted) throw cancelled();

  const clock = mp4Clock(fps);
  // The writer's media duration is 32 bits: refused before anything is drawn.
  if (ticks.length * clock.sampleDuration > 0xffffffff || clock.timescale > 0xffffffff)
    throw new VideoExportError(
      'video-settings',
      'This range and frame rate are too long for an MP4 clock; export a shorter range.',
    );
  const usPerFrame = (1_000_000 * fps.denominator) / fps.numerator;
  const samples: Mp4Sample[] = [];
  let avcC: Uint8Array | undefined;
  let bytes = 0;
  let keys = 0;
  let failure: Error | undefined;
  let lastTimestamp = -Infinity;
  const encoder = encoding.create(
    (chunk, meta) => {
      if (failure) return;
      const description = meta?.decoderConfig?.description;
      if (description && !avcC)
        avcC = new Uint8Array(
          ArrayBuffer.isView(description)
            ? description.buffer.slice(
                description.byteOffset,
                description.byteOffset + description.byteLength,
              )
            : description.slice(0),
        );
      // Frames out of order (B-frames) would need a composition table: not written.
      if (chunk.timestamp <= lastTimestamp) {
        failure = unsupported();
        return;
      }
      lastTimestamp = chunk.timestamp;
      const key = chunk.type === 'key';
      if (key) keys++;
      bytes += chunk.byteLength;
      if (bytes + mp4Overhead(samples.length + 1, keys, avcC?.length ?? 0) > maxBytes) {
        failure = new VideoExportError(
          'video-size',
          `The video would take more than ${Math.floor(maxBytes / 2 ** 20)} MB; export a shorter range or a smaller size.`,
        );
        return;
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({ data, key });
    },
    (e) => {
      failure ??= e;
    },
  );
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      encoder.close();
    } catch {
      // Closed by the browser after an error.
    }
  };
  source.begin(width, height);
  try {
    try {
      encoder.configure(config);
    } catch {
      throw unsupported();
    }
    const every = keyframeEvery(fps);
    for (let k = 0; k < ticks.length; k++) {
      if (signal?.aborted) throw cancelled();
      if (failure) throw failure;
      // Back pressure: the encoder keeps a few frames; the next is drawn when it takes them.
      while (encoder.encodeQueueSize > maxQueue && !failure && !signal?.aborted)
        await new Promise((r) => setTimeout(r, 1));
      if (signal?.aborted) throw cancelled();
      if (failure) throw failure;
      const frame = await source.frame(
        ticks[k]!,
        Math.round(k * usPerFrame),
        Math.round(usPerFrame),
      );
      try {
        encoder.encode(frame, { keyFrame: k % every === 0 });
      } finally {
        frame.close();
      }
      progress?.(k + 1, ticks.length);
    }
    // A cancel while the encoder finishes stops it at once (closing rejects the flush).
    await new Promise<void>((resolve, reject) => {
      const stop = () => {
        close();
        reject(cancelled());
      };
      if (signal?.aborted) return stop();
      signal?.addEventListener('abort', stop, { once: true });
      encoder.flush().then(
        () => {
          signal?.removeEventListener('abort', stop);
          resolve();
        },
        (e: unknown) => {
          signal?.removeEventListener('abort', stop);
          reject(e);
        },
      );
    });
    if (signal?.aborted) throw cancelled();
    if (failure) throw failure;
    close();
  } catch (e) {
    close();
    samples.length = 0;
    if (e instanceof VideoExportError) throw e;
    // The encoder refused a configuration it said it supports, or failed while encoding.
    if (e instanceof Error && failure === e) throw unsupported();
    throw e;
  } finally {
    source.end();
  }
  if (samples.length !== ticks.length || !avcC) throw unsupported();
  const parts = writeMp4({ width, height, ...clock, avcC, samples });
  return new Blob(parts as Uint8Array<ArrayBuffer>[], { type: 'video/mp4' });
}
