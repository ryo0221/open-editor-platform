import { describe, expect, it } from 'vitest';
import { drawingGdtSymbol } from './annotation-symbols';
import { drawingAnnotationGraphics } from './dimensions';
import {
  drawingGdtCharacteristics,
  type DrawingDocument,
  type DrawingSymbol,
  type DrawingSymbolSpec,
  type Vec2,
} from './model';
import {
  addDrawingAnnotation,
  drawingStarter,
  nextDrawingDatum,
  updateDrawingAnnotation,
} from './operations';
import { drawingSheetSvg } from './svg';
import { validateDrawing } from './validation';

// DW3b (docs/cad/drawing-editor.md, 寸法・記号): drawing symbols. ST-704, TS-2413.

const codes = (doc: unknown) => validateDrawing(doc).map((d) => `${d.code}@${d.path}`);
function symbol(doc: DrawingDocument, id: string, spec: DrawingSymbolSpec): DrawingSymbol {
  return {
    id,
    sheetId: doc.sheets[0]!.id,
    kind: 'symbol',
    viewId: '',
    ref: null,
    target: [100, 100],
    at: [130, 120],
    symbol: spec,
    heightMm: 3.5,
  };
}
const gdt = (
  over: Partial<Extract<DrawingSymbolSpec, { type: 'gdt' }>> = {},
): DrawingSymbolSpec => ({
  type: 'gdt',
  characteristic: 'flatness',
  tolerance: '0.05',
  diameter: false,
  modifier: '',
  datums: [],
  ...over,
});
const weld = (
  over: Partial<Extract<DrawingSymbolSpec, { type: 'weld' }>> = {},
): DrawingSymbolSpec => ({
  type: 'weld',
  weld: 'fillet',
  side: 'arrow',
  size: '6',
  length: '50',
  allAround: false,
  field: false,
  ...over,
});
const graphics = (doc: DrawingDocument, a: DrawingSymbol) =>
  drawingAnnotationGraphics(doc, a, new Map());
const texts = (items: { type: string; text?: string }[]) =>
  items.filter((i) => i.type === 'text').map((i) => i.text);

