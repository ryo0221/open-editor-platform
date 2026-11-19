import { describe, expect, it } from 'vitest';
import { drawingAnchorIssues, drawingAnnotationGraphics } from './dimensions';
import type {
  DrawingBalloon,
  DrawingCadView,
  DrawingDocument,
  DrawingPartsList,
  DrawingSource,
} from './model';
import {
  addDrawingAnnotations,
  addDrawingView,
  drawingStarter,
  moveDrawingItems,
  rebindDrawingRef,
  useDrawingSource,
} from './operations';
import { drawingMemberListColumns, drawingPartRowOf, drawingPartsListColumns } from './parts';
import { drawingProject, type DrawingMeshBody } from './project';
import type { DrawingPartsInfo, DrawingViewState } from './svg';
import { box } from './test-shapes';
import { validateDrawing } from './validation';
import { drawingCadViewGraphics } from './view-graphics';

// DW4a (docs/cad/drawing-editor.md, 組立図): balloons numbered by the version's parts list, and
// the list itself. ST-708, TS-2423.

const source: DrawingSource = {
  id: 'src-1',
  kind: 'cad',
  artifactId: 'asm',
  versionId: 'v1',
  contentHash: 'h1',
  name: 'Assembly',
};
const view: DrawingCadView = {
  id: 'view-1',
  kind: 'cad-projection',
  sheetId: 'sheet-1',
  sourceId: 'src-1',
  name: '正面図',
  at: [150, 150],
  scale: '1:1',
  label: true,
  direction: 'front',
  only: [],
  hiddenLines: true,
  centerLines: true,
};
const moved = (b: DrawingMeshBody, path: string[], dx: number): DrawingMeshBody => ({
  ...b,
  path,
  positions: Array.from(b.positions, (v, i) => (i % 3 === 0 ? v + dx : v)),
  edges: b.edges.map((e) => ({
    ...e,
    points: Array.from(e.points, (v, i) => (i % 3 === 0 ? v + dx : v)),
  })),
});
const parts: DrawingPartsInfo = {
  rows: [
    { item: '1', partNumber: 'B-1', name: 'Base', description: '', quantity: 1, key: 'base' },
    {
      item: '2',
      partNumber: 'C-2',
      name: 'A cube with a very long name indeed, longer than its cell',
      description: 'S45C',
      quantity: 2,
      key: 'cube',
    },
  ],
  occurrences: [
    { path: [], bodyId: 'base', key: 'base' },
    { path: ['o-1'], key: 'cube' },
    { path: ['o-2'], key: 'cube' },
  ],
};
function stateOf(withParts = true): DrawingViewState {
  const bodies = [
    { ...box(60, 40, 20), bodyId: 'base' },
    moved({ ...box(10, 10, 10), bodyId: 'cube' }, ['o-1'], 100),
    moved({ ...box(10, 10, 10), bodyId: 'cube' }, ['o-2'], 130),
    moved({ ...box(10, 10, 10), bodyId: 'cube' }, ['o-3'], 160),
  ];
  const r = drawingProject(bodies, 'front', { step: 0.25, hidden: true, centers: true });
  const g = drawingCadViewGraphics(view, r);
  return {
    status: 'ready',
    graphics: {
      items: g.items,
      bounds: g.bounds,
      frame: g.frame,
      features: g.features,
      ...(withParts ? { parts } : {}),
    },
  };
}
const views = (st: DrawingViewState) => new Map([[view.id, st]]);
const edgeOf = (st: DrawingViewState, path: string[]) => {
  const f = (st.status === 'ready' ? st.graphics.features! : []).find(
    (x) => x.anchor.path.join() === path.join(),
  )!;
  return {
    path,
    bodyId: f.anchor.bodyId,
    edge: f.anchor.edge,
    point: 'edge' as const,
    model: [...f.start] as [number, number, number],
  };
};
const balloon = (id: string, path: string[], st: DrawingViewState): DrawingBalloon => ({
  id,
  sheetId: 'sheet-1',
  kind: 'balloon',
  viewId: 'view-1',
  ref: edgeOf(st, path),
  at: [-20, 40],
  heightMm: 5,
});
const list: DrawingPartsList = {
  id: 'parts-1',
  sheetId: 'sheet-1',
  kind: 'parts-list',
  viewId: 'view-1',
  at: [410, 60],
  heightMm: 3.5,
};
const docWith = (...a: (DrawingBalloon | DrawingPartsList)[]): DrawingDocument =>
  addDrawingAnnotations(addDrawingView(useDrawingSource(drawingStarter(), source).doc, view), a);
const texts = (g: { items: { type: string; text?: string }[] }) =>
  g.items.filter((i) => i.type === 'text').map((i) => i.text);

