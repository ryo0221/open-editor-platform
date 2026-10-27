/** Display helpers for the Schedule Surface. Private view state only; never content. */
import { dayString, utcDay, weekStart, DAY_MS, type AxisRange } from '@editor-platform/time-axis';
import {
  eventDays,
  frozenEvent,
  timedInstants,
  type EventTime,
  type ScheduleDocument,
  type ScheduleEvent,
  type TimedTime,
} from './model';
import {
  resolveLocal,
  sameZone,
  timeLabel,
  wallTime,
  type Fold,
  type LocalDateTime,
  type WallTime,
} from './zone';
import type { OverlayEvent, OverlayRead } from './host';

/** Collision-free key for a (lane, row) link: IDs may contain any delimiter. */
export const linkKey = (laneId: string, rowId: string) => JSON.stringify([laneId, rowId]);
export const wallDate = (instant: number, zone: string) => wallTime(instant, zone).date;
export const weekRange = (anyDay: number): AxisRange => {
  const start = weekStart(anyDay);
  return { start, end: start + 6 };
};
export const weekDays = (range: AxisRange) =>
  Array.from({ length: range.end - range.start + 1 }, (_, i) => range.start + i);
const dayFormat = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
export const dayLabel = (day: number) => dayFormat.format(new Date(day * DAY_MS));
export function rangeLabel(range: AxisRange) {
  const year = dayString(range.end).slice(0, 4);
  return `${dayLabel(range.start)} – ${dayLabel(range.end)}, ${year}`;
}

export interface PlacedEvent {
  event: ScheduleEvent;
  startDay: number;
  endDay: number;
  /** Minutes from local midnight in the display zone; undefined for all-day events. */
  startMinutes?: number;
  label: string;
  /** Set when the stored time cannot be resolved (it is still shown, never dropped). */
  problem?: string;
}
export function timeText(time: EventTime, displayZone: string) {
  if (time.kind === 'allDay') {
    const last = dayString(utcDay(time.endDateExclusive)! - 1);
    return last === time.startDate
      ? `${time.startDate} · All day`
      : `${time.startDate} – ${last} · All day`;
  }
  const { start, end } = timedInstants(time);
  return timedText(time, wallTime(start, displayZone), wallTime(end, displayZone), displayZone);
}
function timedText(time: TimedTime, s: WallTime, e: WallTime, displayZone: string) {
  const zone = sameZone(displayZone, time.timeZone)
    ? ''
    : ` (${time.startLocal.slice(11)} ${time.timeZone})`;
  return s.date === e.date
    ? `${s.date} ${timeLabel(s.minutes)}–${timeLabel(e.minutes)}${zone}`
    : `${s.date} ${timeLabel(s.minutes)} – ${e.date} ${timeLabel(e.minutes)}${zone}`;
}
// One placement per frozen event and display zone: an edit replaces only the changed event, so
// only that one is placed again. Each timed event resolves its instants once. An event that is not
// frozen could change in place, so it is placed every time.
const placements = new WeakMap<ScheduleEvent, Map<string, PlacedEvent>>();
function placeEvent(event: ScheduleEvent, displayZone: string): PlacedEvent {
  let byZone = placements.get(event);
  const cached = byZone?.get(displayZone);
  if (cached) return cached;
  let placed: PlacedEvent;
  try {
    if (event.time.kind === 'allDay') {
      const days = eventDays(event.time, displayZone, wallDate);
      placed = {
        event,
        startDay: days.start,
        endDay: days.end,
        label: timeText(event.time, displayZone),
      };
    } else {
      const { start, end } = timedInstants(event.time);
      const s = wallTime(start, displayZone),
        e = wallTime(end, displayZone);
      placed = {
        event,
        startDay: utcDay(s.date)!,
        // An event ending exactly at midnight does not occupy the next day.
        endDay: utcDay(wallDate(end - 1, displayZone))!,
        startMinutes: s.minutes,
        label: timedText(event.time, s, e, displayZone),
      };
    }
  } catch (error) {
    // Validated content resolves; this only guards zone data that changed under the Host.
    const day = utcDay(
      event.time.kind === 'allDay' ? event.time.startDate : event.time.startLocal.slice(0, 10),
    )!;
    placed = {
      event,
      startDay: day,
      endDay: day,
      label: 'Time cannot be shown',
      problem: (error as Error).message,
    };
  }
  if (frozenEvent(event)) {
    if (!byZone) placements.set(event, (byZone = new Map()));
    byZone.set(displayZone, placed);
  }
  return placed;
}
export function placeEvents(content: ScheduleDocument, displayZone: string): PlacedEvent[] {
  return content.events
    .map((event) => placeEvent(event, displayZone))
    .sort(
      (a, b) =>
        a.startDay - b.startDay ||
        (a.startMinutes ?? -1) - (b.startMinutes ?? -1) ||
        a.event.title.localeCompare(b.event.title) ||
        a.event.id.localeCompare(b.event.id),
    );
}

