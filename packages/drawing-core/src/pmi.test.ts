import { describe, expect, it } from 'vitest';
import { drawingAnnotationGraphics } from './dimensions';
import { drawingIssueBlockers } from './issue';
import type {
  DrawingCadView,
  DrawingDocument,
  DrawingPmiItem,
  DrawingPmiNote,
  DrawingSource,
  DrawingSymbol,
} from './model';
import {
  addDrawingAnnotations,
  addDrawingView,
  drawingStarter,
  useDrawingSource,
} from './operations';
import {
  drawingPmiChanges,
  drawingPmiDimensionText,
  drawingPmiResolve,
  drawingPmiSymbol,
  drawingPmiText,
  type DrawingPmiLive,
} from './pmi';
import { drawingProject } from './project';
import type { DrawingViewState } from './svg';
import { box } from './test-shapes';
import { validateDrawing } from './validation';
import { drawingCadViewGraphics } from './view-graphics';

// DW3c-2b (docs/cad/drawing-editor.md, PMI由来の注記): annotations imported from a part's PMI,
// updated or expired against a newer version. ST-707, TS-2420.

const sha = (c: string) => `sha256:${c.repeat(64)}`;
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
  name: '平面図',
  at: [150, 150],
  scale: '1:1',
  label: true,
  direction: 'top',
  only: [],
  hiddenLines: true,
  centerLines: true,
};
const position: DrawingPmiItem = {
  kind: 'geometric-tolerance',
  type: 'Position',
  value: 0.1,
  zone: 'D',
  modifiers: ['MAXIMUM_MATERIAL_REQUIREMENT'],
  datums: ['A', 'B'],
};
const width: DrawingPmiItem = {
  kind: 'dimension',
  type: 'Location_LinearDistance',
  values: [60],
  deviation: { lower: -0.1, upper: 0.1 },
};
const datumA: DrawingPmiItem = { kind: 'datum', name: 'A' };
const live = (itemId: string, item: DrawingPmiItem, over: Partial<DrawingPmiLive> = {}) => ({
  path: [],
  bodyId: 'plate',
  itemId,
  assetSha256: sha('a'),
  item,
  current: true,
  target: [30, 20, 20] as [number, number, number],
  ...over,
});
const note = (id: string, itemId: string, item: DrawingPmiItem): DrawingPmiNote => ({
  id,
  sheetId: 'sheet-1',
  kind: 'pmi',
  viewId: 'view-1',
  source: { path: [], bodyId: 'plate', itemId, assetSha256: sha('a') },
  item,
  at: [40, 10],
  heightMm: 3.5,
});
function setup(pmi: DrawingPmiLive[] | undefined) {
  const r = drawingProject([box(60, 40, 20)], 'top', { step: 0.25, hidden: true, centers: true });
  const g = drawingCadViewGraphics(view, r);
  const state: DrawingViewState = {
    status: 'ready',
    graphics: { items: g.items, bounds: g.bounds, frame: g.frame, features: g.features, pmi },
  };
  return new Map([[view.id, state]]);
}
const docWith = (notes: DrawingPmiNote[]): DrawingDocument =>
  addDrawingAnnotations(
    addDrawingView(useDrawingSource(drawingStarter(), source).doc, view),
    notes,
  );
const texts = (g: { items: { type: string; text?: string }[] }) =>
  g.items.filter((i) => i.type === 'text').map((i) => i.text);

