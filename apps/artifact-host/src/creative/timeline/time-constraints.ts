/** Pairwise checks of explicitly written temporal constraints, never a scheduling solver. */
import type { TimelineTime } from './projection';
import { TL1_LIMITS } from './tl1-schema';
import type { TimelineRow } from './table';

/** A cycle of nonnegative internal constraints with a strict edge is impossible,
 * independently of day precision. Exact-version nodes are not collapsed into drafts.
 * This checks declared order only; it neither solves schedules nor rejects cause cycles. */
export function strictConstraintCycles(rows: TimelineRow[], defaultClock?: string): Set<string> {
  const clocks = new Map(
    rows.filter((r) => r.kind === 'event').map((r) => [r.id, r.cells['tl1.clock'] ?? defaultClock]),
  );
  const edges = rows.flatMap((r) => {
    const min = Number(r.cells['tl1.offset.min'] ?? 0);
    return (r.kind === 'after' || r.kind === 'travel-min') &&
      r.ref?.type === 'internal' &&
      !!clocks.get(r.ref.item) &&
      clocks.get(r.ref.item) === clocks.get(String(r.cells['tl1.subject'])) &&
      r.cells['tl1.offset.max'] === undefined &&
      (r.kind === 'after' || min >= 0)
      ? [
          {
            id: r.id,
            from: r.ref.item,
            to: String(r.cells['tl1.subject']),
            strict: r.kind === 'after' || min > 0,
          },
        ]
      : [];
  });
  const forward = new Map<string, string[]>(),
    reverse = new Map<string, string[]>();
  for (const e of edges) {
    forward.set(e.from, [...(forward.get(e.from) ?? []), e.to]);
    reverse.set(e.to, [...(reverse.get(e.to) ?? []), e.from]);
  }
  const nodes = new Set(edges.flatMap((e) => [e.from, e.to]));
  const seen = new Set<string>(),
    order: string[] = [];
  for (const n of nodes) {
    const stack: [string, boolean][] = [[n, false]];
    while (stack.length) {
      const [v, exit] = stack.pop()!;
      if (exit) {
        order.push(v);
        continue;
      }
      if (seen.has(v)) continue;
      seen.add(v);
      stack.push([v, true]);
      for (const to of forward.get(v) ?? []) if (!seen.has(to)) stack.push([to, false]);
    }
  }
  const component = new Map<string, string>();
  for (const n of order.reverse()) {
    const stack = [n];
    while (stack.length) {
      const v = stack.pop()!;
      if (component.has(v)) continue;
      component.set(v, n);
      stack.push(...(reverse.get(v) ?? []).filter((to) => !component.has(to)));
    }
  }
  const impossible = new Set(
    edges
      .filter((e) => e.strict && component.get(e.from) === component.get(e.to))
      .map((e) => component.get(e.from)),
  );
  return new Set(
    edges
      .filter(
        (e) =>
          component.get(e.from) === component.get(e.to) && impossible.has(component.get(e.from)),
      )
      .map((e) => e.id),
  );
}

export type TimeConstraintResult =
  | { state: 'satisfied' | 'violated' }
  | {
      state: 'undetermined';
      reason: 'time' | 'precision' | 'clock' | 'reference' | 'unsupported' | 'overflow';
    };
type Bounds = { low: number; high: number; lowClosed: boolean; highClosed: boolean };
function bounds(t: TimelineTime, anchor: 'start' | 'end'): Bounds | undefined {
  if (t.kind === 'unset' || t.kind === 'derived') return;
  if (t.kind === 'point' || t.kind === 'interval') {
    const n = t.kind === 'interval' && anchor === 'end' ? t.end : t.start;
    return n === undefined ? undefined : { low: n, high: n, lowClosed: true, highClosed: true };
  }
  if (t.kind === 'day')
    return t.start === undefined
      ? undefined
      : { low: t.start, high: t.start + 1, lowClosed: true, highClosed: false };
  if (t.kind === 'range')
    return {
      low: t.start ?? -Infinity,
      high: t.end ?? Infinity,
      lowClosed: t.start !== undefined,
      highClosed: t.end !== undefined,
    };
}
/** Both values have already been placed on the same explicitly known clock by the Host. */
export function compareTimeConstraint(
  subject: TimelineTime,
  base: TimelineTime,
  kind: 'after' | 'travel-min',
  minimum: number,
  anchor: 'start' | 'end' = 'start',
  maximum?: number,
): TimeConstraintResult {
  // tl1 defines the minimum; no upper-bound interpretation is silently invented here.
  if (maximum !== undefined) return { state: 'undetermined', reason: 'unsupported' };
  if (
    ![minimum, subject.start, subject.end, base.start, base.end].every(
      (n) => n === undefined || (Number.isSafeInteger(n) && Math.abs(n) <= TL1_LIMITS.safeDayAbs),
    )
  )
    return { state: 'undetermined', reason: 'overflow' };
  const a = bounds(subject, 'start'),
    b = bounds(base, anchor);
  if (!a || !b) return { state: 'undetermined', reason: 'time' };
  const strict = kind === 'after' && minimum <= 0;
  const threshold = strict ? 0 : minimum;
  const low = a.low - b.high,
    high = a.high - b.low;
  const lowClosed = a.lowClosed && b.highClosed,
    highClosed = a.highClosed && b.lowClosed;
  if (high < threshold || (high === threshold && (strict || !highClosed)))
    return { state: 'violated' };
  if (low > threshold || (low === threshold && (!strict || !lowClosed)))
    return { state: 'satisfied' };
  return { state: 'undetermined', reason: 'precision' };
}