export interface PlacedOverlay {
  item: OverlayEvent;
  day: number;
  label: string;
  sourceLabel: string;
  busyOnly: boolean;
}
export function placeOverlay(
  reads: OverlayRead[],
  sources: Map<string, { label: string; access: 'details' | 'busy' }>,
  displayZone: string,
  /** Days being shown. A long event is cut to them before the placement limit applies. */
  range?: AxisRange,
): PlacedOverlay[] {
  return reads
    .flatMap((read) =>
      read.events.flatMap((item) => {
        const source = sources.get(read.sourceHandle);
        let first: number, last: number, label: string;
        if (item.allDay) {
          // All-day dates are the same in every display zone.
          const from = utcDay(item.allDay.startDate),
            to = utcDay(item.allDay.endDate);
          if (from === null || to === null) return [];
          [first, last, label] = [from, Math.max(from, to - 1), 'All day'];
        } else {
          const s = wallTime(item.start, displayZone),
            e = wallTime(item.end, displayZone);
          first = utcDay(s.date)!;
          // One placement per occupied day; an end exactly at midnight does not occupy that day.
          last = Math.max(
            first,
            utcDay(wallDate(Math.max(item.start, item.end - 1), displayZone))!,
          );
          label = `${timeLabel(s.minutes)}–${timeLabel(e.minutes)}`;
        }
        if (range) [first, last] = [Math.max(first, range.start), Math.min(last, range.end)];
        if (first > last) return [];
        return Array.from({ length: Math.min(last - first + 1, 366) }, (_, i) => ({
          item,
          day: first + i,
          label,
          sourceLabel: source?.label ?? 'Calendar',
          // A busy-only source never shows details, even if a Host sent them.
          busyOnly: source?.access !== 'details' || item.title === undefined,
        }));
      }),
    )
    .sort((a, b) => a.item.start - b.item.start);
}
/** Days of the range that some selected source could not read. Unknown, not free. */
export function unknownDays(reads: OverlayRead[], range: AxisRange, displayZone: string) {
  const days = new Set<number>();
  for (const read of reads)
    for (const gap of read.missing) {
      const from = utcDay(wallDate(gap.from, displayZone))!,
        to = utcDay(wallDate(Math.max(gap.from, gap.to - 1), displayZone))!;
      for (let d = Math.max(from, range.start); d <= Math.min(to, range.end); d++) days.add(d);
    }
  return days;
}
/** UTC instants that cover the displayed days in the display zone, with a day of margin. */
export const overlayWindow = (range: AxisRange) => ({
  from: (range.start - 1) * DAY_MS,
  to: (range.end + 2) * DAY_MS,
});

/** Wall times seen in the display zone, stored as the same instants in the event zone. When the
 * stored wall time occurs twice there, the fold that names the chosen instant goes with it. */
export function displayedTime(
  startLocal: LocalDateTime,
  endLocal: LocalDateTime,
  displayZone: string,
  eventZone: string,
): TimedTime {
  const convert = (local: LocalDateTime): { local: LocalDateTime; fold?: Fold } => {
    const seen = resolveLocal(local, displayZone);
    if (seen.kind === 'missing') return { local };
    const instant = seen.kind === 'exact' ? seen.instant : seen.earlier;
    const wall = wallTime(instant, eventZone);
    const stored = `${wall.date}T${timeLabel(wall.minutes)}`;
    const back = resolveLocal(stored, eventZone);
    if (back.kind !== 'ambiguous') return { local: stored };
    return { local: stored, fold: instant === back.earlier ? 'earlier' : 'later' };
  };
  const start = convert(startLocal),
    end = convert(endLocal);
  return {
    kind: 'timed',
    startLocal: start.local,
    endLocal: end.local,
    timeZone: eventZone,
    ...(start.fold && { startFold: start.fold }),
    ...(end.fold && { endFold: end.fold }),
  };
}