describe('PMI annotations (DW3c-2b)', () => {
  it('writes dimensions as a drawing does and maps tolerances onto the frame', () => {
    expect(drawingPmiDimensionText(width as never)).toBe('60 ±0.1');
    expect(
      drawingPmiDimensionText({
        kind: 'dimension',
        type: 'Size_Diameter',
        values: [10],
        deviation: { lower: 0, upper: 0.05 },
      }),
    ).toBe('Ø10 +0.05/+0');
    expect(drawingPmiSymbol(position)).toEqual({
      type: 'gdt',
      characteristic: 'position',
      tolerance: '0.1',
      diameter: true,
      modifier: 'M',
      datums: ['A', 'B'],
    });
    expect(drawingPmiSymbol(datumA)).toEqual({ type: 'datum', letter: 'A' });
    expect(drawingPmiSymbol({ ...position, type: 'Unknown' } as DrawingPmiItem)).toBeUndefined();
    expect(drawingPmiChanges(width, { ...width, values: [62] } as DrawingPmiItem)).toEqual([
      '60 ±0.1 → 62 ±0.1',
    ]);
  });

  it('is valid content, drawn as a frame, a datum and a note; datums from PMI count', () => {
    const doc = docWith([
      note('pmi-1', 'pmi-1', datumA),
      note('pmi-2', 'pmi-2', position),
      note('pmi-3', 'pmi-3', width),
    ]);
    expect(validateDrawing(doc)).toEqual([]);
    const views = setup([live('pmi-1', datumA), live('pmi-2', position), live('pmi-3', width)]);
    const [d, f, w] = doc.annotations.map((a) => drawingAnnotationGraphics(doc, a, views));
    expect(d!.status).toBe('ok');
    // The frame: B is no datum of the drawing.
    expect(f!.status).toBe('datum-missing');
    expect(texts(f!)).toContain('A');
    expect(w!.status).toBe('ok');
    expect(texts(w!)).toEqual(['60 ±0.1']);
    // Its arrow ends at the target's place on the paper (top view at 1:1).
    const arrow = w!.items.find((i) => i.type === 'polyline' && i.fill);
    expect(arrow?.type === 'polyline' && arrow.points[0]).toEqual([150 + 30 - 30, 150 + 20 - 20]);
  });

  it('says updated when the values changed and expired when gone, stale or of another kind', () => {
    const n = note('pmi-3', 'pmi-3', width);
    const changed = { ...width, values: [62] } as DrawingPmiItem;
    expect(drawingPmiResolve(n, [live('pmi-3', width)]).state).toBe('ok');
    expect(drawingPmiResolve(n, undefined).state).toBe('pending');
    expect(drawingPmiResolve(n, [live('pmi-3', changed)]).state).toBe('updated');
    expect(drawingPmiResolve(n, []).state).toBe('expired');
    expect(drawingPmiResolve(n, [live('pmi-3', width, { current: false })]).state).toBe('expired');
    expect(drawingPmiResolve(n, [live('pmi-3', datumA)]).state).toBe('expired');
    expect(drawingPmiResolve(n, [live('pmi-3', width, { path: ['occ-1'] })]).state).toBe('expired');
    const doc = docWith([n]);
    const updated = drawingAnnotationGraphics(doc, n, setup([live('pmi-3', changed)]));
    expect(updated.status).toBe('updated');
    expect(texts(updated)).toEqual(['62 ±0.1']);
    // Expired: what it said, in red, and no leader to a place that is no more.
    const expired = drawingAnnotationGraphics(doc, n, setup([]));
    expect(expired.status).toBe('expired');
    expect(expired.items.every((i) => i.type === 'text' && i.error)).toBe(true);
  });

  it('keeps a sheet from being issued while its PMI is not read, updated or expired (DW6b)', () => {
    const doc = docWith([note('pmi-3', 'pmi-3', width)]);
    const at = (pmi: DrawingPmiLive[] | undefined) =>
      drawingIssueBlockers(doc, setup(pmi), ['sheet-1']).map((b) => b.code);
    // The view is drawn but its PMI not read yet: the note would print as nothing.
    expect(at(undefined)).toEqual(['issue-pending']);
    expect(at([live('pmi-3', { ...width, values: [62] } as DrawingPmiItem)])).toEqual([
      'issue-pmi-updated',
    ]);
    expect(at([])).toEqual(['issue-pmi-expired']);
    expect(at([live('pmi-3', width)])).toEqual([]);
  });

  it('refuses a malformed item or source by path', () => {
    const doc = docWith([note('pmi-1', 'pmi-1', width)]);
    const bad = structuredClone(doc);
    const a = bad.annotations[0] as DrawingPmiNote;
    a.source.assetSha256 = 'md5:1';
    (a.item as { values: unknown }).values = [];
    expect(validateDrawing(bad).map((d) => `${d.code}@${d.path}`)).toEqual([
      'shape@$.annotations[0].source.assetSha256',
      'shape@$.annotations[0].item.values',
    ]);
    (a.item as { kind: string }).kind = 'note';
    expect(validateDrawing(bad).map((d) => d.code)).toContain('pmi-kind');
  });
});

