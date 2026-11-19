import { describe, expect, it } from 'vitest';
import {
  addDrawingRevision,
  addDrawingSheet,
  addDrawingView,
  deleteDrawingItems,
  drawingContentHash,
  drawingEditorCommand,
  drawingScaleFactor,
  drawingSheetLayout,
  drawingSheetPaper,
  drawingSheetPrint,
  drawingSheetScales,
  drawingSheetSvg,
  drawingViewItems,
  type DrawingItem,
  drawingStarter,
  f136DrawingSheets,
  freshDrawingId,
  moveDrawingItems,
  newDrawingSheet,
  nextRevisionMark,
  useDrawingSource,
  validateDrawing,
  type DrawingCadView,
  type DrawingDocument,
  type DrawingNote,
} from './index';

// DW1 (docs/cad/drawing-editor.md). ST-700, TS-2400.
const codes = (doc: unknown) => validateDrawing(doc).map((d) => `${d.code}@${d.path}`);
const source = {
  id: 'src-1',
  kind: 'cad' as const,
  artifactId: 'cad-1',
  versionId: 'v1',
  contentHash: 'abc',
  name: '地板',
};
const view = (over: Partial<DrawingCadView> = {}): DrawingCadView => ({
  id: 'view-1',
  kind: 'cad-projection',
  sheetId: 'sheet-1',
  sourceId: 'src-1',
  name: '正面図',
  at: [120, 150],
  scale: '2:1',
  label: true,
  direction: 'front',
  only: [],
  hiddenLines: true,
  centerLines: true,
  ...over,
});
const withView = (over: Partial<DrawingCadView> = {}) =>
  addDrawingView(useDrawingSource(drawingStarter(), source).doc, view(over));

describe('drawing content (DW1)', () => {
  it('admits the starter and F136', () => {
    expect(codes(drawingStarter())).toEqual([]);
    expect(codes(f136DrawingSheets())).toEqual([]);
    expect(codes(withView())).toEqual([]);
  });

  it('refuses unknown keys, schemas, enums and broken references by path', () => {
    const doc = withView() as unknown as Record<string, unknown> & DrawingDocument;
    expect(codes({ ...doc, extra: 1 })).toEqual(['shape@$.extra']);
    expect(codes({ ...doc, schemaVersion: 2 })).toEqual(['schema-version@$.schemaVersion']);
    // Codex on #1203: a drawing without sheets could not be opened.
    expect(codes({ ...drawingStarter(), sheets: [] })).toEqual(['sheet-last@$.sheets']);
    const bad = structuredClone(doc);
    bad.sheets[0]!.size = 'B4' as never;
    bad.views[0]!.scale = '1:3' as never;
    bad.views[0]!.sourceId = 'nope';
    bad.sheets[0]!.title.date = '2026-02-30';
    expect(codes(bad)).toEqual([
      'sheet-size@$.sheets[0].size',
      'date@$.sheets[0].title.date',
      'source-missing@$.views[0].sourceId',
      'scale@$.views[0].scale',
    ]);
  });

  it('refuses duplicate IDs across collections and duplicate revision marks', () => {
    const doc = f136DrawingSheets();
    doc.annotations[0]!.id = 'sheet-2';
    doc.sheets[0]!.revisions[1]!.mark = 'A';
    expect(codes(doc)).toEqual([
      'revision-duplicate@$.sheets[0].revisions[1].mark',
      'id-duplicate@$.annotations[0].id',
    ]);
  });

  it('refuses a BIM source under a CAD view, control characters and non-JSON values', () => {
    const doc = withView();
    doc.sources[0]!.kind = 'bim';
    expect(codes(doc)).toEqual(['source-kind@$.views[0].sourceId']);
    const note = f136DrawingSheets();
    (note.annotations[0] as DrawingNote).text = 'a\u0007b';
    expect(codes(note)).toEqual(['shape@$.annotations[0].text']);
    (note.annotations[0] as DrawingNote).text = 'two\nlines';
    expect(codes(note)).toEqual([]);
    expect(codes({ ...note, name: Number.NaN })).toEqual(['number@$.name']);
  });
});

