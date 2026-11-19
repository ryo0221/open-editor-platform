import { describe, expect, it } from 'vitest';
import {
  drawingAnchorIssues,
  drawingAnnotationGraphics,
  drawingRefOn,
  drawingRefPoint,
  drawingResolveRef,
  drawingSnap,
} from './dimensions';
import type { DrawingCadView, DrawingDimension, DrawingRef, DrawingSource } from './model';
import {
  addDrawingAnnotation,
  addDrawingView,
  drawingStarter,
  rebindDrawingRef,
  useDrawingSource,
} from './operations';
import { drawingProject, type DrawingEdgeFeature, type DrawingMeshBody } from './project';
import type { DrawingViewState } from './svg';
import { box } from './test-shapes';
import { validateDrawing } from './validation';
import { drawingCadViewGraphics } from './view-graphics';

// DW3c-1 (docs/cad/drawing-editor.md, 寸法のアンカー): a dimension follows its edges' names to a
// newer version; several edges of a name are ambiguous, none unresolved. ST-705, TS-2415.

const source: DrawingSource = {
  id: 'src-1',
  kind: 'cad',
  artifactId: 'part',
  versionId: 'v1',
  contentHash: 'h1',
  name: 'Part',
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

/**
 * A box whose edges are named by where they are on the unit box (as a kernel names an edge by
 * its faces), listed in `order` (a newer version numbers its edges differently).
 */
function namedBox(a: number, b: number, c: number, order: 'same' | 'reversed' = 'same') {
  const body = box(a, b, c);
  const unit = (v: number, k: number) => Math.round(v / [a, b, c][k % 3]!);
  const edges = body.edges.map((e) => ({
    ...e,
    name: JSON.stringify(Array.from(e.points, (v, k) => unit(v, k)).join(',')),
  }));
  const listed = order === 'same' ? edges : [...edges].reverse();
  return { ...body, edges: listed.map((e, index) => ({ ...e, index })) };
}
function stateOf(bodies: DrawingMeshBody[]): DrawingViewState {
  const r = drawingProject(bodies, 'front', { step: 0.25, hidden: true, centers: true });
  const g = drawingCadViewGraphics(view, r);
  return {
    status: 'ready',
    graphics: { items: g.items, bounds: g.bounds, frame: g.frame, features: g.features },
  };
}
const features = (st: DrawingViewState) =>
  st.status === 'ready' ? (st.graphics.features ?? []) : [];
const views = (st: DrawingViewState) => new Map([[view.id, st]]);
/** The front view's bottom edge, both its ends, by snapping on the paper. */
function bottomRefs(st: DrawingViewState): [DrawingRef, DrawingRef] {
  const doc = addDrawingView(useDrawingSource(drawingStarter(), source).doc, view);
  const at = (x: number) =>
    drawingSnap(doc, views(st), 'sheet-1', [150 + x, 150 - 10], 'point', 1)!.ref;
  return [at(-30), at(30)];
}
const width = (refs: DrawingRef[]): DrawingDimension => ({
  id: 'dim-1',
  sheetId: 'sheet-1',
  kind: 'dimension',
  viewId: 'view-1',
  type: 'horizontal',
  refs,
  at: [0, -20],
  text: '',
  tolerance: '',
  heightMm: 3.5,
});
const docWith = (dim: DrawingDimension) =>
  addDrawingAnnotation(addDrawingView(useDrawingSource(drawingStarter(), source).doc, view), dim);

describe('dimension anchors (DW3c)', () => {
  it('keeps the name a snap picks, and the drawing stays valid content', () => {
    const v1 = stateOf([namedBox(60, 40, 20)]);
    const refs = bottomRefs(v1);
    expect(refs.every((r) => typeof r.name === 'string')).toBe(true);
    const doc = docWith(width(refs));
    expect(validateDrawing(doc)).toEqual([]);
    expect(drawingAnnotationGraphics(doc, doc.annotations[0]!, views(v1)).value).toBeCloseTo(60);
    // A name with a control character is refused by path.
    const bad = structuredClone(doc);
    (bad.annotations[0] as DrawingDimension).refs[0]!.name = 'a\u0001';
    expect(validateDrawing(bad).map((d) => `${d.code}@${d.path}`)).toEqual([
      'shape@$.annotations[0].refs[0].name',
    ]);
  });

  it('follows the names to a newer version that numbers its edges otherwise', () => {
    const refs = bottomRefs(stateOf([namedBox(60, 40, 20)]));
    const doc = docWith(width(refs));
    const v2 = stateOf([namedBox(90, 40, 20, 'reversed')]);
    // The same indices are other edges now: the names still find the bottom's ends.
    expect(refs.map((r) => drawingResolveRef(features(v2), r).state)).toEqual(['ok', 'ok']);
    const g = drawingAnnotationGraphics(doc, doc.annotations[0]!, views(v2));
    expect(g.status).toBe('ok');
    expect(g.value).toBeCloseTo(90);
    expect(drawingAnchorIssues(doc, views(v2))).toEqual([]);
    // Without names (imported geometry), the index alone is followed: another edge here.
    const unnamed = refs.map(({ name: _, ...r }) => r);
    const byIndex = drawingAnnotationGraphics(docWith(width(unnamed)), width(unnamed), views(v2));
    expect(byIndex.value).not.toBeCloseTo(90);
  });

  it('says unresolved when the name is gone and ambiguous when several edges have it', () => {
    const v1 = stateOf([namedBox(60, 40, 20)]);
    const refs = bottomRefs(v1);
    const doc = docWith(width(refs));
    const name = refs[0]!.name!;
    // The newer version lost the edge: unresolved, drawn in red where it was, never dropped.
    const gone = namedBox(60, 40, 20);
    gone.edges = gone.edges.filter((e) => e.name !== name);
    const g = drawingAnnotationGraphics(doc, doc.annotations[0]!, views(stateOf([gone])));
    expect(g.status).toBe('unresolved');
    expect(g.items.some((i) => i.type === 'line' && i.cls === 'error')).toBe(true);
    const issues = drawingAnchorIssues(doc, views(stateOf([gone])));
    expect(issues.map((i) => [i.annotationId, i.index, i.state])).toEqual([
      ['dim-1', 0, 'unresolved'],
    ]);

    // Two edges of that name, the right end moved away from where it was picked: that end is
    // ambiguous, with both edges; the left end, still where it was, keeps its edge.
    const split = namedBox(80, 40, 20);
    const top = split.edges.find((e) => /"0,0,1,1,0,1"|"1,0,1,0,0,1"/.test(e.name))!;
    split.edges.find((e) => e.index === top.index)!.name = refs[1]!.name!;
    const st = stateOf([split]);
    const two = drawingAnchorIssues(doc, views(st));
    expect(two.map((i) => [i.index, i.state, i.candidates.length])).toEqual([[1, 'ambiguous', 2]]);
    expect(drawingAnnotationGraphics(doc, doc.annotations[0]!, views(st)).status).toBe('ambiguous');
    // Choosing a candidate puts it under the ref: it resolves again, on the edge chosen.
    const bottom = two[0]!.candidates.find((f) => Math.abs(f.start[2]) < 1e-9)!;
    const next = rebindDrawingRef(doc, 'dim-1', 1, drawingRefOn(refs[1]!, bottom));
    expect(drawingAnchorIssues(next, views(st))).toEqual([]);
    expect(drawingAnnotationGraphics(next, next.annotations[0]!, views(st)).value).toBeCloseTo(80);
    expect(() => rebindDrawingRef(doc, 'dim-1', 2, refs[0]!)).toThrow('ref-missing');
  });

  it('keeps the edge picked among several of one name while the shape is unchanged', () => {
    const body = namedBox(60, 40, 20);
    // Every edge of the box has one name: only the place picked tells them apart.
    const same = { ...body, edges: body.edges.map((e) => ({ ...e, name: 'one' })) };
    const st = stateOf([same]);
    const refs = bottomRefs(st);
    const doc = docWith(width(refs));
    expect(drawingAnchorIssues(doc, views(st))).toEqual([]);
    expect(drawingAnnotationGraphics(doc, doc.annotations[0]!, views(st)).value).toBeCloseTo(60);
  });

  it('treats the pieces of one edge as one candidate', () => {
    const f = (edge: number, start: [number, number, number]): DrawingEdgeFeature => ({
      anchor: { kind: 'edge', path: [], bodyId: 'b', edge },
      start,
      end: [start[0] + 1, start[1], start[2]],
      straight: true,
      name: 'n',
    });
    const ref: DrawingRef = {
      path: [],
      bodyId: 'b',
      edge: 9,
      point: 'start',
      model: [50, 0, 0],
      name: 'n',
    };
    expect(drawingResolveRef([f(3, [0, 0, 0]), f(3, [5, 0, 0])], ref).state).toBe('ok');
    expect(drawingResolveRef([f(3, [0, 0, 0]), f(4, [5, 0, 0])], ref).state).toBe('ambiguous');
  });

  it('leaves a centre unresolved once its edge is no circle (Codex on #1278)', () => {
    const ring: DrawingEdgeFeature = {
      anchor: { kind: 'edge', path: [], bodyId: 'b', edge: 3 },
      start: [15, 0, 0],
      end: [15, 0, 0],
      straight: false,
      circle: { c: [10, 0, 0], n: [0, 0, 1], r: 5 },
      name: 'n',
    };
    const ref: DrawingRef = {
      path: [],
      bodyId: 'b',
      edge: 3,
      point: 'center',
      model: [10, 0, 0],
      name: 'n',
    };
    expect(drawingResolveRef([ring], ref).state).toBe('ok');
    const { circle: _, ...curve } = { ...ring, start: [40, 0, 0] as [number, number, number] };
    expect(drawingResolveRef([curve], ref).state).toBe('unresolved');
    expect(drawingResolveRef([curve], { ...ref, name: undefined }).state).toBe('unresolved');
  });
});

describe('dimension anchors after Codex on #1217', () => {
  it('moves an edge-attached leader target with its edge, and lists a circle gone straight', () => {
    const f = (y: number, circle = false): DrawingEdgeFeature => ({
      anchor: { kind: 'edge', path: [], bodyId: 'b', edge: 0 },
      start: [0, y, 0],
      end: [10, y, 0],
      straight: !circle,
      name: 'n',
      ...(circle ? { circle: { c: [5, y, 0], n: [0, 0, 1], r: 5 } } : {}),
    });
    const ref: DrawingRef = {
      path: [],
      bodyId: 'b',
      edge: 0,
      point: 'edge',
      model: [4, 0, 0],
      name: 'n',
    };
    const moved = drawingResolveRef([f(20)], ref).feature!;
    expect(drawingRefPoint(ref, moved)).toEqual([4, 20, 0]);
    // A radius whose named edge is a straight line now: unresolved, and listed.
    const st: DrawingViewState = {
      status: 'ready',
      graphics: {
        items: [],
        bounds: [
          [0, 0],
          [1, 1],
        ],
        features: [f(0)],
      },
    };
    const radius = { ...width([ref]), type: 'radius' as const };
    const doc = docWith(radius);
    expect(drawingAnchorIssues(doc, views(st)).map((i) => [i.index, i.state])).toEqual([
      [0, 'unresolved'],
    ]);
    // An angle on the same straight edge is fine.
    const angle = docWith({ ...width([ref, ref]), type: 'angle' as const });
    expect(drawingAnchorIssues(angle, views(st))).toEqual([]);
  });
});
