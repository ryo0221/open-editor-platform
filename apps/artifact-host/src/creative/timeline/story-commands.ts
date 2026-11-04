/** Owner-local Story structure commands; cross-artifact checks stay in the workbench. */
import { canonicalJson } from '@editor-platform/artifact-core';
import { timelineCommand, TimelineEditError, type TimelineRowInput } from './commands';
import { isVerifiedRows, type VerifiedTimelineRows } from './refs';
import type { StructuredData } from '@editor-platform/structured-data/model';

const clean = (r: TimelineRowInput): StructuredData['rows'][number] => ({
  id: r.id,
  values: Object.fromEntries(
    Object.entries(r.values).filter(([, v]) => v !== null && v !== undefined),
  ) as StructuredData['rows'][number]['values'],
});
export const storyGroup = (data: StructuredData, id: string): TimelineRowInput[] =>
  data.rows.filter((r) => r.id === id || r.values['tl1.subject'] === id) as TimelineRowInput[];
const key = (rows: TimelineRowInput[]) =>
  canonicalJson(rows.map(clean).sort((a, b) => a.id.localeCompare(b.id)));

export function createWorldline(
  id: string,
  label: string,
  clock: string,
  parent?: string,
  point?: number,
) {
  return timelineCommand('world', 'timeline.set-worldline', '世界線を追加', (d) => {
    if (d.rows.some((r) => r.id === id))
      throw new TimelineEditError('世界線IDは既に使われています。');
    d.rows.push(
      clean({
        id,
        values: {
          'tl1.row': 'worldline',
          'tl1.label': label,
          'tl1.clock': clock,
          'tl1.world.parent': parent,
          'tl1.time.kind': point === undefined ? undefined : 'point',
          'tl1.time.start': point,
        },
      }),
    );
  });
}

/** Parent and display point change together; the explicit inheritance set stays unchanged. */
export function setWorldline(
  id: string,
  parent: string | undefined,
  point: number | undefined,
  expected: TimelineRowInput,
) {
  const seen = structuredClone(expected);
  return timelineCommand('world', 'timeline.set-worldline', '世界線の分岐を変更', (d) => {
    const row = d.rows.find((r) => r.id === id && r.values['tl1.row'] === 'worldline');
    if (!row || key([row as TimelineRowInput]) !== key([seen]))
      throw new TimelineEditError('世界線が変わりました。再確認してください。');
    row.values = clean({
      id,
      values: {
        ...(row.values as TimelineRowInput['values']),
        'tl1.world.parent': parent,
        'tl1.time.kind': point === undefined ? undefined : 'point',
        'tl1.time.start': point,
      },
    }).values;
  });
}

function replaceRelation(
  kind: 'inherits' | 'transfer' | 'experience',
  id: string,
  input: VerifiedTimelineRows | undefined,
  expected: TimelineRowInput[],
) {
  if (input && !isVerifiedRows(input))
    throw new TimelineEditError('参照を確認してから確定してください。');
  const next = input?.rows.map(clean) ?? [];
  if (
    input &&
    (next.filter((r) => r.id === id && r.values['tl1.row'] === kind).length !== 1 ||
      next.some(
        (r) =>
          r.id !== id &&
          (kind !== 'transfer' ||
            r.values['tl1.row'] !== 'transfer-info' ||
            r.values['tl1.subject'] !== id),
      ))
  )
    throw new TimelineEditError('指定した関係とその所有行だけを変更できます。');
  const seen = structuredClone(expected);
  if (seen.length && !seen.some((r) => r.id === id && r.values['tl1.row'] === kind))
    throw new TimelineEditError('変更前の関係を確認してください。');
  return timelineCommand(
    kind === 'experience' ? 'composition' : 'world',
    kind === 'inherits'
      ? 'timeline.set-inheritance'
      : kind === 'transfer'
        ? 'timeline.set-transfer'
        : 'timeline.set-experience',
    input ? '関係を確定' : '関係を解除',
    (d) => {
      if (input?.targets.some((target) => !input.mayRead(target)))
        throw new TimelineEditError('参照先を読めなくなりました。');
      if (key(storyGroup(d, id)) !== key(seen))
        throw new TimelineEditError('関係が変わりました。再確認してください。');
      const old = new Set(seen.map((r) => r.id));
      if (next.some((r) => !old.has(r.id) && d.rows.some((existing) => existing.id === r.id)))
        throw new TimelineEditError('関係のIDは既に使われています。');
      d.rows = d.rows.filter((r) => !old.has(r.id));
      d.rows.push(...next);
    },
  );
}
export const setInheritance = (
  id: string,
  rows: VerifiedTimelineRows | undefined,
  expected: TimelineRowInput[],
) => replaceRelation('inherits', id, rows, expected);
export const setTransfer = (
  id: string,
  rows: VerifiedTimelineRows | undefined,
  expected: TimelineRowInput[],
) => replaceRelation('transfer', id, rows, expected);
export const setExperience = (
  id: string,
  rows: VerifiedTimelineRows | undefined,
  expected: TimelineRowInput[],
) => replaceRelation('experience', id, rows, expected);
