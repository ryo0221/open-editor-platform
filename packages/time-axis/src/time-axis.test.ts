import { describe, expect, it } from 'vitest';
import {
  addMonths,
  axisTicks,
  dayString,
  dragDays,
  monthLabel,
  monthRange,
  monthWeeks,
  spanPlacement,
  stackSegments,
  utcDay,
  weekSegment,
  weekStart,
} from './index';

describe('time axis', () => {
  it('parses only real ISO dates', () => {
    expect(utcDay('2026-10-21')).toBe(20747);
    expect(utcDay('2026-02-30')).toBeNull();
    expect(utcDay('2026-10-21T00:00')).toBeNull();
    expect(dayString(20747)).toBe('2026-10-21');
  });
  it('keeps the Timeline tick step and labels', () => {
    const range = { start: utcDay('2026-10-01')!, end: utcDay('2026-10-10')! };
    expect(axisTicks(range, 'day').map((t) => t.label)).toEqual([
      '10-01',
      '10-02',
      '10-03',
      '10-04',
      '10-05',
      '10-06',
      '10-07',
      '10-08',
      '10-09',
      '10-10',
    ]);
    expect(axisTicks({ start: range.start, end: range.start + 99 }, 'day')).toHaveLength(17);
    expect(axisTicks(range, 'week').map((t) => t.offset)).toEqual([0, 0.7]);
  });
  it('puts month ticks on the 1st of each month, named by month', () => {
    const range = monthRange({ start: utcDay('2026-05-30')!, end: utcDay('2027-05-30')! });
    expect([dayString(range.start), dayString(range.end)]).toEqual(['2026-05-01', '2027-05-31']);
    const ticks = axisTicks(range, 'month');
    expect(ticks.map((t) => t.label)).toEqual([
      'May 2026',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
      'Jan 2027',
      'Feb',
      'Mar',
      'Apr',
      'May',
    ]);
    expect(ticks.map((t) => dayString(t.day).slice(8))).toEqual(Array(13).fill('01'));
    expect(ticks[1].offset).toBeCloseTo(31 / 396);
    // A chosen range that starts mid-month gets its first tick on the next 1st.
    expect(
      axisTicks({ start: utcDay('2026-05-30')!, end: utcDay('2026-07-15')! }, 'month'),
    ).toEqual([
      { day: utcDay('2026-06-01'), offset: 2 / 47, label: 'Jun 2026' },
      { day: utcDay('2026-07-01'), offset: 32 / 47, label: 'Jul' },
    ]);
    // Years below 100 stay where they are.
    const ancient = monthRange({ start: utcDay('0050-06-10')!, end: utcDay('0050-06-20')! });
    expect([dayString(ancient.start), dayString(ancient.end)]).toEqual([
      '0050-06-01',
      '0050-06-30',
    ]);
    // Past about 18 months, ticks skip months but stay on the 1st.
    const long = axisTicks({ start: utcDay('2020-01-01')!, end: utcDay('2025-12-31')! }, 'month');
    expect(long.length).toBeLessThanOrEqual(18);
    expect(long.every((t) => dayString(t.day).endsWith('-01'))).toBe(true);
  });
  it('lays out a month in Monday weeks and splits spans at week edges', () => {
    const october = utcDay('2026-10-21')!;
    const weeks = monthWeeks(october);
    expect(weeks.map((w) => `${dayString(w.start)}..${dayString(w.end)}`)).toEqual([
      '2026-09-28..2026-10-04',
      '2026-10-05..2026-10-11',
      '2026-10-12..2026-10-18',
      '2026-10-19..2026-10-25',
      '2026-10-26..2026-11-01',
    ]);
    expect(monthLabel(october)).toBe('Oct 2026');
    expect(dayString(addMonths(october, 3))).toBe('2027-01-01');
    expect(dayString(addMonths(october, -10))).toBe('2025-12-01');
    // Thursday 8th to Wednesday 14th runs on into the next week's row.
    const [start, end] = [utcDay('2026-10-08')!, utcDay('2026-10-14')!];
    expect(weekSegment(weeks[1], start, end)).toEqual({
      column: 3,
      span: 4,
      before: false,
      after: true,
    });
    expect(weekSegment(weeks[2], start, end)).toEqual({
      column: 0,
      span: 3,
      before: true,
      after: false,
    });
    expect(weekSegment(weeks[3], start, end)).toBeNull();
    const lanes = stackSegments([
      { column: 0, span: 3, before: false, after: false },
      { column: 2, span: 2, before: false, after: false },
      { column: 3, span: 4, before: false, after: false },
    ]);
    expect(lanes.map((s) => s.lane)).toEqual([0, 1, 0]);
    // Records in any order share a lane when they do not overlap.
    const days = [6, 5, 4, 3, 2, 1, 0].map((column) => ({
      column,
      span: 1,
      before: false,
      after: false,
    }));
    expect(stackSegments(days).map((s) => s.lane)).toEqual(Array(7).fill(0));
  });
  it('places, clips and drags day spans', () => {
    const range = { start: 100, end: 109 };
    expect(spanPlacement(range, 102, 103)).toEqual({ offset: 0.2, width: 0.2, visible: true });
    expect(spanPlacement(range, 90, 95).visible).toBe(false);
    expect(dragDays(55, 100, range)).toBe(6);
    expect(dayString(weekStart(utcDay('2026-10-25')!))).toBe('2026-10-19');
  });
});
