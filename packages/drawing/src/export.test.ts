import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  drawingStarter,
  type DrawingBimDrawing,
  type DrawingDocument,
} from '@editor-platform/drawing-core';
import { EditorSession } from '@editor-platform/editor-core';
import { DrawingController, type DrawingIssueHost, type DrawingSourceChoice } from './controller';
import { drawingBimViewState, drawingDeriveKey } from './derive';
import { DrawingPdfError, drawingPdf } from './pdf';

// DW6 (docs/cad/drawing-editor.md, 出力). ST-713, TS-2444..2445.
const font = new Uint8Array(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../../apps/playground/public/office-fonts/NotoSansCJKjp-Regular.otf',
        import.meta.url,
      ),
    ),
  ),
);
const building: DrawingSourceChoice = {
  key: 'b',
  kind: 'bim',
  artifactId: 'b',
  versionId: 'v1',
  contentHash: 'hb',
  name: 'Tower',
  label: 'Tower · v1',
  views: [{ id: 'v-1f', name: '1F plan', kind: 'plan', scale: '1:100' }],
};
const drawn: DrawingBimDrawing = {
  items: [
    {
      type: 'polygon',
      loops: [
        [
          [0, 0],
          [20000, 0],
          [20000, 10000],
          [0, 10000],
        ],
      ],
      cls: 'cut cut-wall',
      id: 'w',
    },
    { type: 'text', at: [10000, 5000], text: '事務室 Office', anchor: 'middle', cls: 'room' },
  ],
  failed: [],
};
type Issued = Parameters<DrawingIssueHost['issue']>[0];
function setup(withFont = true, doc = drawingStarter(), issues?: DrawingIssueHost) {
  const session = new EditorSession<DrawingDocument>(doc);
  let open = () => {};
  const hold = new Promise<void>((r) => (open = r));
  const controller = new DrawingController({
    session,
    canEdit: () => true,
    sources: { choices: () => [building], prepare: async () => ({}) },
    derive: {
      key: (doc, v) => drawingDeriveKey(doc, v, 'hb'),
      async run(_, view) {
        await hold;
        if (view.kind !== 'bim-view') return { status: 'failed', code: 'view-kind' };
        if (view.bimViewId !== 'v-1f') return { status: 'failed', code: 'bim-view-missing' };
        return drawingBimViewState(view, drawn);
      },
    },
    ...(withFont ? { pdfFont: async () => font } : {}),
    ...(issues ? { issues } : {}),
  });
  return { session, controller, open };
}