describe('drawing symbols (DW3b)', () => {
  it('keeps every kind of symbol as valid content', () => {
    let doc = drawingStarter();
    const all: DrawingSymbolSpec[] = [
      gdt(),
      gdt({ characteristic: 'position', diameter: true, modifier: 'M', datums: ['A', 'B', 'C'] }),
      { type: 'datum', letter: 'A' },
      { type: 'surface', process: 'removal', text: 'Ra 1.6' },
      weld({ side: 'both', allAround: true, field: true }),
    ];
    all.forEach((spec, i) => (doc = addDrawingAnnotation(doc, symbol(doc, `sym-${i}`, spec))));
    expect(codes(doc)).toEqual([]);
    expect(nextDrawingDatum(doc)).toBe('B');
    // The sheet's SVG draws them: the frame's texts, the datum letter, the requirement.
    const svg = drawingSheetSvg(doc, doc.sheets[0]!);
    for (const t of ['0.05', 'Ø0.05', '>A<', 'Ra 1.6', '>6<', '>50<']) expect(svg).toContain(t);
  });

  it('refuses datums on a form, none on an orientation, bad and repeated letters', () => {
    const doc = drawingStarter();
    // As stored content (the edit itself refuses these).
    const put = (d: DrawingDocument, a: DrawingSymbol): DrawingDocument => ({
      ...d,
      annotations: [...d.annotations, a],
    });
    const one = (spec: DrawingSymbolSpec) => codes(put(doc, symbol(doc, 'sym-1', spec)));
    expect(one(gdt({ datums: ['A'] }))).toEqual(['gdt-datum-form@$.annotations[0].symbol.datums']);
    expect(one(gdt({ characteristic: 'parallelism' }))).toEqual([
      'gdt-datum-needed@$.annotations[0].symbol.datums',
    ]);
    expect(one(gdt({ characteristic: 'position', datums: ['I'] }))).toEqual([
      'datum-letter@$.annotations[0].symbol.datums',
    ]);
    expect(one({ type: 'datum', letter: 'O' })).toEqual([
      'datum-letter@$.annotations[0].symbol.letter',
    ]);
    expect(one(gdt({ tolerance: '' }))).toEqual(['shape@$.annotations[0].symbol.tolerance']);
    expect(one(weld({ weld: 'rivet' as never }))).toEqual([
      'weld-type@$.annotations[0].symbol.weld',
    ]);
    const twice = put(
      put(doc, symbol(doc, 'sym-1', { type: 'datum', letter: 'A' })),
      symbol(doc, 'sym-2', { type: 'datum', letter: 'A' }),
    );
    expect(() => addDrawingAnnotation(doc, symbol(doc, 'sym-1', gdt({ datums: ['A'] })))).toThrow(
      'gdt-datum-form',
    );
    expect(codes(twice)).toEqual(['datum-duplicate@$.annotations[1].symbol.letter']);
  });

  it('draws a frame cell per part and says when a named datum is missing', () => {
    let doc = drawingStarter();
    const frame = symbol(doc, 'sym-1', gdt({ characteristic: 'perpendicularity', datums: ['A'] }));
    doc = addDrawingAnnotation(doc, frame);
    const g = graphics(doc, frame);
    expect(g.status).toBe('datum-missing');
    // The datum letter is red until a datum A is on the drawing.
    expect(g.items.some((i) => i.type === 'text' && i.text === 'A' && i.error)).toBe(true);
    // The frame (a closed box), two separators, and the leader with its arrow at the target.
    const box = g.items.find((i) => i.type === 'polyline' && i.closed && !i.fill);
    expect(box?.type === 'polyline' && box.points[0]).toEqual([130, 120 - 3.5]);
    const arrow = g.items.find((i) => i.type === 'polyline' && i.fill);
    expect(arrow?.type === 'polyline' && arrow.points[0]).toEqual([100, 100]);
    doc = addDrawingAnnotation(doc, symbol(doc, 'sym-2', { type: 'datum', letter: 'A' }));
    expect(graphics(doc, frame).status).toBe('ok');
    // Renaming the datum away leaves the frame without it again.
    const datum = doc.annotations[1] as DrawingSymbol;
    doc = updateDrawingAnnotation(doc, { ...datum, symbol: { type: 'datum', letter: 'B' } });
    expect(graphics(doc, frame).status).toBe('datum-missing');
  });

  it('draws every characteristic as lines inside its cell', () => {
    for (const ch of drawingGdtCharacteristics) {
      const items = drawingGdtSymbol(ch, [10, 10], 4, 'dimension');
      expect(items.length).toBeGreaterThan(0);
      for (const it of items) {
        const pts =
          it.type === 'line'
            ? [it.a, it.b]
            : it.type === 'polyline'
              ? it.points
              : it.type === 'arc'
                ? Array.from({ length: 9 }, (_, k) => {
                    const t = it.start + ((it.end - it.start) * k) / 8;
                    return [
                      it.center[0] + it.radius * Math.cos(t),
                      it.center[1] + it.radius * Math.sin(t),
                    ];
                  })
                : it.type === 'circle'
                  ? [
                      [it.center[0] - it.radius, it.center[1] - it.radius],
                      [it.center[0] + it.radius, it.center[1] + it.radius],
                    ]
                  : [];
        for (const [x, y] of pts) {
          expect(Math.abs(x! - 10)).toBeLessThanOrEqual(2.01);
          expect(Math.abs(y! - 10)).toBeLessThanOrEqual(2.01);
        }
      }
    }
  });

  it('puts an arrow-side weld under the reference line, the other side over it', () => {
    const doc = drawingStarter();
    const ys = (spec: DrawingSymbolSpec) => {
      const g = graphics(doc, symbol(doc, 'sym-1', spec));
      // The fillet's triangle: a polyline that is not the arrowhead.
      const tri = g.items.find((i) => i.type === 'polyline' && !i.fill);
      return tri?.type === 'polyline' ? tri.points.map((p) => p[1]) : [];
    };
    expect(Math.min(...ys(weld()))).toBeLessThan(120);
    expect(Math.max(...ys(weld()))).toBeCloseTo(120);
    expect(Math.max(...ys(weld({ side: 'other' })))).toBeGreaterThan(120);
    const g = graphics(doc, symbol(doc, 'sym-1', weld({ allAround: true, field: true })));
    expect(g.items.some((i) => i.type === 'circle')).toBe(true);
    expect(texts(g.items)).toEqual(['6', '50']);
  });

  it('closes the surface tick when material is removed, circles it when it is not', () => {
    const doc = drawingStarter();
    const one = (process: 'any' | 'removal' | 'no-removal') =>
      graphics(doc, symbol(doc, 'sym-1', { type: 'surface', process, text: 'Ra 3.2' })).items;
    const lines = (items: ReturnType<typeof one>) => items.filter((i) => i.type === 'line').length;
    expect(lines(one('removal'))).toBe(lines(one('any')) + 1);
    expect(one('no-removal').some((i) => i.type === 'circle')).toBe(true);
    expect(texts(one('any'))).toEqual(['Ra 3.2']);
  });

  it('keeps leaders off the frame and weld labels on the reference line (Codex on #1213)', () => {
    const doc = drawingStarter();
    // A frame right over its target: the leader leaves the frame's bottom side straight down.
    const frame = { ...symbol(doc, 'sym-1', gdt()), target: [140, 100] as Vec2 };
    const lines = graphics(doc, frame).items.filter((i) => i.type === 'line');
    const leader = lines.find((i) => i.type === 'line' && i.b[1] === 100);
    expect(leader?.type === 'line' && leader.a).toEqual([140, 120 - 3.5]);
    // A weld left of its joint: both labels stay on the line, left of the junction.
    const w = { ...symbol(doc, 'sym-2', weld({ length: '50(100)' })), target: [140, 100] as Vec2 };
    const ts = graphics(doc, w).items.filter((i) => i.type === 'text');
    for (const t of ts) {
      if (t.type !== 'text') continue;
      const width = [...t.text].length * 3.5 * 0.7;
      const right = t.anchor === 'start' ? t.at[0] + width : t.at[0];
      expect(right).toBeLessThan(130);
    }
  });
});
