import type { DrawingPmiLive } from './pmi';
import type { DrawingDocument, DrawingSheet, DrawingView } from './model';
import type { DrawingEdgeFeature, DrawingViewFrame } from './project';
import { drawingAnnotationGraphics } from './dimensions';
import { drawingParentSymbol } from './symbols';
import {
  drawingLineWidths,
  drawingSheetItems,
  drawingSheetPaper,
  type DrawingItem,
  type DrawingLineClass,
} from './sheet';

/**
 * What a view shows on the paper (paper mm, y up), as the caller derived it (DW2, DW5), with its
 * extent for the label and for picking. A view that is not derived (yet, or it failed) is drawn as
 * a placeholder with its name and the reason.
 */
export interface DrawingViewGraphics {
  items: DrawingItem[];
  bounds: [[number, number], [number, number]];
  /**
   * How the view's plane (model mm) maps to the paper: `origin + (p − center) × scale`; `box` is
   * the projected shape's box in the view plane. A section's cutting line and a detail's circle
   * are drawn on their parent through it.
   */
  frame?: {
    center: [number, number];
    origin: [number, number];
    scale: number;
    box: [[number, number], [number, number]];
    /** The shape's range along the view (model mm), towards the viewer. */
    depth: [number, number];
    /** The view's axes in the model: a model point's view-plane point is (p·right, p·up). */
    axes: DrawingViewFrame;
    /** A detail: the radius (paper mm) of its circle round `at`; nothing outside it is drawn. */
    clipRadius?: number;
  };
  /** The B-rep edges the view keeps (model mm): what dimensions measure and snap to (DW3). */
  features?: DrawingEdgeFeature[];
  /** DW3c-2b: the PMI items of the imported parts the view shows, as they are in its version. */
  pmi?: DrawingPmiLive[];
  /** DW4: the parts of the version the view shows (its flat BOM), for balloons and the list. */
  parts?: DrawingPartsInfo;
  /** DW5c: the members of the building version the view shows, for its member list. */
  members?: DrawingMemberRow[];
}

/**
 * DW5c: one row of a building's member list (部材リスト): a column, beam or member type with
 * how many the version places and their total length.
 */
export interface DrawingMemberRow {
  /** The type's name (the mark on framing drawings). */
  mark: string;
  /** 柱, 梁 or 部材. */
  kind: string;
  /** The section, as `H-700×300×13×24`. */
  section: string;
  count: number;
  /** Absent when no element of the row has a length. */
  lengthMm?: number;
}

/** DW4: one row of a parts list: a part version (or one of the version's own bodies). */
export interface DrawingPartRow {
  /** `1`, `2`…: the number on its balloons. */
  item: string;
  partNumber: string;
  name: string;
  description: string;
  quantity: number;
  /** The row's identity in this version (its occurrences name it). */
  key: string;
  /** DW4b: what its part drawing shows: the version's own body, or a saved part version. */
  bodyId?: string;
  source?: { artifactId: string; versionId: string; contentHash: string };
}
/** DW4: a version's parts list and which row each placed body counts in. */
export interface DrawingPartsInfo {
  rows: DrawingPartRow[];
  /**
   * The bodies by placement path (an occurrence's, empty for the version's own bodies, which
   * also give `bodyId`) and the row they count in. A body in no row (left out of the BOM) has
   * none.
   */
  occurrences: { path: string[]; bodyId?: string; key: string }[];
}
export type DrawingViewState =
  | { status: 'ready'; graphics: DrawingViewGraphics }
  | { status: 'pending' }
  | { status: 'failed'; code: string };

/** The placeholder box of a view without graphics (paper mm). */
export const drawingPlaceholderSize = Object.freeze({ width: 60, height: 40 });

const fmt = (n: number) => {
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
};
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The view's label under it (name and scale), JIS B 0001 style (`A–A  1:2`). */
export function drawingViewLabel(view: DrawingView): string {
  return `${view.name}  ${view.scale}`;
}

/**
 * Appends one by one: a projection may hold more items than a call takes arguments, so
 * `push(...items)` would throw a RangeError on a large view.
 */
function append<T>(out: T[], items: readonly T[]): void {
  for (const it of items) out.push(it);
}