describe('PDF and DXF export (DW6)', () => {
  it('writes every sheet once its views are drawn: a PDF page each, one DXF', async () => {
    const { controller, open } = setup();
    const placing = controller.addBimView(building, 'v-1f');
    open();
    expect(await placing).toBeUndefined();
    controller.addSheet('A4', 'portrait');
    // Opened again, its view being drawn: the export waits for it.
    const again = setup(true, controller.state.content);
    expect(again.controller.state.views.get(again.controller.state.content.views[0]!.id)).toEqual({
      status: 'pending',
    });
    let done = false;
    const pending = again.controller.exportPdf().finally(() => (done = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    again.open();
    const pdf = await pending;
    if (typeof pdf === 'string') throw new Error(pdf);
    const read = await PDFDocument.load(pdf);
    // A3 landscape, then A4 portrait, in points.
    const sizes = read.getPages().map((p) => p.getSize());
    expect(sizes.map((s) => [Math.round(s.width), Math.round(s.height)])).toEqual([
      [1191, 842],
      [595, 842],
    ]);
    expect(read.getTitle()).toBe(controller.state.content.name);
    const dxf = await again.controller.exportDxf();
    expect(dxf).toContain('AC1015');
    // The room's name, in both.
    expect(dxf).toContain('\\U+4E8B\\U+52D9\\U+5BA4 Office');
  });

  it('writes a page of many lines (Codex on #1244)', async () => {
    const points: number[] = [];
    for (let i = 0; i < 100_000; i++) points.push(i / 1000, 0, i / 1000, 1);
    const pdf = await drawingPdf(
      [{ name: 'S', paper: [420, 297], items: [{ type: 'segments', points, cls: 'thin' }] }],
      { font },
    );
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
  }, 60_000);

  it('refuses without the font, or a letter it has not', async () => {
    const none = setup(false);
    none.open();
    expect(await none.controller.exportPdf()).toBe('pdf-font-unavailable');
    expect(none.controller.state.notice?.code).toBe('pdf-font-unavailable');
    const broken = setup();
    broken.open();
    expect(await broken.controller.exportPdf()).not.toBeTypeOf('string');
    await expect(
      drawingPdf(
        [
          {
            name: 'S',
            paper: [210, 297],
            items: [{ type: 'text', at: [0, 0], text: 'A😀', heightMm: 3.5, anchor: 'start' }],
          },
        ],
        { font },
      ),
    ).rejects.toMatchObject({
      code: 'pdf-font-missing',
      chars: ['😀'],
    } satisfies Partial<DrawingPdfError>);
  });
});

describe('issuing sheets (DW6b)', () => {
  it('gives each sheet its next revision, has the Host keep the version and its PDF', async () => {
    const kept: Issued[] = [];
    let refuse: string | undefined;
    const host: DrawingIssueHost = {
      list: () => [],
      pdf: () => undefined,
      issue: async (r) => (refuse ? refuse : (kept.push(r), undefined)),
    };
    const { controller, session, open } = setup(true, drawingStarter(), host);
    open();
    expect(await controller.addBimView(building, 'v-1f')).toBeUndefined();
    controller.addSheet('A4', 'portrait');
    const ids = session.content.sheets.map((s) => s.id);
    const rev = { description: '施工用 For construction', date: '2026-11-14', by: 'Ryo' };
    // The Host cannot save: nothing changes.
    refuse = 'issue-not-saved';
    expect(await controller.issueSheets(ids, rev)).toBe('issue-not-saved');
    expect(session.content.sheets.every((s) => !s.revisions.length)).toBe(true);
    refuse = undefined;
    expect(await controller.issueSheets(ids, rev)).toBeUndefined();
    expect(session.content.sheets.map((s) => s.revisions.map((r) => r.mark))).toEqual([
      ['A'],
      ['A'],
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.sheets.map((s) => s.mark)).toEqual(['A', 'A']);
    expect(kept[0]!.reason).toBe('発行 Issue Sheet 1 A, Sheet 2 A');
    // What the Host saved is what the draft is now.
    expect(kept[0]!.content).toEqual(session.content);
    expect((await PDFDocument.load(kept[0]!.pdf)).getPageCount()).toBe(2);
    // Again: B, on the one sheet issued.
    expect(await controller.issueSheets([ids[0]!], rev)).toBeUndefined();
    expect(session.content.sheets.map((s) => s.revisions.map((r) => r.mark))).toEqual([
      ['A', 'B'],
      ['A'],
    ]);
    expect((await PDFDocument.load(kept[1]!.pdf)).getPageCount()).toBe(1);
    // A bad date is refused before anything is saved.
    expect(await controller.issueSheets(ids, { ...rev, date: '2026-02-30' })).toBe('date');
    expect(kept).toHaveLength(2);
  }, 60_000);

  it('signs each sheet by its own author, and keeps edits made while the Host saves', async () => {
    const kept: Issued[] = [];
    const hook: { during?: () => void } = {};
    const host: DrawingIssueHost = {
      list: () => [],
      pdf: () => undefined,
      issue: async (r) => {
        hook.during?.();
        kept.push(r);
        return undefined;
      },
    };
    const { controller, session, open } = setup(true, drawingStarter(), host);
    open();
    controller.addSheet('A4', 'portrait');
    const [a, b] = session.content.sheets.map((s) => s.id);
    controller.showSheet(a!);
    controller.updateSheet({ title: { ...controller.sheet.title, drawnBy: 'Ryo' } });
    controller.showSheet(b!);
    controller.updateSheet({ title: { ...controller.sheet.title, drawnBy: 'Aoi' } });
    // An edit while the version is being saved stays, with the revisions on it.
    hook.during = () => void controller.updateSheet({ name: '詳細図' });
    const rev = { description: '施工用', date: '2026-11-14' };
    expect(await controller.issueSheets([a!, b!], rev)).toBeUndefined();
    expect(session.content.sheets.map((s) => s.revisions.map((r) => r.by))).toEqual([
      ['Ryo'],
      ['Aoi'],
    ]);
    expect(session.content.sheets[1]!.name).toBe('詳細図');
    expect(kept[0]!.content.sheets[1]!.revisions[0]!.by).toBe('Aoi');
  }, 60_000);

  it('holds revisions and sheet deletion while the Host saves an issue', async () => {
    const hook: { during?: () => void } = {};
    const host: DrawingIssueHost = {
      list: () => [],
      pdf: () => undefined,
      issue: async () => {
        hook.during?.();
        return undefined;
      },
    };
    const { controller, session, open } = setup(true, drawingStarter(), host);
    open();
    controller.addSheet('A4', 'portrait');
    const [a, b] = session.content.sheets.map((s) => s.id);
    // Revisions and deleting a sheet wait for the issue.
    const refused: (string | undefined)[] = [];
    hook.during = () => {
      controller.showSheet(b!);
      refused.push(controller.deleteSheet(), controller.addRevision('手で', '2026-11-14', 'Ryo'));
    };
    const rev = { description: '施工用', date: '2026-11-14' };
    expect(await controller.issueSheets([a!, b!], rev)).toBeUndefined();
    expect(refused).toEqual(['issue-busy', 'issue-busy']);
    expect(session.content.sheets.map((s) => s.revisions.map((r) => r.description))).toEqual([
      ['施工用'],
      ['施工用'],
    ]);
  }, 60_000);

  it('refuses a sheet whose view is not drawn, and without a Host or edit access', async () => {
    const host: DrawingIssueHost = {
      list: () => [],
      pdf: () => undefined,
      issue: async () => undefined,
    };
    const { controller, session, open } = setup(true, drawingStarter(), host);
    open();
    expect(await controller.addBimView(building, 'v-1f')).toBeUndefined();
    const placed = session.content.views[0]!;
    if (placed.kind !== 'bim-view') throw new Error('kind');
    controller.updateView({ ...placed, bimViewId: 'v-gone' });
    const sheet = session.content.sheets[0]!.id;
    const rev = { description: 'x', date: '2026-11-14', by: '' };
    expect(await controller.issueSheets([sheet], rev)).toBe('issue-view-failed');
    expect(controller.state.notice?.path).toBe('Sheet 1: 1F plan');
    expect(await controller.issueSheets([], rev)).toBe('issue-none');
    const none = setup(true, drawingStarter());
    none.open();
    expect(await none.controller.issueSheets([sheet], rev)).toBe('issue-unavailable');
  });
});
