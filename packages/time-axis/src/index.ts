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
export function axisTicks(range: AxisRange, scale: AxisScale): AxisTick[] {
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
