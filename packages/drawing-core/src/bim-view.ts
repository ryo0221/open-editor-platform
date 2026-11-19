import { drawingScaleFactor, type DrawingBuildingView, type Vec2 } from './model';
import type { DrawingItem, DrawingLineClass } from './sheet';
import type { DrawingMemberRow, DrawingViewGraphics } from './svg';

/**
 * DW5a (docs/cad/drawing-editor.md, 施工図): a building version's plan or section on the sheet. The
 * Host draws it as the building editor does (the kernel cuts each element, what lies beyond is
 * projected with hidden lines removed, the symbols come from the building's own drawing rules)
 * and hands over the result; this places it on the paper in the drawing's line classes.
 *
 * The shape here is the building editor's drawing (`BimDrawing` of `bim-core`), read by
 * structure: `drawing-core` does not depend on the building packages.
 */
export type DrawingBimItem =
  | { type: 'polygon'; loops: Vec2[][]; open?: Vec2[][]; cls: string; id: string }
  | { type: 'segments'; points: number[]; cls: string }
  | { type: 'line'; a: Vec2; b: Vec2; cls: string; id?: string }
  | {
      type: 'arc';
      center: Vec2;
      radius: number;
      start: number;
      end: number;
      cls: string;
      id?: string;
    }
  | { type: 'circle'; center: Vec2; radius: number; cls: string }
  | {
      type: 'text';
      at: Vec2;
      text: string;
      anchor: 'start' | 'middle' | 'end';
      cls: string;
      id?: string;
    };
export interface DrawingBimDrawing {
  /** In the building view's own coordinates: model mm, y up. */
  items: DrawingBimItem[];
  /** Elements the Host could not draw: listed under the view, never left out silently. */
  failed: { id: string; code: string }[];
  /** DW5c: the version's members, for the view's member list (部材リスト). */
  members?: DrawingMemberRow[];
}

/** The building editor's text height on paper (`bimDrawingPaper.textMm`). */
const TEXT_MM = 2.5;
/** Failed elements listed under a view, at most. */
const FAILED_LINES = 5;

/** A building drawing's class as a drawing line class (JIS A 0150: cut lines thick). */
function lineClass(cls: string): DrawingLineClass {
  const c = cls.split(/\s+/);
  if (c.includes('cut')) return 'thick';
  // DW5b: a framing drawing's members, as centre lines drawn heavy (JIS A 0150 伏図).
  if (c.includes('member')) return 'thick';
  if (c.includes('grid')) return 'center';
  if (c.includes('stair-above')) return 'hidden';
  if (c.includes('level') || c.includes('dimension')) return 'dimension';
  return 'thin';
}

/**
 * The building drawing on the paper: its line items' box centred on the view's `at`, at the
 * view's scale. Text keeps the building editor's paper size. The view is not dimensioned against
 * shapes (no `frame` or `features`): its grid and level annotations are the building's own.
 */