/** The items of a view (its graphics or its placeholder) and of its label, on the paper. */
export function drawingViewItems(
  view: DrawingView,
  state: DrawingViewState | undefined,
  /** The lowest point of what children draw on the view (a cutting line): the label goes under. */
  below = Infinity,
): DrawingItem[] {
  const out: DrawingItem[] = [];
  let bottom: number;
  let middle = view.at[0];
  if (state?.status === 'ready') {
    append(out, state.graphics.items);
    bottom = state.graphics.bounds[0][1];
    middle = (state.graphics.bounds[0][0] + state.graphics.bounds[1][0]) / 2;
  } else {
    const { width: w, height: h } = drawingPlaceholderSize;
    const [x, y] = view.at;
    out.push({
      type: 'polyline',
      points: [
        [x - w / 2, y - h / 2],
        [x + w / 2, y - h / 2],
        [x + w / 2, y + h / 2],
        [x - w / 2, y + h / 2],
      ],
      closed: true,
      cls: 'placeholder',
    });
    const why = state?.status === 'failed' ? `表示できません：${state.code}` : '計算中…';
    out.push({ type: 'text', at: [x, y + 1], text: view.name, heightMm: 3.5, anchor: 'middle' });
    out.push({ type: 'text', at: [x, y - 5], text: why, heightMm: 2.5, anchor: 'middle' });
    bottom = y - h / 2;
  }
  bottom = Math.min(bottom, below);
  if (view.label)
    out.push({
      type: 'text',
      at: [middle, bottom - 7],
      text: drawingViewLabel(view),
      heightMm: 3.5,
      anchor: 'middle',
      id: `label:${view.id}`,
    });
  return out;
}

/** JIS B 0001 line types: hidden lines dashed (3 : 1), centre lines long-dash–dot. */
const dash: Partial<Record<DrawingLineClass, string>> = {
  hidden: '3 1',
  center: '12 1.5 1.5 1.5',
  placeholder: '2 1.5',
};

/** One sheet as SVG (paper mm), from its fixed items, its views' states and its notes. */
export function drawingSheetSvg(
  doc: DrawingDocument,
  sheet: DrawingSheet,
  views: ReadonlyMap<string, DrawingViewState> = new Map(),
): string {
  return drawingItemsSvg(drawingSheetPrint(doc, sheet, views), drawingSheetPaper(sheet));
}

/**
 * Everything one sheet prints (paper mm): its fixed items, its views as they are derived and its
 * notes. SVG, PDF and DXF all write this (DW6).
 */
export function drawingSheetPrint(
  doc: DrawingDocument,
  sheet: DrawingSheet,
  views: ReadonlyMap<string, DrawingViewState> = new Map(),
): DrawingItem[] {
  const items = [...drawingSheetItems(doc, sheet)];
  // Sections' cutting lines and details' circles, on their parents (DW2b).
  const symbols = new Map<string, DrawingItem[]>();
  for (const v of doc.views) {
    if (v.kind !== 'cad-section' && v.kind !== 'cad-detail') continue;
    const parent = doc.views.find((p) => p.id === v.parentId);
    if (parent?.sheetId !== sheet.id) continue;
    const state = views.get(parent.id);
    if (state?.status === 'ready' && state.graphics.frame)
      symbols.set(parent.id, [
        ...(symbols.get(parent.id) ?? []),
        ...drawingParentSymbol(v, state.graphics.frame),
      ]);
  }
  for (const v of doc.views) {
    if (v.sheetId !== sheet.id) continue;
    const own = symbols.get(v.id) ?? [];
    append(items, drawingViewItems(v, views.get(v.id), lowest(own)));
    append(items, own);
  }
  for (const a of doc.annotations) {
    if (a.sheetId !== sheet.id) continue;
    if (a.kind !== 'note') {
      append(items, drawingAnnotationGraphics(doc, a, views).items);
      continue;
    }
    a.text.split('\n').forEach((t, i) =>
      items.push({
        type: 'text',
        at: [a.at[0], a.at[1] - i * a.heightMm * 1.6],
        text: t,
        heightMm: a.heightMm,
        anchor: 'start',
        id: i === 0 ? `note:${a.id}` : undefined,
      }),
    );
  }
  return items;
}

/** The lowest y of items (lines, circles, text), or Infinity. */
function lowest(items: readonly DrawingItem[]): number {
  let y = Infinity;
  for (const it of items)
    if (it.type === 'line') y = Math.min(y, it.a[1], it.b[1]);
    else if (it.type === 'polyline') for (const p of it.points) y = Math.min(y, p[1]);
    else if (it.type === 'circle') y = Math.min(y, it.center[1] - it.radius);
    else if (it.type === 'text') y = Math.min(y, it.at[1]);
  return y;
}

