/** Pure view choices; no native commands, writes, diagnostic runs or interpolation. */
import { deepFreeze } from '@editor-platform/artifact-core';
import type { TimelineTime } from '../timeline/projection';
import {
  boardItemKey,
  validateBoardFilter,
  type BoardChoice,
  type BoardFilter,
  type BoardTime,
} from './settings';
import type { BoardReading } from './reading';

const choiceMatches = (choice: BoardChoice, keys: readonly string[]) =>
  choice.kind === 'all' || keys.some((key) => choice.ids.includes(key));
/** Half-open day/interval; range has inclusive, possibly unbounded uncertainty bounds. */
export function boardTimeMatches(
  time: TimelineTime | undefined,
  query: BoardTime,
): boolean | undefined {
  if (query.kind === 'all') return true;
  if (!time || time.clock !== query.clock || ['unset', 'derived'].includes(time.kind)) return;
  if (time.kind === 'range') {
    if (time.start === undefined && time.end === undefined) return;
    const lower = time.start ?? -Infinity,
      upper = time.end ?? Infinity;
    return query.kind === 'point'
      ? lower <= query.value && query.value <= upper
      : lower < query.end && query.start <= upper;
  }
  if (time.start === undefined) return;
  if (time.kind === 'point')
    return query.kind === 'point'
      ? time.start === query.value
      : time.start >= query.start && time.start < query.end;
  const end = time.kind === 'day' ? time.start + 1 : time.end;
  if (end === undefined) return;
  return query.kind === 'point'
    ? time.start <= query.value && query.value < end
    : time.start < query.end && query.start < end;
}
export function filterStoryBoard(reading: BoardReading, input: BoardFilter) {
  if (!reading.current()) throw Error('物語ボードの表示対象が変わりました。');
  const filter = validateBoardFilter(input);
  if (filter.time.kind !== 'all' && filter.time.clock !== reading.opened.settings.clock)
    throw Error('この表示の時計と保存条件の時計が異なります。条件を確認してください。');
  const groups = reading.opened.settings.groups.filter(
    (g) => filter.groups.kind === 'set' && filter.groups.ids.includes(g.id),
  );
  const groupMatches = (event: string, individuals: readonly string[]) =>
    filter.groups.kind === 'all' ||
    groups.some(
      (g) =>
        g.events.some((e) => boardItemKey(e) === event) ||
        g.individuals.some((id) => individuals.includes(id)),
    );
  const placeMatches = (places: string[]) =>
    choiceMatches(filter.places, places) ||
    (filter.places.kind === 'set' &&
      filter.places.ids.length > 0 &&
      places.length === 0 &&
      filter.includeUnknown);
  const timeMatches = (time: TimelineTime | undefined) =>
    boardTimeMatches(time, filter.time) ?? filter.includeUnknown;
  const events = reading.events.filter(
    (e) =>
      choiceMatches(filter.individuals, e.individuals) &&
      placeMatches(
        reading.presences
          .filter(
            (p) =>
              p.event === e.key &&
              choiceMatches(filter.individuals, [p.individual]) &&
              p.place &&
              boardTimeMatches(p.time, filter.time) === true,
          )
          .map((p) => p.place!),
      ) &&
      groupMatches(e.key, e.individuals) &&
      timeMatches(e.time),
  );
  const presences = reading.presences.filter(
    (p) =>
      choiceMatches(filter.individuals, [p.individual]) &&
      placeMatches(p.place ? [p.place] : []) &&
      groupMatches(p.event, [p.individual]) &&
      timeMatches(p.time),
  );
  const individuals = reading.individuals.filter(
    (individual) =>
      choiceMatches(filter.individuals, [individual.key]) &&
      (filter.groups.kind === 'all' ||
        groups.some(
          (g) =>
            g.individuals.includes(individual.key) ||
            g.events.some((ref) =>
              reading.events.some(
                (e) => e.key === boardItemKey(ref) && e.individuals.includes(individual.key),
              ),
            ),
        )) &&
      (filter.places.kind === 'all' ||
        presences.some((p) => p.individual === individual.key) ||
        (filter.places.kind === 'set' &&
          filter.places.ids.length > 0 &&
          filter.includeUnknown &&
          !reading.presences.some(
            (p) =>
              p.individual === individual.key && boardTimeMatches(p.time, filter.time) === true,
          ))),
  );
  const positions = individuals.map((individual) => {
    const records = presences.filter(
      (p) => p.individual === individual.key && boardTimeMatches(p.time, filter.time) === true,
    );
    return {
      individual,
      records: filter.time.kind === 'point' ? records : [],
      reason: reading.presences.some((p) => p.individual === individual.key && !p.time)
        ? ('clock' as const)
        : ('unrecorded' as const),
      state:
        filter.time.kind !== 'point'
          ? ('choose-time' as const)
          : records.length
            ? ('records' as const)
            : ('unknown' as const),
    };
  });
  return deepFreeze({ filter, events, presences, individuals, positions });
}
export type FilteredStoryBoard = ReturnType<typeof filterStoryBoard>;