describe('drawing edits (DW1)', () => {
  it('reuses a source for the same exact version and adds another for a new one', () => {
    const a = useDrawingSource(drawingStarter(), source);
    expect(useDrawingSource(a.doc, { ...source, id: 'src-2' })).toEqual({
      doc: a.doc,
      sourceId: 'src-1',
    });
    const b = useDrawingSource(a.doc, { ...source, id: 'src-2', versionId: 'v2' });
    expect(b.sourceId).toBe('src-2');
    expect(b.doc.sources).toHaveLength(2);
  });

  it('moves views and notes together, and deleting a sheet takes its views and sources', () => {
    let doc = addDrawingSheet(withView(), newDrawingSheet('sheet-2', 'Sheet 2', 'A4'));
    doc = addDrawingView(doc, view({ id: 'view-2', sheetId: 'sheet-2' }));
    const moved = moveDrawingItems(doc, ['view-1', 'view-2'], [10, -5]);
    expect(moved.views.map((v) => v.at)).toEqual([
      [130, 145],
      [130, 145],
    ]);
    const one = deleteDrawingItems(moved, ['sheet-1']);
    expect(one.views.map((v) => v.id)).toEqual(['view-2']);
    expect(one.sources).toHaveLength(1);
    expect(deleteDrawingItems(one, ['view-2']).sources).toEqual([]);
    expect(() => deleteDrawingItems(one, ['sheet-2'])).toThrow('sheet-last');
    expect(() => moveDrawingItems(one, ['x'], [1, 1])).toThrow('item-missing');
  });

  it('numbers revisions and fresh IDs', () => {
    const doc = f136DrawingSheets();
    expect(nextRevisionMark(doc.sheets[0]!)).toBe('C');
    expect(nextRevisionMark(doc.sheets[1]!)).toBe('A');
    expect(nextRevisionMark({ revisions: [{ mark: '9' } as never] })).toBe('10');
    // After Z the mark counts on in letters, never growing per revision (Codex on #1278).
    const after = (mark: string) => nextRevisionMark({ revisions: [{ mark } as never] });
    expect([after('Z'), after('AZ'), after('ZZ'), after('B2')]).toEqual(['AA', 'BA', 'AAA', 'B3']);
    let sheet = { revisions: [] as { mark: string }[] };
    for (let i = 0; i < 50; i++)
      sheet = { revisions: [...sheet.revisions, { mark: nextRevisionMark(sheet as never) }] };
    expect(sheet.revisions.at(-1)!.mark).toBe('AX');
    const next = addDrawingRevision(doc, 'sheet-2', {
      id: freshDrawingId(doc, 'rev'),
      mark: 'A',
      date: '2026-11-14',
      description: '初版',
      by: '',
    });
    expect(next.sheets[1]!.revisions[0]!.id).toBe('rev-1');
    expect(() =>
      addDrawingRevision(next, 'sheet-2', { ...next.sheets[1]!.revisions[0]!, id: 'rev-2' }),
    ).toThrow('revision-duplicate');
  });

  it('commits through one command that re-checks base and authority', () => {
    const base = drawingStarter();
    const next = addDrawingSheet(base, newDrawingSheet('sheet-2', 'Sheet 2'));
    let allowed = true;
    const cmd = drawingEditorCommand('Add sheet', next, {
      expectedHash: drawingContentHash(base),
      canEdit: () => allowed,
    });
    expect(cmd.apply(base).sheets).toHaveLength(2);
    expect(() => cmd.apply(next)).toThrow('drawing-base-mismatch');
    allowed = false;
    expect(() => cmd.apply(base)).toThrow('permission-denied');
  });
});

describe('sheets (DW1)', () => {
  it('lays out JIS Z 8311 frames, filing margins and the title block', () => {
    const a3 = newDrawingSheet('s', 'S');
    expect(drawingSheetPaper(a3)).toEqual([420, 297]);
    expect(drawingSheetLayout(a3).frame).toEqual({ x: 10, y: 10, width: 400, height: 277 });
    expect(drawingSheetLayout({ ...a3, size: 'A1' }).frame.x).toBe(20);
    const a4 = { ...a3, size: 'A4' as const, orientation: 'portrait' as const, filing: true };
    expect(drawingSheetPaper(a4)).toEqual([210, 297]);
    const l = drawingSheetLayout(a4);
    expect(l.frame).toEqual({ x: 20, y: 10, width: 180, height: 277 });
    expect(l.title).toEqual({ x: 30, y: 10, width: 170, height: 44 });
    expect(l.zones.every((n) => n % 2 === 0)).toBe(true);
  });

  it('writes the sheet SVG with title block values, revisions, notes and placeholders', () => {
    const doc = addDrawingView(useDrawingSource(f136DrawingSheets(), source).doc, view());
    const svg = drawingSheetSvg(doc, doc.sheets[0]!);
    expect(svg).toContain('width="420mm" height="297mm" viewBox="0 0 420 297"');
    for (const t of [
      '地板（部品図）',
      'SK01-101',
      'C3604（真鍮）',
      '穴の位置を修正',
      '1. 指示なき角はC0.2とする。',
    ])
      expect(svg).toContain(t);
    expect(svg).toContain('data-id="scale">2:1</text>');
    expect(svg).toContain('正面図  2:1');
    expect(svg).toContain('計算中…');
    expect(svg).toContain('stroke-dasharray:3 1');
    expect(
      drawingSheetSvg(
        doc,
        doc.sheets[0]!,
        new Map([['view-1', { status: 'failed', code: 'source-missing' }]]),
      ),
    ).toContain('表示できません：source-missing');
  });

  it('lists a sheet’s scales, the largest first', () => {
    let doc = withView();
    doc = addDrawingView(doc, view({ id: 'view-2', scale: '5:1' }));
    doc = addDrawingView(doc, view({ id: 'view-3', scale: '2:1' }));
    expect(drawingSheetScales(doc, 'sheet-1')).toBe('5:1, 2:1');
    expect(drawingScaleFactor('1:200')).toBe(0.005);
  });
});

describe('a large projection on the paper (Codex on #1278, ST-721, TS-2459)', () => {
  it('lists more items than a call takes arguments without throwing', () => {
    const items: DrawingItem[] = Array.from({ length: 250_000 }, (_, i) => ({
      type: 'line',
      a: [i % 100, 0],
      b: [i % 100, 1],
      cls: 'thick',
    }));
    const state = {
      status: 'ready' as const,
      graphics: {
        items,
        bounds: [
          [0, 0],
          [100, 1],
        ],
      },
    };
    const doc = withView();
    const v = doc.views[0]!;
    expect(drawingViewItems(v, state as never).length).toBeGreaterThan(250_000);
    const sheet = doc.sheets.find((s) => s.id === v.sheetId)!;
    expect(drawingSheetPrint(doc, sheet, new Map([[v.id, state as never]])).length).toBeGreaterThan(
      250_000,
    );
  });
});
