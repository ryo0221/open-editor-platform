import {
  drawingScaleFactor,
  drawingSheetSizes,
  type DrawingDocument,
  type DrawingProjection,
  type DrawingSheet,
  type Vec2,
} from './model';

/**
 * The fixed parts of a sheet (DW1): the paper, the frame and its margins, the zone marks, the
 * centring marks, the title block and the revision table, laid out by JIS Z 8311's rules (frame
 * margin 20 mm on A0/A1 and 10 mm on A2–A4, a 20 mm filing margin on the left, the title block
 * in the lower right at most 170 mm wide). Everything is in paper millimetres, y up.
 */

/** A drawing's primitives on paper (mm, y up from the sheet's lower-left corner). */
export type DrawingItem =
  | { type: 'line'; a: Vec2; b: Vec2; cls: DrawingLineClass }
  /** Many segments `x0 y0 x1 y1 …` of one class. */
  | { type: 'segments'; points: number[]; cls: DrawingLineClass }
  /** `fill`: a closed polyline filled black (an arrowhead). */
  | { type: 'polyline'; points: Vec2[]; closed: boolean; cls: DrawingLineClass; fill?: boolean }
  | { type: 'circle'; center: Vec2; radius: number; cls: DrawingLineClass; fill?: boolean }
  /** Counter-clockwise from `start` to `end` (rad). */
  | { type: 'arc'; center: Vec2; radius: number; start: number; end: number; cls: DrawingLineClass }
  | {
      type: 'text';
      at: Vec2;
      text: string;
      heightMm: number;
      anchor: 'start' | 'middle' | 'end';
      /** Counter-clockwise rotation (rad) about `at`. */
      rotation?: number;
      id?: string;
      /** Drawn in red: a dimension that no longer resolves (DW3). */
      error?: boolean;
    }
  /** A filled area of the class's fill (cut faces); loops are outer then holes. */
  | { type: 'area'; loops: Vec2[][]; cls: 'cut' };

/**
 * Line classes and their widths on paper (JIS B 0001: thin, thick and extra thick in the ratio
 * 1:2:4; hidden lines dashed, centre lines chain).
 */
export const drawingLineWidths = Object.freeze({
  frame: 0.7,
  thick: 0.5,
  thin: 0.25,
  hidden: 0.25,
  center: 0.18,
  dimension: 0.18,
  cut: 0.5,
  hatch: 0.18,
  placeholder: 0.18,
  /** A dimension or leader whose ref no longer resolves: red (DW3). */
  error: 0.18,
});
export type DrawingLineClass = keyof typeof drawingLineWidths;

/** The paper's width and height in mm. */
export function drawingSheetPaper(sheet: Pick<DrawingSheet, 'size' | 'orientation'>): Vec2 {
  const [w, h] = drawingSheetSizes[sheet.size];
  return sheet.orientation === 'landscape' ? [w, h] : [h, w];
}

export interface DrawingRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const drawingTitleBlockSize = Object.freeze({ width: 170, height: 44 });
const revisionRowMm = 6;

/** Where the frame, the title block and the revision table lie on a sheet. */
export function drawingSheetLayout(
  sheet: Pick<DrawingSheet, 'size' | 'orientation' | 'filing' | 'revisions'>,
) {
  const [w, h] = drawingSheetPaper(sheet);
  const margin = sheet.size === 'A0' || sheet.size === 'A1' ? 20 : 10;
  const left = sheet.filing ? 20 : margin;
  const frame: DrawingRect = {
    x: left,
    y: margin,
    width: w - left - margin,
    height: h - 2 * margin,
  };
  const tw = Math.min(drawingTitleBlockSize.width, frame.width);
  const title: DrawingRect = {
    x: frame.x + frame.width - tw,
    y: frame.y,
    width: tw,
    height: drawingTitleBlockSize.height,
  };
  // The revision table sits on the title block: a header and one row per revision.
  const revisions: DrawingRect | undefined = sheet.revisions.length
    ? {
        x: title.x,
        y: title.y + title.height,
        width: tw,
        height: revisionRowMm * (sheet.revisions.length + 1),
      }
    : undefined;
  // Zones (区域): an even count of bays 25–75 mm long along each side.
  const bays = (len: number) => Math.max(2, 2 * Math.round(len / 100));
  return {
    paper: [w, h] as Vec2,
    frame,
    title,
    revisions,
    zones: [bays(frame.width), bays(frame.height)] as Vec2,
  };
}

