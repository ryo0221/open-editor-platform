/** Shared calendar-day axis for Data Timeline and Schedule. Pure, no DOM and no time zone. */
export type AxisScale = 'day' | 'week' | 'month';
export const DAY_MS = 86_400_000;
export interface AxisRange {
  /** First UTC calendar day number (inclusive). */
  start: number;
  /** Last UTC calendar day number (inclusive). */
  end: number;
}
export interface AxisTick {
  day: number;
  /** 0..1 from the start of the range. */
  offset: number;
  label: string;
}

/** Calendar day number of an ISO date (YYYY-MM-DD); null for anything else. */
export function utcDay(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const n = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === value
    ? Math.floor(n / DAY_MS)
    : null;
}
export const dayString = (day: number) =>
  new Date(Math.round(day) * DAY_MS).toISOString().slice(0, 10);
export const addDays = (date: string, days: number) => {
  const day = utcDay(date);
  if (day === null) throw new Error('Invalid date');
  return dayString(day + days);
};
/** Monday of the ISO week containing the day. */
export const weekStart = (day: number) => day - ((new Date(day * DAY_MS).getUTCDay() + 6) % 7);
export const rangeLength = (range: AxisRange) => Math.max(1, range.end - range.start + 1);

/** Label step: at least one scale unit, and at most about 18 labels. */
export function axisStep(range: AxisRange, scale: AxisScale) {
  return Math.max(
    scale === 'day' ? 1 : scale === 'week' ? 7 : 30,
    Math.ceil(rangeLength(range) / 18),
  );
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Day number of the 1st of a month, n months after the month containing the day. */
function firstOfMonth(day: number, n: number) {
  const date = new Date(day * DAY_MS);
  // setUTCFullYear keeps years 0–99, which Date.UTC would read as 1900–1999.
  date.setUTCFullYear(date.getUTCFullYear(), date.getUTCMonth() + n, 1);
  return Math.floor(date.getTime() / DAY_MS);
}
/** First day of the calendar month containing the day. */
export const monthStart = (day: number) => firstOfMonth(day, 0);
/** Last day of the calendar month containing the day. */
export const monthEnd = (day: number) => firstOfMonth(day, 1) - 1;
/** A month scale range widened to whole calendar months. */
export const monthRange = (range: AxisRange): AxisRange => ({
  start: monthStart(range.start),
  end: monthEnd(range.end),
});
/** Month and year of the day, such as "Oct 2026". */
export const monthLabel = (day: number) => {
  const date = new Date(day * DAY_MS);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
};
/** First day of the month n months after the month containing the day. */
export const addMonths = (day: number, n: number) => firstOfMonth(day, n);
/** Monday-start weeks that cover the calendar month containing the day. */
export function monthWeeks(day: number): AxisRange[] {
  const weeks: AxisRange[] = [];
  for (let start = weekStart(monthStart(day)); start <= monthEnd(day); start += 7)
    weeks.push({ start, end: start + 6 });
  return weeks;
}
export interface WeekSegment {
  /** Weekday column, 0 (Monday) to 6. */
  column: number;
  span: number;
  /** The span started before this week or goes on after it. */
  before: boolean;
  after: boolean;
}
/** The part of an inclusive day span inside one week, or null when it misses the week. */
export function weekSegment(week: AxisRange, start: number, end: number): WeekSegment | null {
  if (end < week.start || start > week.end) return null;
  const from = Math.max(start, week.start),
    to = Math.min(end, week.end);
  return {
    column: from - week.start,
    span: to - from + 1,
    before: start < week.start,
    after: end > week.end,
  };
}
/** Puts each segment on the first lane where it overlaps nothing, whatever order they come in. */
export function stackSegments<T extends WeekSegment>(segments: T[]): (T & { lane: number })[] {
  const lanes: number[] = [],
    placed = new Map<T, number>();
  // Filling lanes from the left keeps non-overlapping segments on one lane.
  for (const segment of [...segments].sort((a, b) => a.column - b.column)) {
    let lane = lanes.findIndex((free) => free <= segment.column);
    if (lane < 0) lane = lanes.length;
    lanes[lane] = segment.column + segment.span;
    placed.set(segment, lane);
  }
  return segments.map((segment) => ({ ...segment, lane: placed.get(segment)! }));
}
/** Month ticks sit on the 1st of each month (every nth month past about 18), named by month. */
function monthTicks(range: AxisRange): AxisTick[] {
  const length = rangeLength(range),
    firsts: number[] = [];
  for (let day = monthStart(range.start); day <= range.end; day = monthEnd(day) + 1)
    if (day >= range.start) firsts.push(day);
  const every = Math.max(1, Math.ceil(firsts.length / 18));
  return firsts
    .filter((_, i) => i % every === 0)
    .map((day, i) => {
      const month = new Date(day * DAY_MS).getUTCMonth();
      return {
        day,
        offset: (day - range.start) / length,
        label: i === 0 || month === 0 ? monthLabel(day) : MONTHS[month],
      };
    });
}
export function axisTicks(range: AxisRange, scale: AxisScale): AxisTick[] {
  if (scale === 'month') return monthTicks(range);
  const length = rangeLength(range),
    step = axisStep(range, scale);
  return Array.from({ length: Math.ceil(length / step) }, (_, i) => ({
    day: range.start + i * step,
    offset: (i * step) / length,
    label: dayString(range.start + i * step).slice(5),
  }));
}
/** Position and width (0..1) of an inclusive day span, clipped to the range. */
export function spanPlacement(range: AxisRange, start: number, end: number) {
  const length = rangeLength(range);
  return {
    offset: Math.max(0, (start - range.start) / length),
    width: Math.max(0.5, Math.min(range.end, end) - Math.max(range.start, start) + 1) / length,
    visible: end >= range.start && start <= range.end,
  };
}
/** Whole days moved by a pointer drag of dx pixels over a track of width pixels. */
export const dragDays = (dx: number, width: number, range: AxisRange) =>
  Math.round((dx / width) * rangeLength(range));
