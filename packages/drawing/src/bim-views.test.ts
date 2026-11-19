import { describe, expect, it } from 'vitest';
import {
  drawingSheetLayout,
  drawingStarter,
  type DrawingBimDrawing,
  type DrawingDocument,
} from '@editor-platform/drawing-core';
import { EditorSession } from '@editor-platform/editor-core';
import { DrawingController, type DrawingSourceChoice } from './controller';
import { drawingBimViewState, drawingDeriveKey } from './derive';

// DW5a (docs/cad/drawing-editor.md, 施工図): a building version's plan placed on a sheet, drawn
// by the Host and put where it fits. ST-710, TS-2431.

const building: DrawingSourceChoice = {
  key: 'b/v1',
  kind: 'bim',
  artifactId: 'b',
  versionId: 'v1',
  contentHash: 'hb',
  name: 'Tower',
  label: 'Tower · v1',
  views: [
    { id: 'v-1f', name: '1F plan', kind: 'plan', scale: '1:100' },
    { id: 'v-gone', name: 'Old', kind: 'section', scale: '1:200' },
  ],
  levels: [
    { id: 'l-deck', name: 'Deck 340' },
    { id: 'l-long', name: 'Long' },
    { id: 'l-short', name: 'Short' },
  ],
  grids: [{ id: 'g-t1', label: 'T1' }],
};
/** A 120 m wide, 600 m tall tower frame, drawn at any scale (DW5b). */
const tower: DrawingBimDrawing = {
  items: [
    { type: 'line', a: [0, 0], b: [60000, 600000], cls: 'member', id: 'leg-1' },
    { type: 'line', a: [120000, 0], b: [60000, 600000], cls: 'member', id: 'leg-2' },
  ],
  failed: [],
  members: [{ mark: 'P1', kind: '部材', section: 'φ2300×100', count: 2, lengthMm: 1212436 }],
};
/** A 20 × 10 m plan: 200 × 100 mm on paper at 1:100. */
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
  ],
  failed: [],
};
/** A 27 m run with a 170-character name after it: its text stays 255 mm long on paper. */
const labelled: DrawingBimDrawing = {
  items: [
    { type: 'line', a: [0, 0], b: [27000, 0], cls: 'member', id: 'b' },
    { type: 'text', at: [27000, 0], text: 'X'.repeat(170), anchor: 'start', cls: 'member-mark' },
  ],
  failed: [],
};
/** A 5 m run with the same name: 1:50 holds it, though its 1:100 box doubled would not. */
const labelledShort: DrawingBimDrawing = {
  ...labelled,
  items: [
    { type: 'line', a: [0, 0], b: [5000, 0], cls: 'member', id: 'b' },
    { type: 'text', at: [5000, 0], text: 'X'.repeat(170), anchor: 'start', cls: 'member-mark' },
  ],
};
const settled = () => new Promise((r) => setTimeout(r, 0));
function setup(readOnly = false, hold?: Promise<unknown>) {
  const session = new EditorSession<DrawingDocument>(drawingStarter());
  const kept: string[] = [];
  const controller = new DrawingController({
    session,
    canEdit: () => !readOnly,
    sources: {
      choices: () => [building],
      prepare: async (c) => {
        kept.push(c.contentHash);
        return {};
      },
    },
    derive: {
      key: (doc, v) => drawingDeriveKey(doc, v, 'hb'),
      async run(_, view) {
        await hold;
        if (view.kind === 'bim-frame' || view.kind === 'bim-elevation')
          return drawingBimViewState(view, tower);
        if (view.kind === 'bim-framing' && view.levelId === 'l-long')
          return drawingBimViewState(view, labelled);
        if (view.kind === 'bim-framing' && view.levelId === 'l-short')
          return drawingBimViewState(view, labelledShort);
        if (view.kind === 'bim-framing') return drawingBimViewState(view, drawn);
        if (view.kind !== 'bim-view') return { status: 'failed', code: 'view-kind' };
        if (view.bimViewId === 'v-gone') return { status: 'failed', code: 'bim-view-missing' };
        return drawingBimViewState(view, drawn);
      },
    },
  });
  return { session, controller, kept };
}