export function drawingBimViewGraphics(
  view: Pick<DrawingBuildingView, 'at' | 'scale'>,
  d: DrawingBimDrawing,
): DrawingViewGraphics {
  const s = drawingScaleFactor(view.scale);
  // The box of what is drawn (text has its paper size, so it does not set the centre).
  const lo: Vec2 = [Infinity, Infinity];
  const hi: Vec2 = [-Infinity, -Infinity];
  const grow = (p: Vec2, r = 0) => {
    lo[0] = Math.min(lo[0], p[0] - r);
    lo[1] = Math.min(lo[1], p[1] - r);
    hi[0] = Math.max(hi[0], p[0] + r);
    hi[1] = Math.max(hi[1], p[1] + r);
  };
  for (const it of d.items)
    if (it.type === 'polygon')
      [...it.loops, ...(it.open ?? [])].forEach((l) => l.forEach((p) => grow(p)));
    else if (it.type === 'segments')
      for (let i = 0; i + 1 < it.points.length; i += 2) grow([it.points[i]!, it.points[i + 1]!]);
    else if (it.type === 'line') {
      grow(it.a);
      grow(it.b);
    } else if (it.type === 'circle') grow(it.center, it.radius);
    else if (it.type === 'arc') arcPoints(it).forEach((p) => grow(p));
  const center: Vec2 = lo[0] === Infinity ? [0, 0] : [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
  const P = (p: Vec2): Vec2 => [
    view.at[0] + (p[0] - center[0]) * s,
    view.at[1] + (p[1] - center[1]) * s,
  ];
  const items: DrawingItem[] = [];
  for (const it of d.items)
    switch (it.type) {
      case 'polygon': {
        const loops = it.loops.filter((l) => l.length >= 3).map((l) => l.map(P));
        if (loops.length) items.push({ type: 'area', loops, cls: 'cut' });
        for (const l of loops)
          items.push({ type: 'polyline', points: l, closed: true, cls: 'thick' });
        for (const l of it.open ?? [])
          if (l.length >= 2)
            items.push({ type: 'polyline', points: l.map(P), closed: false, cls: 'thick' });
        break;
      }
      case 'segments': {
        const points: number[] = [];
        for (let i = 0; i + 1 < it.points.length; i += 2)
          points.push(...P([it.points[i]!, it.points[i + 1]!]));
        if (points.length >= 4) items.push({ type: 'segments', points, cls: lineClass(it.cls) });
        break;
      }
      case 'line':
        items.push({ type: 'line', a: P(it.a), b: P(it.b), cls: lineClass(it.cls) });
        break;
      case 'arc':
        items.push({
          type: 'arc',
          center: P(it.center),
          radius: it.radius * s,
          start: it.start,
          end: it.end,
          cls: lineClass(it.cls),
        });
        break;
      case 'circle':
        items.push({
          type: 'circle',
          center: P(it.center),
          radius: it.radius * s,
          cls: lineClass(it.cls),
        });
        break;
      case 'text': {
        // The building editor centres its text on `at`; the paper's text sits on its baseline.
        const [x, y] = P(it.at);
        items.push({
          type: 'text',
          at: [x, y - TEXT_MM * 0.35],
          text: it.text,
          heightMm: TEXT_MM,
          anchor: it.anchor,
          ...(it.id ? { id: it.id } : {}),
        });
        break;
      }
    }
  // The box on the paper, text included.
  const plo: Vec2 = [Infinity, Infinity];
  const phi: Vec2 = [-Infinity, -Infinity];
  const pgrow = (x: number, y: number) => {
    plo[0] = Math.min(plo[0], x);
    plo[1] = Math.min(plo[1], y);
    phi[0] = Math.max(phi[0], x);
    phi[1] = Math.max(phi[1], y);
  };
  for (const it of items)
    if (it.type === 'line') {
      pgrow(...it.a);
      pgrow(...it.b);
    } else if (it.type === 'segments')
      for (let i = 0; i + 1 < it.points.length; i += 2) pgrow(it.points[i]!, it.points[i + 1]!);
    else if (it.type === 'polyline') it.points.forEach((p) => pgrow(...p));
    else if (it.type === 'circle') {
      pgrow(it.center[0] - it.radius, it.center[1] - it.radius);
      pgrow(it.center[0] + it.radius, it.center[1] + it.radius);
    } else if (it.type === 'arc') arcPoints(it).forEach((p) => pgrow(...p));
    else if (it.type === 'text') {
      const w = textWidth(it.text, it.heightMm);
      const x0 =
        it.anchor === 'start' ? it.at[0] : it.anchor === 'end' ? it.at[0] - w : it.at[0] - w / 2;
      pgrow(x0, it.at[1]);
      pgrow(x0 + w, it.at[1] + it.heightMm);
    }
  if (plo[0] === Infinity) {
    pgrow(view.at[0] - 10, view.at[1] - 10);
    pgrow(view.at[0] + 10, view.at[1] + 10);
  }
  // What could not be drawn, in red under the view.
  if (d.failed.length) {
    const lines = d.failed
      .slice(0, FAILED_LINES)
      .map((f) => `描けない要素 Not drawn: ${f.id} (${f.code})`);
    if (d.failed.length > FAILED_LINES)
      lines.push(
        `ほか ${d.failed.length - FAILED_LINES} 件 and ${d.failed.length - FAILED_LINES} more`,
      );
    lines.forEach((text, i) => {
      const y = plo[1] - 4 - (i + 1) * TEXT_MM * 1.5;
      items.push({
        type: 'text',
        at: [plo[0], y],
        text,
        heightMm: TEXT_MM,
        anchor: 'start',
        error: true,
      });
      // Its width in the bounds too, so nothing is placed over it (Codex on #1237).
      phi[0] = Math.max(phi[0], plo[0] + textWidth(text, TEXT_MM));
    });
    plo[1] -= 4 + lines.length * TEXT_MM * 1.5;
  }
  return { items, bounds: [plo, phi], ...(d.members ? { members: d.members } : {}) };
}

/** A text's width on paper: a full em for a wide (Japanese) character, 0.6 for the rest. */
function textWidth(text: string, h: number): number {
  let w = 0;
  for (const ch of text) w += (ch.codePointAt(0)! > 0x2e7f ? 1 : 0.6) * h;
  return w;
}

/**
 * What bounds an arc: its ends and each quarter point its counter-clockwise sweep passes (as
 * `bimDrawingBounds` does), not its whole circle (Codex on #1237).
 */
function arcPoints(a: { center: Vec2; radius: number; start: number; end: number }): Vec2[] {
  const on = (t: number): Vec2 => [
    a.center[0] + a.radius * Math.cos(t),
    a.center[1] + a.radius * Math.sin(t),
  ];
  let sweep = a.end - a.start;
  while (sweep < 0) sweep += 2 * Math.PI;
  const out = [on(a.start), on(a.start + sweep)];
  for (let k = Math.ceil(a.start / (Math.PI / 2)); k * (Math.PI / 2) < a.start + sweep; k++)
    out.push(on(k * (Math.PI / 2)));
  return out;
}
