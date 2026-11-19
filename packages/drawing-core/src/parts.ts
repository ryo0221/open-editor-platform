import type { DrawingAnnotationGraphics } from './dimensions';
import type { DrawingBalloon, DrawingPartsList, DrawingRef, Vec2 } from './model';
import type { DrawingItem } from './sheet';
import type { DrawingMemberRow, DrawingPartRow, DrawingPartsInfo, DrawingViewState } from './svg';

/**
 * DW4 (docs/cad/drawing-editor.md, 組立図): balloons and the parts list of an assembly view,
 * numbered by the version's flat BOM (the Host works it out from the kept version).
 */

/** The parts-list row a ref's body counts in (none: its body is left out, or unknown). */
export function drawingPartRowOf(
  parts: DrawingPartsInfo | undefined,
  ref: Pick<DrawingRef, 'path' | 'bodyId'>,
): DrawingPartRow | undefined {
  if (!parts) return undefined;
  const o = parts.occurrences.find(
    (x) =>
      x.path.length === ref.path.length &&
      x.path.every((p, i) => p === ref.path[i]) &&
      (x.bodyId === undefined || x.bodyId === ref.bodyId),
  );
  return o && parts.rows.find((r) => r.key === o.key);
}

/**
 * Whether a version is an assembly for balloons and a parts list: it places parts (even one
 * part many times: one row), or it has more than one row (Codex on #1228).
 */
export const drawingIsAssembly = (parts: DrawingPartsInfo | undefined): parts is DrawingPartsInfo =>
  !!parts?.rows.length &&
  (parts.rows.length > 1 || parts.occurrences.some((o) => o.path.length > 0));

/** A balloon's circle radius (paper mm) for its text height: 2.5 mm text is an 8 mm circle. */
export const drawingBalloonRadius = (heightMm: number) => Math.max(4, heightMm * 1.6);

/**
 * A balloon: the circle at `at` with its item number, a thin line to `target` ending on a dot
 * on the part. Unresolved (its edge, or its part's row, is gone): red, `?` when no row.
 */
export function drawingBalloonItems(
  a: Pick<DrawingBalloon, 'id' | 'heightMm'>,
  target: Vec2,
  at: Vec2,
  row: DrawingPartRow | undefined,
  resolved: boolean,
): DrawingAnnotationGraphics {
  const ok = resolved && !!row;
  const cls = ok ? 'dimension' : 'error';
  const r = drawingBalloonRadius(a.heightMm);
  const d: Vec2 = [target[0] - at[0], target[1] - at[1]];
  const len = Math.hypot(d[0], d[1]);
  const items: DrawingItem[] = [{ type: 'circle', center: at, radius: r, cls }];
  if (len > r + 0.5) {
    const start: Vec2 = [at[0] + (d[0] / len) * r, at[1] + (d[1] / len) * r];
    items.push(
      { type: 'line', a: start, b: target, cls },
      { type: 'circle', center: target, radius: 0.5, cls, fill: true },
    );
  }
  items.push({
    type: 'text',
    at: [at[0], at[1] - a.heightMm * 0.35],
    text: row?.item ?? '?',
    heightMm: a.heightMm,
    anchor: 'middle',
    id: `note:${a.id}`,
    ...(ok ? {} : { error: true }),
  });
  const xs = items.flatMap((i) => (i.type === 'line' ? [i.a, i.b] : []));
  const lo: Vec2 = [
    Math.min(at[0] - r, ...xs.map((p) => p[0])),
    Math.min(at[1] - r, ...xs.map((p) => p[1])),
  ];
  const hi: Vec2 = [
    Math.max(at[0] + r, ...xs.map((p) => p[0])),
    Math.max(at[1] + r, ...xs.map((p) => p[1])),
  ];
  return { items, status: ok ? 'ok' : 'unresolved', bounds: [lo, hi] };
}

/** The parts list's columns (JIS B 0001 部品欄): heading and width (mm). */
export const drawingPartsListColumns = [
  { key: 'item', heading: '品番', width: 14 },
  { key: 'partNumber', heading: '部品番号', width: 36 },
  { key: 'name', heading: '名称', width: 44 },
  { key: 'quantity', heading: '数量', width: 14 },
  { key: 'description', heading: '備考', width: 36 },
] as const;
/** DW5c: a building's member list (部材リスト): as wide as the parts list. */
export const drawingMemberListColumns = [
  { key: 'mark', heading: '符号', width: 40 },
  { key: 'kind', heading: '種別', width: 14 },
  { key: 'section', heading: '断面', width: 48 },
  { key: 'count', heading: '本数', width: 14 },
  { key: 'length', heading: '長さ計 (m)', width: 28 },
] as const;
/** A row's height (mm) for a text height. */
export const drawingPartsListRowHeight = (heightMm: number) => Math.max(7, heightMm * 2);