/** Items on a paper of `paper` mm as one SVG document (y flipped to SVG's down). */
export function drawingItemsSvg(items: readonly DrawingItem[], paper: [number, number]): string {
  const [w, h] = paper;
  const X = (x: number) => fmt(x);
  const Y = (y: number) => fmt(h - y);
  const style = Object.entries(drawingLineWidths)
    .map(
      ([cls, width]) =>
        `.${cls}{fill:none;stroke:#000;stroke-width:${width};stroke-linecap:round;stroke-linejoin:round${dash[cls as DrawingLineClass] ? `;stroke-dasharray:${dash[cls as DrawingLineClass]}` : ''}}`,
    )
    .join('');
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w)}mm" height="${fmt(h)}mm" viewBox="0 0 ${fmt(w)} ${fmt(h)}">`,
    `<style>${style}.area{fill:#000;fill-opacity:.12;stroke:none}.dot{fill:#000;stroke:none}.error{stroke:#d00}.error-dot{fill:#d00;stroke:none}.err{fill:#d00}text{font-family:'Noto Sans CJK JP','Noto Sans JP',sans-serif;fill:#000}</style>`,
    `<rect width="${fmt(w)}" height="${fmt(h)}" fill="#fff"/>`,
  ];
  for (const it of items) {
    switch (it.type) {
      case 'line':
        out.push(
          `<line class="${it.cls}" x1="${X(it.a[0])}" y1="${Y(it.a[1])}" x2="${X(it.b[0])}" y2="${Y(it.b[1])}"/>`,
        );
        break;
      case 'segments': {
        let d = '';
        for (let i = 0; i + 3 < it.points.length; i += 4)
          d += `M${X(it.points[i]!)} ${Y(it.points[i + 1]!)}L${X(it.points[i + 2]!)} ${Y(it.points[i + 3]!)}`;
        if (d) out.push(`<path class="${it.cls}" d="${d}"/>`);
        break;
      }
      case 'polyline': {
        const pts = it.points.map((p) => `${X(p[0])},${Y(p[1])}`).join(' ');
        // Only a filled shape fills: an outline in error (a frame's box) stays an outline.
        const cls = it.fill ? (it.cls === 'error' ? 'error-dot' : 'dot') : it.cls;
        out.push(`<${it.closed ? 'polygon' : 'polyline'} class="${cls}" points="${pts}"/>`);
        break;
      }
      case 'circle':
        out.push(
          `<circle class="${it.fill ? 'dot' : it.cls}" cx="${X(it.center[0])}" cy="${Y(it.center[1])}" r="${fmt(it.radius)}"/>`,
        );
        break;
      case 'arc': {
        const sweep = it.end - it.start;
        const p = (t: number) => [
          it.center[0] + it.radius * Math.cos(t),
          it.center[1] + it.radius * Math.sin(t),
        ];
        const [x0, y0] = p(it.start);
        const [x1, y1] = p(it.end);
        const large = ((sweep % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) > Math.PI ? 1 : 0;
        // Counter-clockwise with y up is clockwise on SVG's y down: sweep flag 0.
        out.push(
          `<path class="${it.cls}" d="M${X(x0!)} ${Y(y0!)}A${fmt(it.radius)} ${fmt(it.radius)} 0 ${large} 0 ${X(x1!)} ${Y(y1!)}"/>`,
        );
        break;
      }
      case 'text': {
        const rot = it.rotation
          ? ` transform="rotate(${fmt((-it.rotation * 180) / Math.PI)} ${X(it.at[0])} ${Y(it.at[1])})"`
          : '';
        const id = it.id ? ` data-id="${esc(it.id)}"` : '';
        out.push(
          `<text${it.error ? ' class="err"' : ''} x="${X(it.at[0])}" y="${Y(it.at[1])}" font-size="${fmt(it.heightMm)}" text-anchor="${it.anchor}"${rot}${id}>${esc(it.text)}</text>`,
        );
        break;
      }
      case 'area': {
        const d = it.loops
          .map((l) => `M${l.map((p) => `${X(p[0])} ${Y(p[1])}`).join('L')}Z`)
          .join('');
        out.push(`<path class="area" fill-rule="evenodd" d="${d}"/>`);
        break;
      }
    }
  }
  out.push('</svg>');
  return out.join('\n');
}
