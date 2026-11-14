import { describe, expect, it } from 'vitest';
import {
  scheduleVideoDays,
  scheduleVideoFileName,
  scheduleVideoFrames,
  scheduleVideoProblems,
  type ScheduleVideoSettings,
} from './schedule-video';

const range = { first: '2027-03-31', last: '2027-08-28' };
const settings = (over: Partial<ScheduleVideoSettings> = {}): ScheduleVideoSettings => ({
  from: '2027-04-01',
  to: '2027-04-10',
  daysPerSecond: 5,
  width: 1280,
  height: 720,
  ...over,
});

describe('CS6c schedule video (ST-553, TS-2091)', () => {
  it('holds each day for the same frames, from the first day to the last (ST-553#1)', () => {
    const s = settings();
    expect(scheduleVideoProblems(range, s)).toEqual([]);
    expect(scheduleVideoDays(s)).toHaveLength(10);
    const f = scheduleVideoFrames(s);
    // 30 frames a second, 5 days a second: 6 frames a day.
    expect(f.ticks).toHaveLength(60);
    expect([0, 5, 6, 59].map((t) => f.dayOf(t))).toEqual([
      '2027-04-01',
      '2027-04-01',
      '2027-04-02',
      '2027-04-10',
    ]);
    // Across a month's end.
    const m = scheduleVideoFrames(
      settings({ from: '2027-04-29', to: '2027-05-02', daysPerSecond: 30 }),
    );
    expect(m.ticks.map((t) => m.dayOf(t))).toEqual([
      '2027-04-29',
      '2027-04-30',
      '2027-05-01',
      '2027-05-02',
    ]);
    expect(scheduleVideoFileName('Office construction', s)).toBe(
      'Office-construction-2027-04-01-2027-04-10.mp4',
    );
    expect(scheduleVideoFileName('///', s)).toBe('schedule-2027-04-01-2027-04-10.mp4');
  });

  it('refuses days outside the plan, a reversed range, odd rates, other sizes and too many frames (ST-553#2)', () => {
    expect(scheduleVideoProblems(range, settings({ from: '2027-03-01' }))).toEqual([
      'The days must lie from 2027-03-31 to 2027-08-28.',
    ]);
    expect(scheduleVideoProblems(range, settings({ from: '2027-04-11' }))).toEqual([
      'From must not come after To.',
    ]);
    expect(scheduleVideoProblems(range, settings({ to: '' }))).toEqual(['To must be a date.']);
    expect(scheduleVideoProblems(range, settings({ daysPerSecond: 4 }))).toEqual([
      'Days a second must be one of 1, 2, 3, 5, 6, 10, 15, 30.',
    ]);
    expect(scheduleVideoProblems(range, settings({ width: 1000, height: 600 }))).toEqual([
      'The size must be 720p or 1080p.',
    ]);
    // 151 days at one a second: 4,530 frames fit; ten years would not.
    expect(
      scheduleVideoProblems(
        range,
        settings({ from: range.first, to: range.last, daysPerSecond: 1 }),
      ),
    ).toEqual([]);
    expect(
      scheduleVideoProblems(
        { first: '2020-01-01', last: '2030-01-01' },
        settings({ from: '2020-01-01', to: '2030-01-01', daysPerSecond: 1 }),
      ),
    ).toEqual(['109620 frames are more than 36000; record fewer days or more days a second.']);
  });
});