/** A character's width for a text height: a full em for a wide (Japanese) one, 0.6 for the rest. */
const charWidth = (ch: string, h: number) => (ch.codePointAt(0)! > 0x2e7f ? h : h * 0.6);
/** What fits a cell: a long name is cut with `…` (the full text stays in the BOM). */
function fit(text: string, width: number, h: number) {
  const room = width - 2;
  const chars = [...text];
  let w = 0;
  for (const ch of chars) w += charWidth(ch, h);
  if (w <= room) return text;
  let cut = '';
  w = charWidth('…', h);
  for (const ch of chars) {
    if (w + charWidth(ch, h) > room) break;
    w += charWidth(ch, h);
    cut += ch;
  }
  return `${cut}…`;
}

/** A member row's cells: the length in metres to 3 decimals. */
const memberCells = (r: DrawingMemberRow) => [
  r.mark,
  r.kind,
  r.section,
  String(r.count),
  r.lengthMm === undefined ? '' : (r.lengthMm / 1000).toFixed(3),
];

/**
 * The parts list's items: the heading on `at`'s line, item 1 above it, and up. Pending while
 * its view derives; unresolved (only the heading, in red) when the view is gone or failed. Of
 * a building view (DW5c), the list is its member list (部材リスト), its columns the members'.
 */
export function drawingPartsListGraphics(
  a: DrawingPartsList,
  state: DrawingViewState | undefined,
): DrawingAnnotationGraphics {
  if (state?.status === 'pending') return { items: [], status: 'pending' };
  const g = state?.status === 'ready' ? state.graphics : undefined;
  const members = g?.members;
  const columns: readonly { key: string; heading: string; width: number }[] = members
    ? drawingMemberListColumns
    : drawingPartsListColumns;
  const centredKeys = new Set(['item', 'quantity', 'kind', 'count']);
  const rows: string[][] | undefined = members
    ? members.map(memberCells)
    : g
      ? (g.parts?.rows ?? []).map((r) => [
          r.item,
          r.partNumber,
          r.name,
          String(r.quantity),
          r.description,
        ])
      : undefined;
  const h = a.heightMm;
  const rh = drawingPartsListRowHeight(h);
  const [x1, y0] = a.at;
  const x0 = x1 - columns.reduce((w, c) => w + c.width, 0);
  const n = (rows?.length ?? 0) + 1;
  const y1 = y0 + n * rh;
  const items: DrawingItem[] = [];
  const err = !rows;
  const cls = err ? 'error' : 'thick';
  const thin = err ? 'error' : 'thin';
  items.push({
    type: 'polyline',
    points: [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ],
    closed: true,
    cls,
  });
  for (let i = 1; i < n; i++)
    items.push({
      type: 'line',
      a: [x0, y0 + i * rh],
      b: [x1, y0 + i * rh],
      cls: i === 1 ? cls : thin,
    });
  let x = x0;
  for (const c of columns.slice(0, -1)) {
    x += c.width;
    items.push({ type: 'line', a: [x, y0], b: [x, y1], cls: thin });
  }
  const cells = (texts: string[], y: number, first: boolean) => {
    let cx = x0;
    columns.forEach((c, k) => {
      const centred = centredKeys.has(c.key) || first;
      // A length reads from the right.
      const right = !first && c.key === 'length';
      items.push({
        type: 'text',
        at: [centred ? cx + c.width / 2 : right ? cx + c.width - 1.5 : cx + 1.5, y + (rh - h) / 2],
        text: fit(texts[k] ?? '', c.width, h),
        heightMm: h,
        anchor: centred ? 'middle' : right ? 'end' : 'start',
        ...(first && k === 0 ? { id: `note:${a.id}` } : {}),
        ...(err ? { error: true } : {}),
      });
      cx += c.width;
    });
  };
  cells(
    columns.map((c) => c.heading),
    y0,
    true,
  );
  rows?.forEach((r, i) => cells(r, y0 + (i + 1) * rh, false));
  return {
    items,
    status: err ? 'unresolved' : 'ok',
    bounds: [
      [x0, y0],
      [x1, y1],
    ],
  };
}
