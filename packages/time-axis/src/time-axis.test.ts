import { describe, expect, it } from 'vitest';
import { axisTicks, dayString, dragDays, spanPlacement, utcDay, weekStart } from './index';

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
  it('places, clips and drags day spans', () => {
    const range = { start: 100, end: 109 };
    expect(spanPlacement(range, 102, 103)).toEqual({ offset: 0.2, width: 0.2, visible: true });
    expect(spanPlacement(range, 90, 95).visible).toBe(false);
    expect(dragDays(55, 100, range)).toBe(6);
    expect(dayString(weekStart(utcDay('2026-10-25')!))).toBe('2026-10-19');
  });
});