/** The scales of a sheet's views, as the title block shows them (`1:2`, or `1:1, 2:1`). */
export function drawingSheetScales(doc: DrawingDocument, sheetId: string): string {
  const scales: string[] = [];
  for (const v of doc.views)
    if (v.sheetId === sheetId && !scales.includes(v.scale)) scales.push(v.scale);
  // Largest view scale first (the main scale), then the others.
  scales.sort((a, b) => drawingScaleFactor(b as never) - drawingScaleFactor(a as never));
  return scales.join(', ');
}

const rect = (r: DrawingRect, cls: DrawingLineClass): DrawingItem => ({
  type: 'polyline',
  points: [
    [r.x, r.y],
    [r.x + r.width, r.y],
    [r.x + r.width, r.y + r.height],
    [r.x, r.y + r.height],
  ],
  closed: true,
  cls,
});
const line = (a: Vec2, b: Vec2, cls: DrawingLineClass = 'thin'): DrawingItem => ({
  type: 'line',
  a,
  b,
  cls,
});
const text = (
  at: Vec2,
  value: string,
  heightMm: number,
  anchor: 'start' | 'middle' | 'end' = 'start',
  id?: string,
): DrawingItem => ({ type: 'text', at, text: value, heightMm, anchor, ...(id ? { id } : {}) });

/**
 * The projection symbol (投影法の記号): a truncated cone and its end view. Third angle puts the
 * end seen from the small end beside that end; first angle puts it on the other side.
 */
export function drawingProjectionSymbol(at: Vec2, projection: DrawingProjection): DrawingItem[] {
  const [x, y] = at;
  const out: DrawingItem[] = [];
  const third = projection === 'third-angle';
  // Cone side view: big end 6 mm, small end 3 mm, 7 mm long, its small end towards +x.
  const cx = third ? x - 5 : x + 5;
  const cone: Vec2[] = [
    [cx - 3.5, y - 3],
    [cx + 3.5, y - 1.5],
    [cx + 3.5, y + 1.5],
    [cx - 3.5, y + 3],
  ];
  out.push({ type: 'polyline', points: cone, closed: true, cls: 'thin' });
  const ex = third ? x + 5 : x - 5;
  out.push({ type: 'circle', center: [ex, y], radius: 3, cls: 'thin' });
  out.push({ type: 'circle', center: [ex, y], radius: 1.5, cls: 'thin' });
  out.push(line([cx - 5, y], [ex + 4.5 * (third ? 1 : -1), y], 'center'));
  return out;
}

