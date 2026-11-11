import { Zip, ZipPassThrough } from 'fflate';
import type { Rational } from '@editor-platform/animation-core';
import type { CharacterDocument } from '@editor-platform/character-core';
import { ticksPerSecond } from './playback';

/**
 * C8: what a frame sequence or video export draws. `start` and `end` are ticks of the action
 * (240,000 per second); `end` is exclusive, so the video lasts `end − start`.
 */
export interface VideoSettings {
  actionId: string;
  start: number;
  end: number;
  width: number;
  height: number;
  fps: Rational;
}

/** The limits the export refuses beyond (docs/character/c8-video.md). */
export const videoLimits = {
  minSide: 16,
  maxSide: 4096,
  maxPixels: 4096 * 4096,
  maxFrames: 36_000,
  minFps: 1,
  maxFps: 120,
  /**
   * The file is kept in memory until handed over, and the ZIP writer (fflate 0.8.3) has no
   * ZIP64: at most this many bytes, headers included (well inside 32-bit offsets). MP4 too.
   */
  maxOutputBytes: 2 ** 30,
} as const;

/** Frame rates offered beside the action's own. */
export const videoFrameRates: readonly Rational[] = [24, 25, 30, 50, 60].map((n) => ({
  numerator: n,
  denominator: 1,
}));
/** Sizes offered by name; any other even size within the limits is a custom size. */
export const videoSizes = [
  { label: '720p', width: 1280, height: 720 },
  { label: '1080p', width: 1920, height: 1080 },
] as const;

export type VideoExportCode =
  | 'video-settings'
  | 'video-size'
  | 'video-render-unsupported'
  | 'video-encoder-unsupported'
  | 'video-changed'
  | 'video-cancelled';
export class VideoExportError extends Error {
  constructor(
    readonly code: VideoExportCode,
    message: string,
  ) {
    super(message);
    this.name = 'VideoExportError';
  }
}

const fpsValue = (r: Rational) => r.numerator / r.denominator;
export const formatFps = (r: Rational) =>
  r.denominator === 1 ? `${r.numerator}` : `${(r.numerator / r.denominator).toFixed(3)}`;

/**
 * Why the settings cannot be exported (empty when they can). Sizes are even (video encoders
 * subsample colour by two) and the range lies inside the action.
 */
export function videoSettingsProblems(doc: CharacterDocument, s: VideoSettings): string[] {
  const out: string[] = [];
  const action = doc.actions.find((a) => a.id === s.actionId);
  if (!action) out.push('Choose an action to export.');
  const { minSide, maxSide, maxPixels, maxFrames, minFps, maxFps } = videoLimits;
  for (const [name, v] of [
    ['Width', s.width],
    ['Height', s.height],
  ] as const)
    if (!Number.isInteger(v) || v < minSide || v > maxSide || v % 2)
      out.push(`${name} must be an even number of pixels from ${minSide} to ${maxSide}.`);
  if (s.width * s.height > maxPixels) out.push(`A frame can have at most ${maxPixels} pixels.`);
  const { numerator: n, denominator: d } = s.fps;
  if (
    !Number.isSafeInteger(n) ||
    !Number.isSafeInteger(d) ||
    n <= 0 ||
    d <= 0 ||
    fpsValue(s.fps) < minFps ||
    fpsValue(s.fps) > maxFps
  )
    out.push(`The frame rate must be from ${minFps} to ${maxFps} frames per second.`);
  if (!Number.isInteger(s.start) || !Number.isInteger(s.end) || s.start < 0 || s.end <= s.start)
    out.push('The range must end after it starts.');
  else if (action && s.end > action.duration)
    out.push(
      `The range must end by the action's end (${(action.duration / ticksPerSecond).toFixed(2)} s).`,
    );
  if (!out.length) {
    const count = videoFrameCount(s);
    if (count > maxFrames)
      out.push(`At most ${maxFrames} frames can be exported (${count} asked).`);
  }
  return out;
}
/** Throws `video-settings` with every problem of the settings. */
export function checkVideoSettings(doc: CharacterDocument, s: VideoSettings) {
  const problems = videoSettingsProblems(doc, s);
  if (problems.length) throw new VideoExportError('video-settings', problems.join(' '));
}

