import { addDays, utcDay } from '@editor-platform/time-axis';
import { videoLimits, videoSizes } from '@editor-platform/character/video';

/**
 * CS6c: a video of the schedule played day by day, at 30 frames a second, each day held for the
 * same number of frames.
 */
export interface ScheduleVideoSettings {
  /** First and last day shown ("YYYY-MM-DD"), within the slider's days. */
  from: string;
  to: string;
  /** Days a second: one that divides the 30 frames a second evenly. */
  daysPerSecond: number;
  width: number;
  height: number;
}

export const scheduleVideoFps = Object.freeze({ numerator: 30, denominator: 1 });
/** The days a second offered: each holds a day for a whole number of frames. */
export const scheduleVideoRates: readonly number[] = Object.freeze([1, 2, 3, 5, 6, 10, 15, 30]);
export const scheduleVideoSizes = videoSizes;

/** Why the settings cannot be recorded (empty when they can), for days within `range`. */
export function scheduleVideoProblems(
  range: { first: string; last: string },
  s: ScheduleVideoSettings,
): string[] {
  const out: string[] = [];
  const from = utcDay(s.from);
  const to = utcDay(s.to);
  const [first, last] = [utcDay(range.first)!, utcDay(range.last)!];
  if (from == null) out.push('From must be a date.');
  if (to == null) out.push('To must be a date.');
  if (from != null && to != null) {
    if (from < first || to > last)
      out.push(`The days must lie from ${range.first} to ${range.last}.`);
    if (from > to) out.push('From must not come after To.');
  }
  if (!scheduleVideoRates.includes(s.daysPerSecond))
    out.push(`Days a second must be one of ${scheduleVideoRates.join(', ')}.`);
  if (!scheduleVideoSizes.some((v) => v.width === s.width && v.height === s.height))
    out.push(`The size must be ${scheduleVideoSizes.map((v) => v.label).join(' or ')}.`);
  if (!out.length) {
    const frames = scheduleVideoDays(s).length * framesPerDay(s);
    if (frames > videoLimits.maxFrames)
      out.push(
        `${frames} frames are more than ${videoLimits.maxFrames}; record fewer days or more days a second.`,
      );
  }
  return out;
}

const framesPerDay = (s: Pick<ScheduleVideoSettings, 'daysPerSecond'>) =>
  scheduleVideoFps.numerator / s.daysPerSecond;

/** The days recorded, `from` to `to`. */
export function scheduleVideoDays(s: Pick<ScheduleVideoSettings, 'from' | 'to'>): string[] {
  const out: string[] = [];
  for (let d = s.from; d <= s.to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The frames: one tick each, and the day a tick shows. */
export function scheduleVideoFrames(s: ScheduleVideoSettings): {
  ticks: number[];
  dayOf(tick: number): string;
} {
  const days = scheduleVideoDays(s);
  const per = framesPerDay(s);
  return {
    ticks: Array.from({ length: days.length * per }, (_, k) => k),
    dayOf: (tick) => days[Math.floor(tick / per)]!,
  };
}

/** The MP4's file name: the schedule's name, then the days. */
export function scheduleVideoFileName(name: string, s: Pick<ScheduleVideoSettings, 'from' | 'to'>) {
  const stem = name.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '') || 'schedule';
  return `${stem}-${s.from}-${s.to}.mp4`;
}