describe('PMI annotations after Codex on #1223', () => {
  it('writes what the frame cannot say as text, and never takes an inherited name for a type', () => {
    const full: DrawingPmiItem = {
      ...position,
      zone: 'SD',
      maxValue: 0.3,
      datums: ['A-B'],
      datumModifiers: [['FREE_STATE']],
    };
    expect(drawingPmiSymbol(full)).toBeUndefined();
    expect(drawingPmiSymbol({ ...position, zone: 'SD' } as DrawingPmiItem)).toBeUndefined();
    expect(drawingPmiSymbol({ ...position, datums: ['A-B'] } as DrawingPmiItem)).toBeUndefined();
    expect(
      drawingPmiSymbol({ ...position, type: 'constructor' } as DrawingPmiItem),
    ).toBeUndefined();
    // What a manual frame may not be: an angularity with no datum, a flatness with one.
    for (const odd of [
      { ...position, type: 'Angularity', datums: [] },
      { ...position, type: 'Flatness', modifiers: [] },
      { ...position, datums: ['A', 'A'] },
    ])
      expect(drawingPmiSymbol(odd as DrawingPmiItem)).toBeUndefined();
    expect(drawingPmiText(full)).toBe('Position SØ0.1 Ⓜ (max 0.3) | A-B (free state)');
    // Every requirement counts: a changed maximum is an update.
    const n = note('pmi-2', 'pmi-2', full);
    const docFull = docWith([n]);
    expect(validateDrawing(docFull)).toEqual([]);
    const later = { ...full, maxValue: 0.4 } as DrawingPmiItem;
    expect(drawingPmiResolve(n, [live('pmi-2', later)]).state).toBe('updated');
    const g = drawingAnnotationGraphics(docFull, n, setup([live('pmi-2', full)]));
    expect(texts(g)).toEqual(['Position SØ0.1 Ⓜ (max 0.3) | A-B (free state)']);
    // A tolerance of an inherited name is text too, drawn without throwing.
    const odd = note('pmi-3', 'pmi-3', { ...position, type: 'toString' } as DrawingPmiItem);
    expect(drawingAnnotationGraphics(docWith([odd]), odd, setup([])).status).toBe('expired');
  });

  it('draws an expired frame or datum as text only', () => {
    const doc = docWith([note('pmi-1', 'pmi-1', datumA), note('pmi-2', 'pmi-2', position)]);
    for (const a of doc.annotations) {
      const g = drawingAnnotationGraphics(doc, a, setup([]));
      expect(g.status).toBe('expired');
      expect(g.items.every((i) => i.type === 'text' && i.error)).toBe(true);
    }
  });

  it('counts the PMI datums as they read on the version shown', () => {
    const manual = (letter: string): DrawingSymbol => ({
      id: `sym-${letter}`,
      sheetId: 'sheet-1',
      kind: 'symbol',
      viewId: '',
      ref: null,
      target: [10, 10],
      at: [20, 20],
      symbol: {
        type: 'gdt',
        characteristic: 'parallelism',
        tolerance: '0.1',
        diameter: false,
        modifier: '',
        datums: [letter],
      },
      heightMm: 3.5,
    });
    const doc = addDrawingAnnotations(docWith([note('pmi-1', 'pmi-1', datumA)]), [
      manual('A'),
      manual('B'),
    ]);
    const status = (pmi: DrawingPmiLive[]) =>
      doc.annotations.slice(1).map((a) => drawingAnnotationGraphics(doc, a, setup(pmi)).status);
    expect(status([live('pmi-1', datumA)])).toEqual(['ok', 'datum-missing']);
    // Renamed to B on the newer version: B is there, A is not.
    expect(status([live('pmi-1', { kind: 'datum', name: 'B' })])).toEqual(['datum-missing', 'ok']);
    // Expired: neither.
    expect(status([])).toEqual(['datum-missing', 'datum-missing']);
  });
});