/** Frames in `[start, end)`: frame k is drawn at `start + round(k × 240,000 / fps)`. */
export function videoFrameCount(s: Pick<VideoSettings, 'start' | 'end' | 'fps'>): number {
  const { numerator: n, denominator: d } = s.fps;
  // The k with k × 240,000 × d / n < end − start: ceil(span × n / (240,000 × d)), in integers.
  const span = s.end - s.start;
  if (span <= 0) return 0;
  const q = ticksPerSecond * d;
  let count = Math.floor((span * n + q - 1) / q);
  // A frame whose rounded tick reaches the end is past the range.
  while (count > 0 && videoFrameTick(s as Pick<VideoSettings, 'start' | 'fps'>, count - 1) >= s.end)
    count--;
  return count;
}
export function videoFrameTick(s: Pick<VideoSettings, 'start' | 'fps'>, k: number): number {
  const { numerator: n, denominator: d } = s.fps;
  return s.start + Math.round((k * ticksPerSecond * d) / n);
}
export function videoFrameTicks(s: Pick<VideoSettings, 'start' | 'end' | 'fps'>): number[] {
  return Array.from({ length: videoFrameCount(s) }, (_, k) => videoFrameTick(s, k));
}
/** `frame-00001.png`…: numbered from 1, at least five digits, all the same width. */
export function videoFrameName(k: number, count: number): string {
  return `frame-${String(k + 1).padStart(Math.max(5, String(count).length), '0')}.png`;
}
/** A file name from the document's and the action's names. */
export function videoFileName(doc: CharacterDocument, actionId: string, extension: string) {
  const action = doc.actions.find((a) => a.id === actionId);
  const base = [doc.name, action?.name]
    .filter(Boolean)
    .join(' ')
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, '_')
    .trim();
  return `${base || 'character'}.${extension}`;
}

/** What draws the frames: the viewport, or a fake in the unit tests. */
export interface VideoFrameSource {
  /** Prepares to draw `width × height`; throws `video-render-unsupported` when it cannot. */
  begin(width: number, height: number): void;
  /** The frame at `tick`, as PNG bytes. */
  png(tick: number): Promise<Uint8Array>;
  /** Always called, also after a failure or a cancel. */
  end(): void;
}
export interface VideoProgress {
  (done: number, total: number): void;
}

/** Fixed time stamps keep the archive the same for the same frames. */
const zipTime = new Date(Date.UTC(2000, 0, 1));

/**
 * C8a: draws every frame of the settings and stores them, uncompressed (PNG already is), in a
 * ZIP. Cancelling (`signal`) stops before the next frame and throws `video-cancelled`; nothing
 * is handed over then.
 */
export async function exportPngSequence(
  doc: CharacterDocument,
  settings: VideoSettings,
  source: VideoFrameSource,
  progress?: VideoProgress,
  signal?: AbortSignal,
  maxBytes: number = videoLimits.maxOutputBytes,
): Promise<Blob> {
  checkVideoSettings(doc, settings);
  const ticks = videoFrameTicks(settings);
  const chunks: Uint8Array[] = [];
  let failure: Error | undefined;
  let written = 0;
  const zip = new Zip((err, chunk) => {
    if (err) failure = err;
    else {
      chunks.push(chunk);
      written += chunk.length;
    }
  });
  // The central directory written at the end: 46 bytes and the name per file, 22 to close.
  let directory = 22;
  source.begin(settings.width, settings.height);
  try {
    for (let k = 0; k < ticks.length; k++) {
      if (signal?.aborted)
        throw new VideoExportError('video-cancelled', 'The export was cancelled.');
      const png = await source.png(ticks[k]!);
      if (signal?.aborted)
        throw new VideoExportError('video-cancelled', 'The export was cancelled.');
      const name = videoFrameName(k, ticks.length);
      // This file's local header (30 and the name), its bytes and data descriptor (16).
      directory += 46 + name.length;
      if (written + 30 + name.length + png.length + 16 + directory > maxBytes)
        throw new VideoExportError(
          'video-size',
          `The frames would take more than ${Math.floor(maxBytes / 2 ** 20)} MB; export a shorter range or a smaller size.`,
        );
      const file = new ZipPassThrough(name);
      file.mtime = zipTime;
      zip.add(file);
      file.push(png, true);
      if (failure) throw failure;
      progress?.(k + 1, ticks.length);
    }
    zip.end();
    if (failure) throw failure;
  } catch (e) {
    zip.terminate();
    chunks.length = 0;
    throw e;
  } finally {
    source.end();
  }
  return new Blob(chunks as Uint8Array<ArrayBuffer>[], { type: 'application/zip' });
}
