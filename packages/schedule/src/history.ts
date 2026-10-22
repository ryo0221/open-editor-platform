import type { EditorSession } from '@editor-platform/editor-core';
import type { ScheduleDocument } from './model';

/** Refusal for Undo or Redo that would remove an event while details hold unsaved text. */
export const historyDropsDetailsText =
  'Not changed: this would remove an event while the details still hold text that was not saved. Fix or clear that text first.';

/** Pending text in the open details, as EditorInputs reports it. */
export interface PendingInputs {
  dirty: number;
  composing: number;
}

/** True when history removed an event while open details hold refused or composing text. The
 * text may belong to that event, and unmounting its details would lose it. It does not rely on
 * the Host's selection, which can differ from the event whose details are open. */
export function historyDropsDetails(
  before: ScheduleDocument,
  after: ScheduleDocument,
  pending: PendingInputs,
): boolean {
  if (!pending.dirty && !pending.composing) return false;
  const kept = new Set(after.events.map((e) => e.id));
  return before.events.some((e) => !kept.has(e.id));
}

/** One Undo or Redo step for a Host. A step that would drop the open details is refused before
 * the history moves; the result is the session's frozen view, or the reason it did not move. */
export function stepScheduleHistory(
  session: EditorSession<ScheduleDocument>,
  direction: 'undo' | 'redo',
  before: ScheduleDocument,
  pending: PendingInputs,
): { content: ScheduleDocument } | { refused: string } {
  let refused = false;
  try {
    const content = session[direction === 'undo' ? 'undoView' : 'redoView']((candidate) => {
      refused = historyDropsDetails(before, candidate, pending);
      if (refused) throw new Error(historyDropsDetailsText);
    });
    return { content };
  } catch (e) {
    if (refused) return { refused: historyDropsDetailsText };
    throw e;
  }
}