/** The fixed drawing of one sheet: frame, zones, centring marks, title block, revisions. */
export function drawingSheetItems(doc: DrawingDocument, sheet: DrawingSheet): DrawingItem[] {
  const l = drawingSheetLayout(sheet);
  const { frame: f, title: t } = l;
  const [w, h] = l.paper;
  const out: DrawingItem[] = [rect(f, 'frame')];

  // Centring marks (中心マーク): from the paper's edge into the frame, at each side's middle.
  const mx = f.x + f.width / 2;
  const my = f.y + f.height / 2;
  out.push(line([mx, 0], [mx, f.y + 5], 'frame'), line([mx, h], [mx, f.y + f.height - 5], 'frame'));
  out.push(line([0, my], [f.x + 5, my], 'frame'), line([w, my], [f.x + f.width - 5, my], 'frame'));

  // Zones: numbers along the top and bottom from the left, letters down the sides from the top.
  const [nx, ny] = l.zones;
  const zoneText = Math.min(3.5, (f.y - 1) * 0.6);
  for (let i = 1; i < nx; i++) {
    const x = f.x + (f.width * i) / nx;
    out.push(line([x, f.y], [x, f.y - 3]), line([x, f.y + f.height], [x, f.y + f.height + 3]));
  }
  for (let i = 1; i < ny; i++) {
    const y = f.y + (f.height * i) / ny;
    out.push(line([f.x, y], [f.x - 3, y]), line([f.x + f.width, y], [f.x + f.width + 3, y]));
  }
  if (zoneText >= 2) {
    for (let i = 0; i < nx; i++) {
      const x = f.x + (f.width * (i + 0.5)) / nx;
      out.push(text([x, f.y + f.height + 2], String(i + 1), zoneText, 'middle'));
      out.push(text([x, f.y - 2 - zoneText], String(i + 1), zoneText, 'middle'));
    }
    for (let i = 0; i < ny; i++) {
      const y = f.y + f.height - (f.height * (i + 0.5)) / ny - zoneText / 2;
      const letter = String.fromCharCode(65 + (i % 26));
      out.push(text([f.x / 2, y], letter, zoneText, 'middle'));
      out.push(text([f.x + f.width + (w - f.x - f.width) / 2, y], letter, zoneText, 'middle'));
    }
  }

  // Title block: five rows (title; number, scale, projection; material, quantity, date; the
  // three names; organisation and project).
  out.push(rect(t, 'thick'));
  const rows = [12, 8, 8, 8, 8];
  let y = t.y + t.height;
  const rowY: number[] = [];
  for (const r of rows) {
    y -= r;
    rowY.push(y);
    if (y > t.y + 0.01) out.push(line([t.x, y], [t.x + t.width, y]));
  }
  const at = (frac: number) => t.x + t.width * frac;
  const cell = (
    row: number,
    from: number,
    to: number,
    label: string,
    value: string,
    id: string,
  ) => {
    const top = row === 0 ? t.y + t.height : rowY[row - 1]!;
    const bottom = rowY[row]!;
    if (from > 0) out.push(line([at(from), bottom], [at(from), top]));
    out.push(text([at(from) + 1, top - 2.3], label, 1.8));
    if (value) {
      const hgt = row === 0 ? 5 : 3.5;
      out.push(
        text([at(from) + 1.5, bottom + (top - bottom - hgt) / 2 - 0.5], value, hgt, 'start', id),
      );
    }
  };
  const tb = sheet.title;
  cell(0, 0, 1, '図名', tb.title, 'title');
  cell(1, 0, 0.5, '図番', tb.drawingNumber, 'drawingNumber');
  cell(1, 0.5, 0.75, '尺度', drawingSheetScales(doc, sheet.id), 'scale');
  cell(1, 0.75, 1, '投影法', '', 'projection');
  out.push(...drawingProjectionSymbol([at(0.875), rowY[1]! + 3.2], doc.projection));
  cell(2, 0, 0.45, '材料', tb.material, 'material');
  cell(2, 0.45, 0.65, '数量', tb.quantity, 'quantity');
  cell(2, 0.65, 1, '日付', tb.date, 'date');
  cell(3, 0, 1 / 3, '作成', tb.drawnBy, 'drawnBy');
  cell(3, 1 / 3, 2 / 3, '検図', tb.checkedBy, 'checkedBy');
  cell(3, 2 / 3, 1, '承認', tb.approvedBy, 'approvedBy');
  cell(4, 0, 0.5, '会社', tb.organization, 'organization');
  cell(4, 0.5, 1, '工事・製品', tb.project, 'project');

  // Revision table: a header row on the title block, the revisions above it (oldest first).
  if (l.revisions) {
    const r = l.revisions;
    out.push(rect(r, 'thin'));
    const cols = [0, 0.1, 0.28, 0.82, 1];
    for (const c of cols.slice(1, -1))
      out.push(line([r.x + r.width * c, r.y], [r.x + r.width * c, r.y + r.height]));
    for (let i = 1; i <= sheet.revisions.length; i++)
      out.push(line([r.x, r.y + i * revisionRowMm], [r.x + r.width, r.y + i * revisionRowMm]));
    const put = (row: number, values: string[]) =>
      values.forEach((v, i) =>
        out.push(text([r.x + r.width * cols[i]! + 1, r.y + row * revisionRowMm + 1.7], v, 2.5)),
      );
    put(0, ['記号', '日付', '改訂の内容', '担当']);
    sheet.revisions.forEach((rev, i) => put(i + 1, [rev.mark, rev.date, rev.description, rev.by]));
  }
  return out;
}
