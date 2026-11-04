/**
 * Story Timeline T2 foundation: the native commands that edit one tl1 owner table
 * (t0-contract.md §2.7). Every edit is one `EditorCommand<StructuredData>` for that owner's
 * `ArtifactEditor.execute`, so one confirmed edit is one Undo in that owner's own history.
 *
 * A command never repairs a table: the input must already pass `readTimelineTable` (an
 * invalid table is read-only), and the result must pass it too, or the command throws and
 * nothing enters the history. The same check runs for every entry (drag, form, keyboard,
 * headless) because they all build these commands (TL18a, TL30a).
 */
import { command, type EditorCommand } from '@editor-platform/editor-core';
import { canonicalJson } from '@editor-platform/artifact-core';
import type { EditorHostAdapter } from '@editor-platform/editor-host';
import { isStructuredData, type StructuredData } from '@editor-platform/structured-data/model';
import {
  TimelineEditError,
  type TimelineCells as Cells,
  type TimelineRowInput,
} from './edit-error';
import { exactTargets, isVerifiedRows, type VerifiedTimelineRows } from './refs';
import { readTimelineTable, type TimelineCell, type TimelineRole } from './table';
import { assertLocalTimeBounds } from './time';

export { TimelineEditError, type TimelineRowInput } from './edit-error';

const present = (values: Cells) =>
  Object.fromEntries(
    Object.entries(values).filter(([, v]) => v !== null && v !== undefined),
  ) as Record<string, TimelineCell>;

function check(role: TimelineRole, data: StructuredData, when: 'before' | 'after') {
  const r = readTimelineTable(role, data);
  if (when === 'after' && role === 'ledger' && r.state === 'valid') assertLocalTimeBounds(r.rows);
  if (r.state !== 'invalid') return;
  const first = r.problems[0];
  throw new TimelineEditError(
    when === 'before'
      ? `この表は契約の形と合わないため編集できません（${first?.message ?? '不明'}）。`
      : `この変更は保存できる表になりません（${first?.row ? `${first.row}：` : ''}${first?.message ?? '不明'}）。`,
  );
}

/**
 * The common shape of every timeline command: the owner table must read before the edit, the
 * edit runs on a private copy, and the result must read again. Throwing leaves the content and
 * the history as they were.
 */
export function timelineCommand(
  role: TimelineRole,
  type: string,
  label: string,
  edit: (draft: StructuredData) => void,
): EditorCommand<StructuredData> {
  return command<StructuredData>(type, label, (content) => {
    check(role, content, 'before');
    const draft = structuredClone(content);
    edit(draft);
    check(role, draft, 'after');
    return draft;
  });
}

/**
 * `timeline.insert-rows`: rows with the given IDs and cells, not Data's `addRow` (which makes
 * its own ID and default values). An ID already in the table, or given twice, is refused.
 *
 * A row that writes an exact reference to another owner is accepted only as rows confirmed by
 * `verifyNewReferences` (the reader cannot see other owners, §2.3). Read permission on each
 * confirmed target is checked again when the command is applied.
 */
export function insertRows(
  role: TimelineRole,
  input: TimelineRowInput[] | VerifiedTimelineRows,
  label = '行を追加',
): EditorCommand<StructuredData> {
  const verified = isVerifiedRows(input) ? input : undefined;
  if (!verified && !Array.isArray(input))
    throw new TimelineEditError('確かめた行ではありません。参照先を確かめてから追加します。');
  const rows = verified ? verified.rows : (input as TimelineRowInput[]);
  return timelineCommand(role, 'timeline.insert-rows', label, (d) => {
    if (!verified) {
      const external = rows.find((r) => exactTargets(r.values).length);
      if (external)
        throw new TimelineEditError(
          `${external.id} は別の資料へのexact参照を書くため、参照先を確かめてから追加します。`,
        );
    } else if (verified.targets.some((t) => !verified.mayRead(t)))
      throw new TimelineEditError('参照先を読めなくなったため、この参照は書けません。');
    const ids = new Set(d.rows.map((r) => r.id));
    for (const r of rows) {
      if (typeof r.id !== 'string' || !r.id.trim())
        throw new TimelineEditError('行のIDがありません。');
      if (ids.has(r.id)) throw new TimelineEditError(`ID ${r.id} は既にあります。`);
      ids.add(r.id);
      d.rows.push({ id: r.id, values: present(r.values) });
    }
  });
}

