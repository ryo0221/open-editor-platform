/** Relative-day arithmetic for the reference Host. Never writes calculated cells. */
import type { TimelineTime } from './projection';
import { TimelineEditError } from './edit-error';
import type { TimelineRow } from './table';
import { TL1_LIMITS } from './tl1-schema';

export type TimelineCalculatedTime =
  | { state: 'resolved'; time: TimelineTime }
  | { state: 'unavailable'; reason: 'unset' | 'reference' | 'cycle' | 'clock' | 'overflow' };
export const unavailableTime = (
  reason: Extract<TimelineCalculatedTime, { state: 'unavailable' }>['reason'],
): TimelineCalculatedTime => ({ state: 'unavailable', reason });
export const rowTimeValue = (cells: TimelineRow['cells']): TimelineTime => ({
  kind: String(cells['tl1.time.kind'] ?? 'unset'),
  ...(typeof cells['tl1.time.start'] === 'number' ? { start: cells['tl1.time.start'] } : {}),
  ...(typeof cells['tl1.time.end'] === 'number' ? { end: cells['tl1.time.end'] } : {}),
  ...(typeof cells['tl1.clock'] === 'string' ? { clock: cells['tl1.clock'] } : {}),
});
/** Empty and missing cells both select the ledger world's clock (§5). */
export const effectiveClock = (clock: string | undefined, defaultClock?: string) =>
  clock || defaultClock;

/** Existing semantic clock conversion, shared by diagnostics and the read-only board.
 * Only a single unambiguous explicit fixed offset makes two clocks comparable. */
export function convertTimelineClock(
  time: TimelineTime,
  clock: string | undefined,
  rows: readonly TimelineRow[],
): TimelineTime | undefined {
  if (!time.clock || !clock) return;
  if (time.clock === clock) return time;
  const shifts = new Set(
    rows
      .filter(
        (r) => r.kind === 'clock-offset' && r.cells['tl1.offset.min'] === r.cells['tl1.offset.max'],
      )
      .flatMap((r) =>
        r.cells['tl1.clock'] === time.clock && r.cells['tl1.clock2'] === clock
          ? [Number(r.cells['tl1.offset.min'])]
          : r.cells['tl1.clock2'] === time.clock && r.cells['tl1.clock'] === clock
            ? [-Number(r.cells['tl1.offset.min'])]
            : [],
      ),
  );
  if (shifts.size !== 1) return;
  const shift = [...shifts][0],
    start = time.start === undefined ? undefined : time.start + shift,
    end = time.end === undefined ? undefined : time.end + shift;
  if (
    [start, end].some(
      (n) => n !== undefined && (!Number.isSafeInteger(n) || Math.abs(n) > TL1_LIMITS.safeDayAbs),
    )
  )
    return;
  return {
    ...time,
    clock,
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
  };
}

const safe = (n: number | undefined) =>
  n === undefined || (Number.isSafeInteger(n) && Math.abs(n) <= TL1_LIMITS.safeDayAbs);

/** An interval has known endpoints; a day/range is uncertain and stays uncertain. */
export function deriveTime(base: TimelineTime, relation: TimelineRow): TimelineCalculatedTime {
  if (base.kind === 'unset' || base.kind === 'derived') return unavailableTime('unset');
  const min = relation.cells['tl1.offset.min'] as number,
    max = relation.cells['tl1.offset.max'] as number;
  if (!safe(min) || !safe(max) || min === undefined || max === undefined || min > max)
    return unavailableTime('overflow');
  const anchor = relation.cells['tl1.anchor'];
  let start = base.start,
    end = base.end,
    kind = base.kind;
  if (kind === 'interval') {
    start = anchor === 'end' ? end : start;
    end = undefined;
    kind = 'point';
  }
  if (min !== max) {
    // For day precision the end is an upper bound, never an exact point within the day.
    end = kind === 'day' && start !== undefined ? start + 1 : kind === 'point' ? start : end;
    kind = 'range';
  }
  start = start === undefined ? undefined : start + min;
  end = end === undefined ? undefined : end + max;
  if (!safe(start) || !safe(end)) return unavailableTime('overflow');
  return {
    state: 'resolved',
    time: {
      kind,
      ...(start !== undefined ? { start } : {}),
      ...(end !== undefined ? { end } : {}),
      ...(base.clock ? { clock: base.clock } : {}),
    },
  };
}

/** Synchronous owner-local validation. External bases are not replaced by current drafts. */
export function localTimes(rows: TimelineRow[], defaultClock?: string) {
  const events = new Map(rows.filter((r) => r.kind === 'event').map((r) => [r.id, r]));
  const relations = new Map(
    rows.filter((r) => r.kind === 'derive-time').map((r) => [String(r.cells['tl1.subject']), r]),
  );
  const results = new Map<string, TimelineCalculatedTime>();
  function visit(id: string, path = new Set<string>()): TimelineCalculatedTime {
    const cached = results.get(id);
    if (cached) return cached;
    const row = events.get(id);
    if (!row) return unavailableTime('reference');
    if (path.has(id)) return unavailableTime('cycle');
    const written = rowTimeValue(row.cells);
    const time = { ...written, clock: effectiveClock(written.clock, defaultClock) };
    let result: TimelineCalculatedTime =
      time.kind === 'unset' ? unavailableTime('unset') : { state: 'resolved', time };
    if (time.kind === 'derived') {
      const relation = relations.get(id);
      if (!relation || relation.ref?.type !== 'internal') return unavailableTime('reference');
      const base = visit(relation.ref.item, new Set([...path, id]));
      result =
        base.state === 'unavailable'
          ? base
          : time.clock !== base.time.clock
            ? unavailableTime('clock')
            : deriveTime(base.time, relation);
    }
    results.set(id, result);
    return result;
  }
  for (const id of events.keys()) visit(id);
  return results;
}

/** Used by native commands and by the Host with its current readable world settings. */
export function assertLocalTimeBounds(rows: TimelineRow[], defaultClock?: string) {
  if (
    [...localTimes(rows, defaultClock).values()].some(
      (t) => t.state === 'unavailable' && t.reason === 'overflow',
    )
  )
    throw new TimelineEditError('時間の導出が計算可能な日数の範囲を超えます。');
}
