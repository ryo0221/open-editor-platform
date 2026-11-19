import { drawingLineWidths, type DrawingItem, type DrawingLineClass } from './sheet';
import type { Vec2 } from './model';

/**
 * DW6 (docs/cad/drawing-editor.md, 出力): every sheet as one DXF (AutoCAD R2000, ASCII), in
 * millimetres. The sheets stand side by side in model space, left to right with a gap, each with
 * its frame and title block. Only lines, polylines, arcs, circles, text and filled triangles are
 * written, on the drawing's five layers; dimensions are their lines and text (no DIMENSION
 * entity), and cut faces' grey fill is left out (their outlines are drawn thick). What a DXF
 * loses is listed in docs/verification/drawing/README.md (DW6).
 */
export interface DrawingPaperSheet {
  name: string;
  /** Width and height in mm. */
  paper: Vec2;
  items: readonly DrawingItem[];
}

/** The gap between sheets in model space (mm). */
export const drawingDxfSheetGapMm = 50;

/** The drawing's layers: 外形線, 隠れ線, 中心線, 寸法, 注記 (JIS B 0001 line types). */
export const drawingDxfLayers = Object.freeze({
  OUTLINE: { color: 7, linetype: 'CONTINUOUS', description: '外形線 Outlines' },
  HIDDEN: { color: 7, linetype: 'JIS_HIDDEN', description: '隠れ線 Hidden lines' },
  CENTER: { color: 7, linetype: 'JIS_CENTER', description: '中心線 Centre lines' },
  DIMENSION: { color: 7, linetype: 'CONTINUOUS', description: '寸法 Dimensions' },
  NOTE: { color: 7, linetype: 'CONTINUOUS', description: '注記 Notes and text' },
});
type Layer = keyof typeof drawingDxfLayers;

/** Line types in mm (dash, gap, …), as the SVG and PDF draw them. */
const linetypes: Record<string, { description: string; pattern: number[] }> = {
  JIS_HIDDEN: { description: 'Hidden __ __ __', pattern: [3, -1] },
  JIS_CENTER: { description: 'Center ____ _ ____', pattern: [12, -1.5, 1.5, -1.5] },
  JIS_PLACEHOLDER: { description: 'Placeholder _ _ _', pattern: [2, -1.5] },
};

const layerOf = (cls: DrawingLineClass): Layer =>
  cls === 'hidden'
    ? 'HIDDEN'
    : cls === 'center'
      ? 'CENTER'
      : cls === 'dimension' || cls === 'error'
        ? 'DIMENSION'
        : 'OUTLINE';

/** A line class's width as a DXF lineweight (1/100 mm, one of the standard weights). */
const weights = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100];
const weightOf = (cls: DrawingLineClass) => {
  const w = Math.round(drawingLineWidths[cls] * 100);
  return weights.reduce((a, b) => (Math.abs(b - w) < Math.abs(a - w) ? b : a));
};

/** Text as R2000 writes it: ASCII as is, the rest as `\U+XXXX` (outside the BMP: `?`). */
export function drawingDxfText(text: string): string {
  let out = '';
  for (const ch of text.replace(/[\r\n\t]/g, ' ')) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x20 && c < 0x7f) out += ch === '\\' ? '\\\\' : ch;
    else if (c <= 0xffff && c >= 0x20)
      out += `\\U+${c.toString(16).toUpperCase().padStart(4, '0')}`;
    else out += '?';
  }
  return out;
}

const num = (v: number) => {
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? '0' : String(r);
};

