import { videoLimits, videoSizes } from '@editor-platform/character/video';

/**
 * FT4c: a video of the replay, at 30 frames a second: from one replay time to another, each
 * video second showing `speed` seconds of the run. Walkers stride at one stride per video second
 * (the gait of real time), whatever the speed.
 */
export interface FactoryVideoSettings {
  /** Replay seconds (warm-up included), within the replay. */
  fromS: number;
  toS: number;
  /** Run seconds per video second. */
  speed: number;
  width: number;
  height: number;
}

export const factoryVideoFps = Object.freeze({ numerator: 30, denominator: 1 });
export const factoryVideoSpeeds: readonly number[] = Object.freeze([1, 10, 60, 600]);
export const factoryVideoSizes = videoSizes;

/** Why the settings cannot be recorded (empty when they can), for a replay `endS` long. */
export function factoryVideoProblems(endS: number, s: FactoryVideoSettings): string[] {
  const out: string[] = [];
  if (!Number.isFinite(s.fromS) || !Number.isFinite(s.toS))
    out.push('From and To must be numbers of seconds.');
  else {
    if (s.fromS < 0 || s.toS > endS) out.push(`The times must lie from 0 to ${endS} s.`);
    if (s.fromS >= s.toS) out.push('From must come before To.');
  }
  if (!factoryVideoSpeeds.includes(s.speed))
    out.push(`The speed must be one of ×${factoryVideoSpeeds.join(', ×')}.`);
  if (!factoryVideoSizes.some((v) => v.width === s.width && v.height === s.height))
    out.push(`The size must be ${factoryVideoSizes.map((v) => v.label).join(' or ')}.`);
  if (!out.length) {
    const frames = factoryVideoFrameCount(s);
    if (frames > videoLimits.maxFrames)
      out.push(
        `${frames} frames are more than ${videoLimits.maxFrames}; record a shorter span or a higher speed.`,
      );
  }
  return out;
}

/** How many frames the settings take (counted, not listed). */
export function factoryVideoFrameCount(s: Pick<FactoryVideoSettings, 'fromS' | 'toS' | 'speed'>) {
  const fps = factoryVideoFps.numerator / factoryVideoFps.denominator;
  return Math.max(0, Math.floor(((s.toS - s.fromS) / s.speed) * fps) + 1);
}

/** The frames: one tick each, the replay time (ms) a tick shows, and the walkers' stride. */
export function factoryVideoFrames(s: FactoryVideoSettings): {
  ticks: number[];
  timeOf(tick: number): number;
  strideOf(tick: number): number;
} {
  const fps = factoryVideoFps.numerator / factoryVideoFps.denominator;
  // Listed only within the limit (checked by `factoryVideoProblems` first).
  const count = Math.min(factoryVideoFrameCount(s), videoLimits.maxFrames);
  return {
    ticks: Array.from({ length: count }, (_, k) => k),
    timeOf: (tick) => Math.min(s.toS, s.fromS + (tick * s.speed) / fps) * 1000,
    strideOf: (tick) => tick / fps,
  };
}

const stem = (name: string, fallback: string) =>
  name.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '') || fallback;
const hms = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}${p(Math.floor((s % 3600) / 60))}${p(s % 60)}`;
};

/** The MP4's file name: the factory's name, then the replay span (hhmmss). */
export function factoryVideoFileName(name: string, s: Pick<FactoryVideoSettings, 'fromS' | 'toS'>) {
  return `${stem(name, 'factory')}-${hms(s.fromS * 1000)}-${hms(s.toS * 1000)}.mp4`;
}

/** The still's file name: the factory's name, then the replay time (hhmmss). */
export function factoryStillFileName(name: string, timeMs: number) {
  return `${stem(name, 'factory')}-${hms(timeMs)}.png`;
}