export interface TimelineTimeInput {
  kind: 'unset' | 'point' | 'day' | 'interval' | 'range' | 'derived';
  start?: number;
  end?: number;
  /** A clock of the world settings; empty means the ledger world's own clock. */
  clock?: string;
}

const TIME_CELLS = ['tl1.time.kind', 'tl1.time.start', 'tl1.time.end', 'tl1.clock'] as const;
const timeKey = (values: Cells) => JSON.stringify(TIME_CELLS.map((k) => values[k] ?? null));
const timeCells = (t: TimelineTimeInput): Cells => ({
  'tl1.time.kind': t.kind,
  'tl1.time.start': t.start,
  'tl1.time.end': t.end,
  'tl1.clock': t.clock,
});

/**
 * `timeline.set-time`: the event's time as given. Every time cell is replaced, so a value
 * that does not fit the kind (a point without its start, an end before the start…) is
 * refused by the reader instead of being kept from the old time.
 *
 * `expected` is the time the author saw when the change was prepared. If another edit changed
 * it meanwhile, the change is refused as stale (§2.7) instead of overwriting that edit.
 */
export function setTime(
  eventId: string,
  time: TimelineTimeInput,
  expected: TimelineTimeInput,
  expectedRelation?: TimelineRowInput,
): EditorCommand<StructuredData> {
  time = structuredClone(time);
  expected = structuredClone(expected);
  expectedRelation = structuredClone(expectedRelation);
  return timelineCommand('ledger', 'timeline.set-time', '時点を変更', (d) => {
    const row = d.rows.find((r) => r.id === eventId);
    if (!row || row.values['tl1.row'] !== 'event')
      throw new TimelineEditError(`出来事 ${eventId} がありません。`);
    if (timeKey(row.values as Cells) !== timeKey(timeCells(expected)))
      throw new TimelineEditError(
        `${eventId} の時点は準備した後に変わりました。読み直してから変更してください。`,
      );
    if (expected.kind === 'derived') {
      const old = d.rows.find(
        (r) => r.values['tl1.row'] === 'derive-time' && r.values['tl1.subject'] === eventId,
      );
      if (
        !expectedRelation ||
        canonicalJson(old ? { id: old.id, values: present(old.values as Cells) } : null) !==
          canonicalJson({ id: expectedRelation.id, values: present(expectedRelation.values) })
      )
        throw new TimelineEditError('導出の前提を確認してから通常の時点へ変更してください。');
    }
    // An absent value becomes an empty cell, so nothing of the old time is kept.
    row.values = present({ ...(row.values as Cells), ...timeCells(time) });
    if (time.kind !== 'derived')
      d.rows = d.rows.filter(
        (r) => !(r.values['tl1.row'] === 'derive-time' && r.values['tl1.subject'] === eventId),
      );
  });
}

/** One native edit switches both the event kind and its owner-local derivation row. */
export function setDerivation(
  eventId: string,
  relationId: string,
  baseId: string | VerifiedTimelineRows,
  anchor: 'start' | 'end',
  min: number,
  max: number,
  expected: TimelineTimeInput,
  expectedRelation: TimelineRowInput | undefined,
): EditorCommand<StructuredData> {
  const verified = typeof baseId === 'string' ? undefined : baseId;
  if (
    verified &&
    (!isVerifiedRows(verified) ||
      verified.rows.length !== 1 ||
      verified.rows[0].id !== relationId ||
      verified.rows[0].values['tl1.row'] !== 'derive-time' ||
      verified.rows[0].values['tl1.subject'] !== eventId)
  )
    throw new TimelineEditError('確かめた導出参照ではありません。');
  const reference = verified
    ? Object.fromEntries(
        Object.entries(verified.rows[0].values).filter(([k]) => k.startsWith('tl1.ref.')),
      )
    : { 'tl1.ref.item': baseId as string };
  const seen = structuredClone(expectedRelation);
  expected = structuredClone(expected);
  return timelineCommand('ledger', 'timeline.set-relation', '時点の導出を変更', (d) => {
    if (verified?.targets.some((id) => !verified.mayRead(id)))
      throw new TimelineEditError('導出元を読めなくなったため、この参照は書けません。');
    const event = d.rows.find((r) => r.id === eventId && r.values['tl1.row'] === 'event');
    const old = d.rows.find(
      (r) => r.values['tl1.row'] === 'derive-time' && r.values['tl1.subject'] === eventId,
    );
    if (
      !event ||
      timeKey(event.values as Cells) !== timeKey(timeCells(expected)) ||
      canonicalJson(old ? { id: old.id, values: present(old.values as Cells) } : null) !==
        canonicalJson(seen ? { id: seen.id, values: present(seen.values) } : null)
    )
      throw new TimelineEditError('導出の対象が準備した後に変わりました。再確認してください。');
    if (old && old.id !== relationId) throw new TimelineEditError('既存の導出IDは変更できません。');
    if (!old && d.rows.some((r) => r.id === relationId))
      throw new TimelineEditError('導出IDは既に使われています。');
    event.values = present({
      ...(event.values as Cells),
      ...timeCells({ kind: 'derived', clock: expected.clock }),
    });
    const next = {
      id: relationId,
      values: present({
        'tl1.row': 'derive-time',
        'tl1.subject': eventId,
        ...reference,
        'tl1.anchor': anchor,
        'tl1.offset.min': min,
        'tl1.offset.max': max,
      }),
    };
    if (old) d.rows[d.rows.indexOf(old)] = next;
    else d.rows.push(next);
  });
}