export function drawingDxf(sheets: readonly DrawingPaperSheet[]): string {
  const out: string[] = [];
  const g = (code: number, value: string | number) =>
    out.push(String(code), typeof value === 'number' ? num(value) : value);
  let next = 0x20;
  const handle = () => (next++).toString(16).toUpperCase();

  // Handles fixed up front: tables, block records, the root dictionary.
  const h = {
    vport: handle(),
    ltype: handle(),
    layer: handle(),
    style: handle(),
    view: handle(),
    ucs: handle(),
    appid: handle(),
    dimstyle: handle(),
    blockRecord: handle(),
    model: handle(),
    paper: handle(),
    root: handle(),
    groups: handle(),
  };

  // Model space: each sheet moved right of the one before.
  const entities: string[] = [];
  const e = (code: number, value: string | number) =>
    entities.push(String(code), typeof value === 'number' ? num(value) : value);
  const head = (type: string, layer: Layer, sub: string, cls?: DrawingLineClass, red = false) => {
    e(0, type);
    e(5, handle());
    e(330, h.model);
    e(100, 'AcDbEntity');
    e(8, layer);
    if (cls === 'placeholder') e(6, 'JIS_PLACEHOLDER');
    if (red || cls === 'error') e(62, 1);
    if (cls) e(370, weightOf(cls));
    e(100, sub);
  };
  let x0 = 0;
  const lo: Vec2 = [Infinity, Infinity];
  const hi: Vec2 = [-Infinity, -Infinity];
  for (const sheet of sheets) {
    const P = (p: Vec2): Vec2 => [p[0] + x0, p[1]];
    const xy = (p: Vec2, code = 10) => {
      const [x, y] = P(p);
      e(code, x);
      e(code + 10, y);
      e(code + 20, 0);
    };
    const line = (a: Vec2, b: Vec2, cls: DrawingLineClass) => {
      head('LINE', layerOf(cls), 'AcDbLine', cls);
      xy(a);
      xy(b, 11);
    };
    for (const it of sheet.items)
      switch (it.type) {
        case 'line':
          line(it.a, it.b, it.cls);
          break;
        case 'segments':
          for (let i = 0; i + 3 < it.points.length; i += 4)
            line(
              [it.points[i]!, it.points[i + 1]!],
              [it.points[i + 2]!, it.points[i + 3]!],
              it.cls,
            );
          break;
        case 'polyline': {
          if (it.points.length < 2) break;
          // A filled triangle (an arrowhead) as a SOLID, its third corner twice.
          if (it.fill && it.closed && it.points.length === 3) {
            head('SOLID', layerOf(it.cls), 'AcDbTrace', it.cls);
            const [a, b, c] = it.points as [Vec2, Vec2, Vec2];
            xy(a);
            xy(b, 11);
            xy(c, 12);
            xy(c, 13);
            break;
          }
          head('LWPOLYLINE', layerOf(it.cls), 'AcDbPolyline', it.cls);
          e(90, it.points.length);
          e(70, it.closed ? 1 : 0);
          for (const p of it.points) {
            const [x, y] = P(p);
            e(10, x);
            e(20, y);
          }
          break;
        }
        case 'circle':
          head('CIRCLE', layerOf(it.cls), 'AcDbCircle', it.cls);
          xy(it.center);
          e(40, it.radius);
          break;
        case 'arc':
          head('ARC', layerOf(it.cls), 'AcDbCircle', it.cls);
          xy(it.center);
          e(40, it.radius);
          e(100, 'AcDbArc');
          e(50, deg(it.start));
          e(51, deg(it.end));
          break;
        case 'text': {
          if (!it.text) break;
          head('TEXT', 'NOTE', 'AcDbText', undefined, it.error);
          xy(it.at);
          e(40, it.heightMm);
          e(1, drawingDxfText(it.text));
          if (it.rotation) e(50, deg(it.rotation));
          const align = it.anchor === 'start' ? 0 : it.anchor === 'middle' ? 1 : 2;
          if (align) {
            e(72, align);
            xy(it.at, 11);
          }
          e(100, 'AcDbText');
          break;
        }
        case 'area':
          // The grey of a cut face: left out (its outline is drawn as thick lines).
          break;
      }
    lo[0] = Math.min(lo[0], x0);
    lo[1] = Math.min(lo[1], 0);
    hi[0] = Math.max(hi[0], x0 + sheet.paper[0]);
    hi[1] = Math.max(hi[1], sheet.paper[1]);
    x0 += sheet.paper[0] + drawingDxfSheetGapMm;
  }
  if (lo[0] === Infinity) {
    lo[0] = lo[1] = 0;
    hi[0] = hi[1] = 0;
  }

  // HEADER
  g(0, 'SECTION');
  g(2, 'HEADER');
  g(9, '$ACADVER');
  g(1, 'AC1015');
  g(9, '$DWGCODEPAGE');
  g(3, 'ANSI_1252');
  g(9, '$INSUNITS');
  g(70, 4);
  g(9, '$MEASUREMENT');
  g(70, 1);
  g(9, '$LTSCALE');
  g(40, 1);
  g(9, '$PSLTSCALE');
  g(70, 0);
  g(9, '$EXTMIN');
  g(10, lo[0]);
  g(20, lo[1]);
  g(30, 0);
  g(9, '$EXTMAX');
  g(10, hi[0]);
  g(20, hi[1]);
  g(30, 0);
  g(9, '$HANDSEED');
  const seedAt = out.length;
  g(5, '0');
  g(0, 'ENDSEC');
  g(0, 'SECTION');
  g(2, 'CLASSES');
  g(0, 'ENDSEC');

  // TABLES
  g(0, 'SECTION');
  g(2, 'TABLES');
  const table = (name: string, own: string, count: number, sub?: string) => {
    g(0, 'TABLE');
    g(2, name);
    g(5, own);
    g(330, '0');
    g(100, 'AcDbSymbolTable');
    g(70, count);
    if (sub) g(100, sub);
  };
  const record = (type: string, own: string, sub: string, name: string, code5 = 5) => {
    g(0, type);
    g(code5, handle());
    g(330, own);
    g(100, 'AcDbSymbolTableRecord');
    g(100, sub);
    g(2, name);
    g(70, 0);
  };
  table('VPORT', h.vport, 1);
  record('VPORT', h.vport, 'AcDbViewportTableRecord', '*ACTIVE');
  g(10, 0);
  g(20, 0);
  g(11, 1);
  g(21, 1);
  g(12, (lo[0] + hi[0]) / 2);
  g(22, (lo[1] + hi[1]) / 2);
  g(40, Math.max(hi[1] - lo[1], 1) * 1.1);
  g(41, Math.max((hi[0] - lo[0]) / Math.max(hi[1] - lo[1], 1), 0.1));
  g(42, 50);
  g(0, 'ENDTAB');

  const ltypes: [string, string, number[]][] = [
    ['ByBlock', '', []],
    ['ByLayer', '', []],
    ['CONTINUOUS', 'Solid line', []],
    ...Object.entries(linetypes).map(
      ([n, t]) => [n, t.description, t.pattern] as [string, string, number[]],
    ),
  ];
  table('LTYPE', h.ltype, ltypes.length);
  for (const [name, description, pattern] of ltypes) {
    record('LTYPE', h.ltype, 'AcDbLinetypeTableRecord', name);
    g(3, description);
    g(72, 65);
    g(73, pattern.length);
    g(
      40,
      pattern.reduce((a, b) => a + Math.abs(b), 0),
    );
    for (const p of pattern) {
      g(49, p);
      g(74, 0);
    }
  }
  g(0, 'ENDTAB');

  const layers: [string, { color: number; linetype: string }][] = [
    ['0', { color: 7, linetype: 'CONTINUOUS' }],
    ...Object.entries(drawingDxfLayers),
  ];
  table('LAYER', h.layer, layers.length);
  for (const [name, l] of layers) {
    record('LAYER', h.layer, 'AcDbLayerTableRecord', name);
    g(62, l.color);
    g(6, l.linetype);
    g(370, -3);
  }
  g(0, 'ENDTAB');

  table('STYLE', h.style, 1);
  record('STYLE', h.style, 'AcDbTextStyleTableRecord', 'Standard');
  g(40, 0);
  g(41, 1);
  g(50, 0);
  g(71, 0);
  g(42, 2.5);
  g(3, 'txt');
  g(4, '');
  g(0, 'ENDTAB');

  table('VIEW', h.view, 0);
  g(0, 'ENDTAB');
  table('UCS', h.ucs, 0);
  g(0, 'ENDTAB');
  table('APPID', h.appid, 1);
  record('APPID', h.appid, 'AcDbRegAppTableRecord', 'ACAD');
  g(0, 'ENDTAB');
  table('DIMSTYLE', h.dimstyle, 1, 'AcDbDimStyleTable');
  record('DIMSTYLE', h.dimstyle, 'AcDbDimStyleTableRecord', 'Standard', 105);
  g(0, 'ENDTAB');

  table('BLOCK_RECORD', h.blockRecord, 2);
  for (const [own, name] of [
    [h.model, '*Model_Space'],
    [h.paper, '*Paper_Space'],
  ] as const) {
    g(0, 'BLOCK_RECORD');
    g(5, own);
    g(330, h.blockRecord);
    g(100, 'AcDbSymbolTableRecord');
    g(100, 'AcDbBlockTableRecord');
    g(2, name);
  }
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');

  // BLOCKS: the two layouts' blocks, empty (what is drawn is in ENTITIES).
  g(0, 'SECTION');
  g(2, 'BLOCKS');
  for (const [own, name] of [
    [h.model, '*Model_Space'],
    [h.paper, '*Paper_Space'],
  ] as const) {
    g(0, 'BLOCK');
    g(5, handle());
    g(330, own);
    g(100, 'AcDbEntity');
    g(8, '0');
    g(100, 'AcDbBlockBegin');
    g(2, name);
    g(70, 0);
    g(10, 0);
    g(20, 0);
    g(30, 0);
    g(3, name);
    g(1, '');
    g(0, 'ENDBLK');
    g(5, handle());
    g(330, own);
    g(100, 'AcDbEntity');
    g(8, '0');
    g(100, 'AcDbBlockEnd');
  }
  g(0, 'ENDSEC');

  g(0, 'SECTION');
  g(2, 'ENTITIES');
  // One at a time: a large drawing's entities pass the engine's argument limit (Codex on #1244).
  for (const v of entities) out.push(v);
  g(0, 'ENDSEC');

  g(0, 'SECTION');
  g(2, 'OBJECTS');
  g(0, 'DICTIONARY');
  g(5, h.root);
  g(330, '0');
  g(100, 'AcDbDictionary');
  g(281, 1);
  g(3, 'ACAD_GROUP');
  g(350, h.groups);
  g(0, 'DICTIONARY');
  g(5, h.groups);
  g(330, h.root);
  g(100, 'AcDbDictionary');
  g(281, 1);
  g(0, 'ENDSEC');
  g(0, 'EOF');
  out[seedAt + 1] = next.toString(16).toUpperCase();
  return out.join('\r\n') + '\r\n';
}

/** Radians counter-clockwise as DXF's degrees (0 to 360). */
const deg = (r: number) => {
  const d = (r * 180) / Math.PI;
  return ((d % 360) + 360) % 360;
};
