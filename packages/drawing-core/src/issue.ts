import { drawingAnnotationGraphics } from './dimensions';
import type { DrawingDocument } from './model';
import type { DrawingViewState } from './svg';

/**
 * DW6b (docs/cad/drawing-editor.md, 発行): what keeps a sheet from being issued. An issued sheet
 * is fixed for the people who build or make from it, so it is refused while anything on it is
 * not what its source says:
 *
 * - `issue-pmi-expired`: an imported PMI item is gone or no longer valid (失効・要確認);
 * - `issue-pmi-updated`: an imported PMI item changed and the change is not confirmed yet;
 * - `issue-refs`: a dimension, leader or symbol whose edge is unresolved or ambiguous, or a
 *   tolerance frame naming a datum the drawing has none of;
 * - `issue-view-failed`: a view that could not be drawn (or is still being drawn);
 * - `issue-pending`: an annotation not resolved yet (its view's PMI not read), which would print
 *   as nothing (Codex on #1246);
 * - `issue-unprintable`: an angle between edges that are parallel in the view, which also prints
 *   as nothing (Codex on #1246).
 */
export type DrawingIssueBlockerCode =
  | 'issue-pending'
  | 'issue-pmi-expired'
  | 'issue-pmi-updated'
  | 'issue-refs'
  | 'issue-unprintable'
  | 'issue-view-failed';

export interface DrawingIssueBlocker {
  sheetId: string;
  code: DrawingIssueBlockerCode;
  /** The view or annotation. */
  id: string;
}

/** Every blocker on the sheets, sheet by sheet: views first, then annotations. */
export function drawingIssueBlockers(
  doc: DrawingDocument,
  views: ReadonlyMap<string, DrawingViewState>,
  sheetIds: readonly string[],
): DrawingIssueBlocker[] {
  const out: DrawingIssueBlocker[] = [];
  for (const sheetId of sheetIds) {
    for (const v of doc.views)
      if (v.sheetId === sheetId && views.get(v.id)?.status !== 'ready')
        out.push({ sheetId, code: 'issue-view-failed', id: v.id });
    for (const a of doc.annotations) {
      if (a.sheetId !== sheetId || a.kind === 'note') continue;
      const { status } = drawingAnnotationGraphics(doc, a, views);
      const code: DrawingIssueBlockerCode | undefined =
        status === 'expired'
          ? 'issue-pmi-expired'
          : status === 'updated'
            ? 'issue-pmi-updated'
            : status === 'unresolved' || status === 'ambiguous' || status === 'datum-missing'
              ? 'issue-refs'
              : status === 'pending'
                ? 'issue-pending'
                : status === 'parallel'
                  ? 'issue-unprintable'
                  : undefined;
      if (code) out.push({ sheetId, code, id: a.id });
    }
  }
  return out;
}