/** The row IDs a deleted item takes with it: rows it owns, and rows owned by those. */
function owned(d: StructuredData, root: string) {
  const gone = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of d.rows)
      if (!gone.has(r.id) && gone.has(r.values['tl1.subject'] as string)) {
        gone.add(r.id);
        grew = true;
      }
  }
  return gone;
}

/**
 * Deletes one item (an event of a ledger, an SC of scene cards) with the relation rows it
 * owns. Another row of the same owner that still depends on it through an internal reference
 * refuses the delete (TL34b); nothing is removed silently. Exact references from other owners
 * are not changed: they keep the saved version they cite (TL34a, TL34c).
 */
function deleteItem(
  role: TimelineRole,
  kind: 'event' | 'scene' | 'occurrence',
  type: string,
  id: string,
) {
  const what = { event: '出来事', scene: 'SC', occurrence: '提示位置' }[kind];
  return timelineCommand(role, type, `${what}を削除`, (d) => {
    const row = d.rows.find((r) => r.id === id);
    if (!row || row.values['tl1.row'] !== kind)
      throw new TimelineEditError(`${what} ${id} がありません。`);
    const gone = owned(d, id);
    const dependents = d.rows.filter(
      (r) =>
        !gone.has(r.id) &&
        (['tl1.ref', 'tl1.ref2'] as const).some(
          (p) => !r.values[`${p}.artifact`] && gone.has(r.values[`${p}.item`] as string),
        ),
    );
    if (dependents.length)
      throw new TimelineEditError(
        `${dependents.map((r) => r.id).join('、')} が ${id} に依存しているため削除できません。先に依存を外してください。`,
      );
    d.rows = d.rows.filter((r) => !gone.has(r.id));
  });
}
export const deleteEvent = (eventId: string) =>
  deleteItem('ledger', 'event', 'timeline.delete-event', eventId);
export const deleteScene = (sceneId: string) =>
  deleteItem('scene-cards', 'scene', 'timeline.delete-scene', sceneId);
/**
 * Deletes one occurrence of the composition. Other occurrences, the SC it placed and the
 * manuscript are not changed; a Host link that names its saved version keeps that version.
 */
export const deleteOccurrence = (occurrenceId: string) =>
  deleteItem('composition', 'occurrence', 'timeline.delete-occurrence', occurrenceId);

/** Cells that have their own command: identity, kind, owner, references and time. */
const OWN_COMMAND = /^tl1\.(row|subject|ref2?\.|time\.|clock$|order$)/;
const cellKey = (values: Cells, keys: string[]) =>
  JSON.stringify(keys.map((k) => values[k] ?? null));

/**
 * `timeline.set-cells`: plain cells of one row (a name, a part, a note), as given. Cells that
 * other commands own are refused here, so a reference or a time is never changed by a form
 * that did not check it. `expected` holds the same cells as the author saw them: a row
 * changed meanwhile is refused as stale (§2.7).
 */
export function setCells(
  role: TimelineRole,
  rowId: string,
  cells: Cells,
  expected: Cells,
  label = '項目を変更',
): EditorCommand<StructuredData> {
  const keys = Object.keys(cells);
  const own = keys.find((k) => OWN_COMMAND.test(k));
  if (own) throw new TimelineEditError(`${own} はこの操作では変えません。`);
  return timelineCommand(role, 'timeline.set-cells', label, (d) => {
    const row = d.rows.find((r) => r.id === rowId);
    if (!row) throw new TimelineEditError(`行 ${rowId} がありません。`);
    if (cellKey(row.values as Cells, keys) !== cellKey(expected, keys))
      throw new TimelineEditError(
        `${rowId} は準備した後に変わりました。読み直してから変更してください。`,
      );
    row.values = present({ ...(row.values as Cells), ...cells });
  });
}