describe('building views (DW5a)', () => {
  it('keeps the version, then places the plan clear of the title block, as one edit', async () => {
    const { session, controller, kept } = setup();
    expect(await controller.addBimView(building, 'v-1f')).toBeUndefined();
    expect(kept).toEqual(['hb']);
    const doc = session.content;
    expect(doc.sources).toMatchObject([{ kind: 'bim', contentHash: 'hb', name: 'Tower' }]);
    const view = doc.views[0]!;
    expect(view).toMatchObject({ kind: 'bim-view', bimViewId: 'v-1f', scale: '1:100' });
    expect(controller.state.selection).toEqual([view.id]);
    await settled();
    const st = controller.state.views.get(view.id);
    if (st?.status !== 'ready') throw new Error('not drawn');
    const [[x0, y0], [x1, y1]] = st.graphics.bounds;
    expect([x1 - x0, y1 - y0]).toEqual([200, 100]);
    const layout = drawingSheetLayout(doc.sheets[0]!);
    const t = layout.title;
    const f = layout.frame;
    expect(x0).toBeGreaterThanOrEqual(f.x);
    expect(x1).toBeLessThanOrEqual(f.x + f.width);
    expect(y0).toBeGreaterThanOrEqual(f.y);
    // Clear of the title block.
    expect(x1 <= t.x || x0 >= t.x + t.width || y0 >= t.y + t.height || y1 <= t.y).toBe(true);
    // At another scale; Undo takes it back.
    expect(await controller.addBimView(building, 'v-1f', '1:200')).toBeUndefined();
    expect(session.content.views[1]!.scale).toBe('1:200');
    // The second view is of the same kept version.
    expect(session.content.sources).toHaveLength(1);
    session.undo();
    controller.sync();
    expect(controller.state.content.views).toHaveLength(1);
  });

  it('refuses what it cannot place', async () => {
    const { controller, session } = setup();
    expect(await controller.addBimView(building, 'v-none')).toBe('bim-view-missing');
    // A view the version no longer draws: the reason, and nothing changed.
    expect(await controller.addBimView(building, 'v-gone')).toBe('bim-view-missing');
    expect(await controller.addBimView({ ...building, kind: 'cad' }, 'v-1f')).toBe('source-kind');
    expect(await controller.addCadViews(building, 'three', 'fit')).toBe('source-kind');
    expect(session.content.views).toEqual([]);
    // The sheet deleted while the building was drawn: refused, nothing placed.
    let open = () => {};
    const held = setup(false, new Promise<void>((r) => (open = r)));
    held.controller.addSheet('A3', 'landscape');
    const placing = held.controller.addBimView(building, 'v-1f');
    await settled();
    // While it is drawn the sheet says so, where it goes (ST-721, TS-2459).
    expect(held.controller.state.placing?.map((p) => [p.name, p.sheetId])).toEqual([
      [expect.any(String), held.controller.state.sheetId],
    ]);
    held.controller.deleteSheet();
    open();
    expect(await placing).toBe('sheet-missing');
    expect(held.controller.state.placing).toBeUndefined();
    expect(held.session.content.views).toEqual([]);
    // Two buildings placed at once: each source its own ID (Codex on #1237).
    let go = () => {};
    const both = setup(false, new Promise<void>((r) => (go = r)));
    const other = { ...building, artifactId: 'b-2', contentHash: 'hb2', name: 'Annex' };
    const first = both.controller.addBimView(building, 'v-1f');
    const second = both.controller.addBimView(other, 'v-1f');
    await settled();
    go();
    expect(both.controller.state.placing).toHaveLength(2);
    expect([await first, await second]).toEqual([undefined, undefined]);
    expect(both.controller.state.placing).toBeUndefined();
    const ids = both.session.content.sources.map((x) => x.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(both.session.content.views.map((v) => v.sourceId).sort()).toEqual([...ids].sort());
    // A building view's name over the drawing's text limit is cut to it (Codex on #1237).
    const long = { ...building, views: [{ ...building.views![0]!, name: '階'.repeat(255) }] };
    const named = setup();
    expect(await named.controller.addBimView(long, 'v-1f')).toBeUndefined();
    expect([...named.session.content.views[0]!.name]).toHaveLength(200);
    const ro = setup(true);
    expect(await ro.controller.addBimView(building, 'v-1f')).toBe('permission-denied');
    expect(ro.kept).toEqual([]);
  });

  // DW5b (ST-711, TS-2437): elevations, framing plans and frames, named, at the scale that fits.
  it('places a framing plan, an elevation and a frame, fitting the sheet', async () => {
    const { session, controller } = setup();
    expect(
      await controller.addBuildingView(building, { kind: 'bim-framing', levelId: 'l-deck' }),
    ).toBeUndefined();
    // The 20 × 10 m floor fits an A3 sheet at 1:100 at most (1:50 would be 400 mm wide).
    expect(session.content.views[0]).toMatchObject({
      kind: 'bim-framing',
      name: 'Deck 340 伏図',
      scale: '1:100',
    });
    // The 600 m tower: only 1:1000 holds it, and then at 600 mm still over the sheet's height.
    expect(
      await controller.addBuildingView(building, { kind: 'bim-frame', gridId: 'g-t1', bandMm: 0 }),
    ).toBeUndefined();
    expect(session.content.views[1]).toMatchObject({
      kind: 'bim-frame',
      name: 'T1 通り軸組図',
      scale: '1:1000',
      bandMm: 0,
    });
    // An asked scale is kept.
    expect(
      await controller.addBuildingView(building, { kind: 'bim-elevation', side: 'right' }, '1:500'),
    ).toBeUndefined();
    expect(session.content.views[2]).toMatchObject({ name: '右側立面図', scale: '1:500' });
    // A level or an axis the version does not have.
    expect(
      await controller.addBuildingView(building, { kind: 'bim-framing', levelId: 'l-x' }),
    ).toBe('bim-level-missing');
    expect(
      await controller.addBuildingView(building, { kind: 'bim-frame', gridId: 'g-x', bandMm: 0 }),
    ).toBe('bim-grid-missing');
    expect(session.content.views).toHaveLength(3);
    // Text keeps its paper size: 1:200 by proportion is still too wide, 1:500 holds it
    // (Codex on #1238).
    expect(
      await controller.addBuildingView(building, { kind: 'bim-framing', levelId: 'l-long' }),
    ).toBeUndefined();
    expect(session.content.views[3]).toMatchObject({ scale: '1:500' });
    // And larger ones are drawn to check: 1:50 fits (Codex on #1238).
    expect(
      await controller.addBuildingView(building, { kind: 'bim-framing', levelId: 'l-short' }),
    ).toBeUndefined();
    expect(session.content.views.at(-1)).toMatchObject({ scale: '1:50' });
    // A level's name as long as the building allows: cut to the drawing's (Codex on #1238).
    const long = { ...building, levels: [{ id: 'l-deck', name: 'L'.repeat(255) }] };
    expect(
      await controller.addBuildingView(long, { kind: 'bim-framing', levelId: 'l-deck' }),
    ).toBeUndefined();
    const named = [...session.content.views.at(-1)!.name];
    expect(named).toHaveLength(200);
    expect(named.slice(-3).join('')).toBe(' 伏図');
  });

  // DW5c (ST-712, TS-2441): a building view's list is its member list.
  it('places a building view’s member list on the title block', async () => {
    const { session, controller } = setup();
    await controller.addBuildingView(building, { kind: 'bim-frame', gridId: 'g-t1', bandMm: 0 });
    // A plan of a version with no members has none to list.
    await controller.addBimView(building, 'v-1f');
    await settled();
    const [frame, plan] = session.content.views;
    expect(controller.addPartsList(plan!.id)).toBe('member-none');
    expect(controller.addPartsList(frame!.id)).toBeUndefined();
    const list = session.content.annotations[0]!;
    expect(list).toMatchObject({ kind: 'parts-list', viewId: frame!.id });
    const g = controller.annotationGraphics(list);
    const texts = g.items.flatMap((i) => (i.type === 'text' ? [i.text] : []));
    expect(texts).toEqual([
      '符号',
      '種別',
      '断面',
      '本数',
      '長さ計 (m)',
      'P1',
      '部材',
      'φ2300×100',
      '2',
      '1212.436',
    ]);
  });

  // DW8 (ST-719, TS-2457): a list that would stand in a view goes to a free spot of the frame.
  it('moves a parts list off a view that stands over the title block', async () => {
    const { session, controller } = setup();
    await controller.addBuildingView(building, { kind: 'bim-frame', gridId: 'g-t1', bandMm: 0 });
    await settled();
    const frame = session.content.views[0]!;
    const layout = drawingSheetLayout(session.content.sheets[0]!);
    const t = layout.revisions ?? layout.title;
    // The view right over the title block, where the list would stand.
    const st0 = controller.state.views.get(frame.id);
    if (st0?.status !== 'ready') throw new Error('view not ready');
    const [[, y0], [x1]] = st0.graphics.bounds;
    controller.updateView({
      ...frame,
      at: [frame.at[0] + (t.x + t.width - 10 - x1), frame.at[1] + (t.y + t.height + 2 - y0)],
    });
    await settled();
    expect(controller.addPartsList(frame.id)).toBeUndefined();
    const list = session.content.annotations[0]!;
    expect(list.kind === 'parts-list' && list.at).not.toEqual([t.x + t.width, t.y + t.height]);
    const box = controller.annotationGraphics(list).bounds!;
    const st = controller.state.views.get(frame.id);
    if (st?.status !== 'ready') throw new Error('view not ready');
    const [[a0, b0], [a1, b1]] = st.graphics.bounds;
    const overlaps = box[1][0] > a0 && box[0][0] < a1 && box[1][1] > b0 && box[0][1] < b1;
    expect(overlaps).toBe(false);
    const f = layout.frame;
    expect(box[0][0]).toBeGreaterThanOrEqual(f.x);
    expect(box[1][0]).toBeLessThanOrEqual(f.x + f.width);
    expect(box[0][1]).toBeGreaterThanOrEqual(f.y);
    expect(box[1][1]).toBeLessThanOrEqual(f.y + f.height);
  });
});
