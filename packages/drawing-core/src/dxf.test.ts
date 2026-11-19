import { describe, expect, it } from 'vitest';
import { drawingDxf, drawingDxfSheetGapMm, drawingDxfText, type DrawingPaperSheet } from './dxf';

// DW6 (docs/cad/drawing-editor.md, 出力). ST-713, TS-2443.
/** The DXF's group pairs. */
const pairs = (dxf: string) => {
  const l = dxf.split('\r\n');
  const out: [number, string][] = [];
  for (let i = 0; i + 1 < l.length; i += 2) out.push([Number(l[i]), l[i + 1]!]);
  return out;
};
/** Each entity of ENTITIES as its pairs. */
const entities = (dxf: string) => {
  const p = pairs(dxf);
  const start = p.findIndex(
    ([c, v], i) => c === 2 && v === 'ENTITIES' && p[i - 1]![1] === 'SECTION',
  );
  const out: [number, string][][] = [];
  for (let i = start + 1; p[i]![1] !== 'ENDSEC'; i++)
    if (p[i]![0] === 0) out.push([p[i]!]);
    else out.at(-1)!.push(p[i]!);
  return out;
};
const get = (e: [number, string][], code: number) =>
  e.filter(([c]) => c === code).map(([, v]) => v);

const sheet: DrawingPaperSheet = {
  name: 'S1',
  paper: [420, 297],
  items: [
    { type: 'line', a: [10, 10], b: [20, 10], cls: 'thick' },
    { type: 'segments', points: [0, 0, 1, 1, 2, 2, 3, 3], cls: 'hidden' },
    {
      type: 'polyline',
      points: [
        [0, 0],
        [5, 0],
        [5, 5],
      ],
      closed: false,
      cls: 'center',
    },
    {
      type: 'polyline',
      points: [
        [0, 0],
        [3, 1],
        [3, -1],
      ],
      closed: true,
      fill: true,
      cls: 'dimension',
    },
    { type: 'circle', center: [50, 50], radius: 5, cls: 'thin' },
    {
      type: 'arc',
      center: [60, 60],
      radius: 5,
      start: -Math.PI / 2,
      end: Math.PI / 2,
      cls: 'placeholder',
    },
    { type: 'text', at: [100, 100], text: '断面 A-A φ10', heightMm: 3.5, anchor: 'middle' },
    {
      type: 'text',
      at: [100, 90],
      text: 'gone',
      heightMm: 2.5,
      anchor: 'end',
      error: true,
      rotation: Math.PI / 2,
    },
    {
      type: 'area',
      loops: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
      ],
      cls: 'cut',
    },
  ],
};

describe('DXF export (DW6)', () => {
  it('writes every sheet side by side in R2000, on the five layers, in mm', () => {
    const dxf = drawingDxf([sheet, { ...sheet, name: 'S2' }]);
    const p = pairs(dxf);
    expect(p.find(([c, v]) => c === 1 && v === 'AC1015')).toBeTruthy();
    const at = p.findIndex(([c, v]) => c === 9 && v === '$INSUNITS');
    expect(p[at + 1]).toEqual([70, '4']);
    expect(p.at(-1)).toEqual([0, 'EOF']);
    const layers = p.flatMap(([c, v], i) => (c === 0 && v === 'LAYER' ? [p[i + 5]![1]] : []));
    expect(layers).toEqual(['0', 'OUTLINE', 'HIDDEN', 'CENTER', 'DIMENSION', 'NOTE']);
    // Each item once per sheet (two segments as two lines; no fill for the cut face).
    const es = entities(dxf);
    const kinds = es.map((e) => e[0]![1]);
    expect(kinds.filter((k) => k === 'LINE')).toHaveLength(6);
    expect(kinds.filter((k) => k === 'LWPOLYLINE')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'SOLID')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'CIRCLE')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'ARC')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'TEXT')).toHaveLength(4);
    expect(es).toHaveLength(18);
    // Line classes as layers, line types and weights.
    const first = es[0]!;
    expect(get(first, 8)).toEqual(['OUTLINE']);
    expect(get(first, 370)).toEqual(['50']);
    expect(get(es[1]!, 8)).toEqual(['HIDDEN']);
    expect(get(es[3]!, 8)).toEqual(['CENTER']);
    const arc = es.find((e) => e[0]![1] === 'ARC')!;
    expect(get(arc, 6)).toEqual(['JIS_PLACEHOLDER']);
    expect([get(arc, 50), get(arc, 51)]).toEqual([['270'], ['90']]);
    // Text on NOTE, wide letters escaped, anchored by its alignment point; red in error.
    const texts = es.filter((e) => e[0]![1] === 'TEXT');
    expect(get(texts[0]!, 1)).toEqual(['\\U+65AD\\U+9762 A-A \\U+03C610']);
    expect(get(texts[0]!, 72)).toEqual(['1']);
    expect(get(texts[1]!, 62)).toEqual(['1']);
    expect(get(texts[1]!, 50)).toEqual(['90']);
    expect(get(texts[1]!, 8)).toEqual(['NOTE']);
    // The second sheet stands right of the first, past the gap.
    expect(get(es[9]!, 10)).toEqual([String(10 + 420 + drawingDxfSheetGapMm)]);
    // Handles are unique, and the seed past them all.
    const handles = p
      .filter(([c], i) => (c === 5 || c === 105) && p[i - 1]![0] === 0)
      .map(([, v]) => parseInt(v, 16));
    expect(new Set(handles).size).toBe(handles.length);
    const seed = p[p.findIndex(([c, v]) => c === 9 && v === '$HANDSEED') + 1]![1];
    expect(parseInt(seed, 16)).toBeGreaterThan(Math.max(...handles));
  });

  it('writes a sheet of many lines (Codex on #1244)', () => {
    const points: number[] = [];
    for (let i = 0; i < 200_000; i++) points.push(i, 0, i, 1);
    const dxf = drawingDxf([
      { name: 'S', paper: [420, 297], items: [{ type: 'segments', points, cls: 'thin' }] },
    ]);
    expect(entities(dxf)).toHaveLength(200_000);
  });

  it('escapes what R2000 cannot hold', () => {
    expect(drawingDxfText('a\\b\n寸法😀')).toBe('a\\\\b \\U+5BF8\\U+6CD5?');
    expect(drawingDxf([])).toContain('EOF');
  });
});
