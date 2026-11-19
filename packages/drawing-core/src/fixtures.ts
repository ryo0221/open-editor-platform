import type { DrawingDocument } from './model';
import { drawingStarter, emptyTitleBlock } from './operations';

/**
 * F136 (docs/cad/drawing-editor.md): the smallest drawing set, written for this project. Two
 * sheets (A3 landscape with a filled title block and two revisions; A4 portrait with a filing
 * margin) and a two-line note. No views: it checks the sheet itself.
 */
export function f136DrawingSheets(): DrawingDocument {
  const doc = drawingStarter('F136 図面の最小の例');
  doc.sheets[0] = {
    ...doc.sheets[0]!,
    name: '地板',
    title: {
      ...emptyTitleBlock('地板（部品図）'),
      drawingNumber: 'SK01-101',
      organization: 'Editor Platform',
      project: 'SK-01 スケルトン時計',
      material: 'C3604（真鍮）',
      quantity: '1',
      drawnBy: 'Claude',
      checkedBy: 'Ryo',
      date: '2026-11-14',
    },
    revisions: [
      { id: 'rev-a', mark: 'A', date: '2026-11-14', description: '初版', by: 'Claude' },
      { id: 'rev-b', mark: 'B', date: '2026-11-15', description: '穴の位置を修正', by: 'Claude' },
    ],
  };
  doc.sheets.push({
    id: 'sheet-2',
    name: '注記',
    size: 'A4',
    orientation: 'portrait',
    filing: true,
    title: emptyTitleBlock('注記'),
    revisions: [],
  });
  doc.annotations.push({
    id: 'note-1',
    sheetId: 'sheet-1',
    kind: 'note',
    at: [30, 60],
    text: '注記\n1. 指示なき角はC0.2とする。',
    heightMm: 3.5,
  });
  return doc;
}
