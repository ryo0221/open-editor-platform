import type { DrawingCadDetail, DrawingCadSection, Vec2 } from './model';
import type { DrawingItem } from './sheet';
import type { DrawingViewGraphics } from './svg';

type Frame = NonNullable<DrawingViewGraphics['frame']>;

/**
 * What a section or a detail draws on its parent (JIS B 0001, DW2b): a section's cutting line
 * (a thin chain line, thick at its ends, with arrows showing which way it is seen and its mark at
 * both ends), or a detail's thin circle and its mark.
 */
export function drawingParentSymbol(
  view: DrawingCadSection | DrawingCadDetail,
  frame: Frame,
): DrawingItem[] {
  const paper = (p: Vec2): Vec2 => [
    frame.origin[0] + (p[0] - frame.center[0]) * frame.scale,
    frame.origin[1] + (p[1] - frame.center[1]) * frame.scale,
  ];
  const out: DrawingItem[] = [];
  if (view.kind === 'cad-detail') {
    const c = paper(view.center);
    const r = view.radius * frame.scale;
    out.push({ type: 'circle', center: c, radius: r, cls: 'thin' });
    out.push({
      type: 'text',
      at: [c[0] + r * 0.75 + 1.5, c[1] + r * 0.75 + 1.5],
      text: view.mark,
      heightMm: 5,
      anchor: 'start',
    });
    return out;
  }
  const a = paper(view.line[0]);
  const b = paper(view.line[1]);
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const u: Vec2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  // The way the section is seen: to the right of a → b.
  const n: Vec2 = [u[1], -u[0]];
  out.push({ type: 'line', a, b, cls: 'center' });
  const end = Math.min(6, len / 3);
  out.push({ type: 'line', a, b: [a[0] + u[0] * end, a[1] + u[1] * end], cls: 'cut' });
  out.push({ type: 'line', a: [b[0] - u[0] * end, b[1] - u[1] * end], b, cls: 'cut' });
  for (const [p, inward] of [
    [a, 1],
    [b, -1],
  ] as const) {
    // The arrow starts 2 mm in from the line's end, 7 mm long, its head 3 mm.
    const base: Vec2 = [p[0] + u[0] * 2 * inward, p[1] + u[1] * 2 * inward];
    const tip: Vec2 = [base[0] + n[0] * 7, base[1] + n[1] * 7];
    out.push({ type: 'line', a: base, b: tip, cls: 'thin' });
    const h: Vec2 = [tip[0] - n[0] * 3, tip[1] - n[1] * 3];
    out.push({
      type: 'polyline',
      points: [tip, [h[0] + u[0] * 1, h[1] + u[1] * 1], [h[0] - u[0] * 1, h[1] - u[1] * 1]],
      closed: true,
      cls: 'thin',
      fill: true,
    });
    // The mark beyond the arrow's head.
    out.push({
      type: 'text',
      // The text's baseline: centred beside a sideways arrow, under or over a vertical one.
      at: [tip[0] + n[0] * 3, tip[1] + n[1] * 3 + (n[1] < -0.7 ? -5 : n[1] > 0.7 ? 0 : -1.75)],
      text: view.mark,
      heightMm: 5,
      anchor: 'middle',
    });
  }
  return out;
}