function citeRow(d: StructuredData, citeId: string) {
  const row = d.rows.find((r) => r.id === citeId);
  if (!row || row.values['tl1.row'] !== 'cite')
    throw new TimelineEditError(`引用 ${citeId} がありません。`);
  return row;
}

/**
 * `timeline.set-ref`, removing: one citation of an SC. Nothing is put in its place: the SC
 * keeps its other citations and no other reference is moved to another ID (TL04).
 */
export const removeCitation = (citeId: string) =>
  timelineCommand('scene-cards', 'timeline.set-ref', '引用を外す', (d) => {
    citeRow(d, citeId);
    d.rows = d.rows.filter((r) => r.id !== citeId);
  });

/**
 * `timeline.set-ref`, retargeting: an existing citation now names another saved item. Only
 * confirmed rows are accepted (a missing new target is refused when it is confirmed, TL34d),
 * and the citation keeps its ID and its SC.
 */
export function retargetCitation(
  verified: VerifiedTimelineRows,
  expected?: Cells,
): EditorCommand<StructuredData> {
  if (!isVerifiedRows(verified) || verified.rows.length !== 1)
    throw new TimelineEditError(
      '確かめた一つの引用ではありません。参照先を確かめてから付け替えます。',
    );
  const next = verified.rows[0];
  return timelineCommand('scene-cards', 'timeline.set-ref', '引用を付け替える', (d) => {
    if (verified.targets.some((t) => !verified.mayRead(t)))
      throw new TimelineEditError('参照先を読めなくなったため、この参照は書けません。');
    const row = citeRow(d, next.id);
    if (
      expected &&
      cellKey(row.values as Cells, Object.keys(expected)) !==
        cellKey(expected, Object.keys(expected))
    )
      throw new TimelineEditError('引用は準備した後に変わりました。再確認してください。');
    if (
      next.values['tl1.row'] !== 'cite' ||
      next.values['tl1.subject'] !== row.values['tl1.subject']
    )
      throw new TimelineEditError(`${next.id} は同じSCの引用のまま付け替えます。`);
    row.values = present(next.values);
  });
}

export interface TimelinePlacement {
  order: number;
  /** The part's display name (a chapter, an episode). Not used for identity or order. */
  part?: string;
}
/**
 * `timeline.move-occurrence`: one occurrence to another place of the presentation order. Only
 * that row changes: event times, the other occurrences and the manuscript stay as they are
 * (TL02, TL03). An order another occurrence already has is refused, never renumbered.
 */
export function moveOccurrence(
  occurrenceId: string,
  to: TimelinePlacement,
  expected: TimelinePlacement,
): EditorCommand<StructuredData> {
  return timelineCommand('composition', 'timeline.move-occurrence', '提示位置を移動', (d) => {
    const row = d.rows.find((r) => r.id === occurrenceId);
    if (!row || row.values['tl1.row'] !== 'occurrence')
      throw new TimelineEditError(`提示位置 ${occurrenceId} がありません。`);
    const keys = ['tl1.order', 'tl1.part'];
    if (
      cellKey(row.values as Cells, keys) !==
      cellKey({ 'tl1.order': expected.order, 'tl1.part': expected.part }, keys)
    )
      throw new TimelineEditError(
        `${occurrenceId} の位置は準備した後に変わりました。読み直してから移動してください。`,
      );
    const taken = d.rows.find(
      (r) =>
        r.id !== occurrenceId &&
        r.values['tl1.row'] === 'occurrence' &&
        r.values['tl1.order'] === to.order,
    );
    if (taken)
      throw new TimelineEditError(`提示の並び ${to.order} は ${taken.id} が使っています。`);
    row.values = present({
      ...(row.values as Cells),
      'tl1.order': to.order,
      'tl1.part': to.part,
    });
  });
}

/**
 * The Data adapter for a tl1 owner opened for editing: native Data that also passes the tl1
 * reader. An owner that does not read cannot be opened for editing at all (writes disabled).
 */
export function timelineOwnerAdapter(role: TimelineRole): EditorHostAdapter<StructuredData> {
  return {
    kind: 'data',
    capabilities: { undo: true, nativeJson: true, formats: [], preview: 'none', shared: false },
    validate(value): value is StructuredData {
      return isStructuredData(value) && readTimelineTable(role, value).state !== 'invalid';
    },
  };
}