describe('balloons and the parts list (DW4a)', () => {
  it('numbers a balloon by its part’s row, and is valid content', () => {
    const st = stateOf();
    const doc = docWith(balloon('b-1', [], st), balloon('b-2', ['o-2'], st), list);
    expect(validateDrawing(doc)).toEqual([]);
    const [b1, b2] = doc.annotations.map((a) => drawingAnnotationGraphics(doc, a, views(st)));
    expect([b1!.status, texts(b1!)]).toEqual(['ok', ['1']]);
    expect([b2!.status, texts(b2!)]).toEqual(['ok', ['2']]);
    // A circle, a line to the part and the dot on it.
    expect(b2!.items.map((i) => i.type)).toEqual(['circle', 'line', 'circle', 'text']);
  });

  it('shows ? in red for a part in no row, and follows the view and a rebind', () => {
    const st = stateOf();
    const doc = docWith(balloon('b-3', ['o-3'], st));
    const g = drawingAnnotationGraphics(doc, doc.annotations[0]!, views(st));
    expect([g.status, texts(g)]).toEqual(['unresolved', ['?']]);
    expect(drawingPartRowOf(parts, { path: ['o-3'], bodyId: 'cube' })).toBeUndefined();
    // Picked again on a counted cube: number 2.
    const next = rebindDrawingRef(doc, 'b-3', 0, edgeOf(st, ['o-1']));
    expect(texts(drawingAnnotationGraphics(next, next.annotations[0]!, views(st)))).toEqual(['2']);
    // An edge gone in a newer version: listed to be picked again.
    const gone = stateOf();
    if (gone.status === 'ready')
      gone.graphics.features = gone.graphics.features!.filter((f) => f.anchor.path[0] !== 'o-1');
    expect(drawingAnchorIssues(next, views(gone)).map((i) => i.annotationId)).toEqual(['b-3']);
    // Moving the view moves the balloon with it (it sits relative to the view).
    const shifted = moveDrawingItems(next, ['view-1'], [10, 0]);
    expect(shifted.annotations[0]!.at).toEqual([-20, 40]);
  });

  it('draws the list on the paper: heading, then one row a part, up', () => {
    const st = stateOf();
    const doc = docWith(list);
    const g = drawingAnnotationGraphics(doc, list, views(st));
    expect(g.status).toBe('ok');
    const t = texts(g);
    expect(t.slice(0, 5)).toEqual(drawingPartsListColumns.map((c) => c.heading));
    expect(t.slice(5, 10)).toEqual(['1', 'B-1', 'Base', '1', '']);
    // A long name is cut to its cell.
    expect(t[12]).toMatch(/…$/);
    expect(t[13]).toBe('2');
    const width = drawingPartsListColumns.reduce((s, c) => s + c.width, 0);
    expect(g.bounds![0]).toEqual([410 - width, 60]);
    expect(g.bounds![1][1]).toBeGreaterThan(60 + 2 * 7);
    // Moving the view leaves the list where it is on the paper; moving it with the view too.
    expect(moveDrawingItems(doc, ['view-1'], [5, 5]).annotations[0]!.at).toEqual([410, 60]);
    expect(moveDrawingItems(doc, ['view-1', 'parts-1'], [5, 5]).annotations[0]!.at).toEqual([
      415, 65,
    ]);
    // Pending while its view derives; only the heading, red, with no view.
    expect(
      drawingAnnotationGraphics(doc, list, new Map([[view.id, { status: 'pending' }]])).status,
    ).toBe('pending');
    const lost = drawingAnnotationGraphics(doc, list, new Map());
    expect(lost.status).toBe('unresolved');
    expect(texts(lost)).toHaveLength(5);
  });

  // DW5c (ST-712, TS-2440): of a building view, the members' columns and rows.
  it('draws a building view’s member list in its own columns', () => {
    const st = stateOf();
    if (st.status !== 'ready') throw new Error('state');
    st.graphics.members = [
      { mark: 'SC1', kind: '柱', section: 'H-700×300×13×24', count: 12, lengthMm: 48000 },
      { mark: 'A very long member mark name', kind: '部材', section: 'φ400', count: 2 },
    ];
    const doc = docWith(list);
    const g = drawingAnnotationGraphics(doc, list, views(st));
    const t = texts(g);
    expect(t.slice(0, 5)).toEqual(drawingMemberListColumns.map((c) => c.heading));
    // The section whole, the length in metres reading from the right.
    expect(t.slice(5, 10)).toEqual(['SC1', '柱', 'H-700×300×13×24', '12', '48.000']);
    expect(t[10]).toMatch(/^A very long.*…$/);
    expect(t[14]).toBe('');
    const width = drawingMemberListColumns.reduce((s, c) => s + c.width, 0);
    expect(g.bounds![0][0]).toBe(410 - width);
    // A newer version with no members: the member list keeps its columns, empty (Codex on #1240).
    st.graphics.members = [];
    const none = texts(drawingAnnotationGraphics(doc, list, views(st)));
    expect(none).toEqual(drawingMemberListColumns.map((c) => c.heading));
  });

  it('refuses a malformed balloon or list by path', () => {
    const st = stateOf();
    const doc = docWith(balloon('b-1', [], st), list);
    const bad = structuredClone(doc);
    (bad.annotations[0] as { ref: unknown }).ref = null;
    (bad.annotations[1] as { viewId: string }).viewId = 'nowhere';
    expect(validateDrawing(bad).map((d) => `${d.code}@${d.path}`)).toEqual([
      'shape@$.annotations[0].ref',
      'view-missing@$.annotations[1].viewId',
    ]);
    expect(() => rebindDrawingRef(doc, 'parts-1', 0, edgeOf(st, []))).toThrow('ref-missing');
  });
});
