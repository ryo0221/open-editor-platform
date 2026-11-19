import type { DrawingGdtCharacteristic, DrawingSymbol, DrawingWeldType, Vec2 } from './model';
import type { DrawingItem } from './sheet';

/**
 * DW3b (docs/cad/drawing-editor.md, 寸法・記号): the drawing symbols on the paper, drawn as lines
 * so they print the same in every font: the geometric tolerance frame (JIS B 0021), the datum
 * (triangle and boxed letter), surface texture (JIS B 0031) and welds (JIS Z 3021, the symbol
 * under the reference line for the arrow side). Sizes follow the text height h: a frame's cells
 * are 2h high.
 */
type Cls = 'dimension' | 'error';

const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const mul = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k];
const len = (a: Vec2) => Math.hypot(a[0], a[1]);
const unit = (a: Vec2): Vec2 => {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l] : [1, 0];
};
const ln = (a: Vec2, b: Vec2, cls: Cls): DrawingItem => ({ type: 'line', a, b, cls });
const poly = (points: Vec2[], closed: boolean, cls: Cls, fill = false): DrawingItem => ({
  type: 'polyline',
  points,
  closed,
  cls,
  ...(fill ? { fill: true } : {}),
});
const text = (
  at: Vec2,
  value: string,
  h: number,
  anchor: 'start' | 'middle' | 'end',
  error = false,
): DrawingItem => ({
  type: 'text',
  at,
  text: value,
  heightMm: h,
  anchor,
  ...(error ? { error: true } : {}),
});
/** A text's width on the paper (as the sheet's notes measure it). */
const width = (value: string, h: number) => [...value].length * h * 0.7;
function arrowHead(tip: Vec2, dir: Vec2, cls: Cls, size = 3): DrawingItem {
  const d = unit(dir);
  const n: Vec2 = [-d[1], d[0]];
  const b = sub(tip, mul(d, size));
  return poly([tip, add(b, mul(n, size / 5)), sub(b, mul(n, size / 5))], true, cls, true);
}

/** A characteristic's symbol in a square of side `s` centred at `c`. */
export function drawingGdtSymbol(
  ch: DrawingGdtCharacteristic,
  c: Vec2,
  s: number,
  cls: Cls,
): DrawingItem[] {
  const [x, y] = c;
  const r = s / 2;
  const P = (dx: number, dy: number): Vec2 => [x + dx * r, y + dy * r];
  switch (ch) {
    case 'straightness':
      return [ln(P(-1, 0), P(1, 0), cls)];
    case 'flatness':
      return [poly([P(-1, -0.5), P(0.5, -0.5), P(1, 0.5), P(-0.5, 0.5)], true, cls)];
    case 'circularity':
      return [{ type: 'circle', center: c, radius: r * 0.8, cls }];
    case 'cylindricity':
      return [
        { type: 'circle', center: c, radius: r * 0.6, cls },
        ln(P(-0.9, -1), P(-0.3, 1), cls),
        ln(P(0.3, -1), P(0.9, 1), cls),
      ];
    case 'profile-line':
      return [{ type: 'arc', center: P(0, -0.4), radius: r * 0.9, start: 0, end: Math.PI, cls }];
    case 'profile-surface':
      return [
        { type: 'arc', center: P(0, -0.4), radius: r * 0.9, start: 0, end: Math.PI, cls },
        ln(P(-0.9, -0.4), P(0.9, -0.4), cls),
      ];
    case 'parallelism':
      return [ln(P(-0.8, -0.9), P(-0.2, 0.9), cls), ln(P(0.2, -0.9), P(0.8, 0.9), cls)];
    case 'perpendicularity':
      return [ln(P(-0.9, -0.8), P(0.9, -0.8), cls), ln(P(0, -0.8), P(0, 0.9), cls)];
    case 'angularity':
      return [ln(P(-0.9, -0.8), P(0.9, -0.8), cls), ln(P(-0.9, -0.8), P(0.7, 0.6), cls)];
    case 'position':
      return [
        { type: 'circle', center: c, radius: r * 0.6, cls },
        ln(P(-1, 0), P(1, 0), cls),
        ln(P(0, -1), P(0, 1), cls),
      ];
    case 'concentricity':
      return [
        { type: 'circle', center: c, radius: r * 0.85, cls },
        { type: 'circle', center: c, radius: r * 0.4, cls },
      ];
    case 'symmetry':
      return [
        ln(P(-0.6, 0.55), P(0.6, 0.55), cls),
        ln(P(-1, 0), P(1, 0), cls),
        ln(P(-0.6, -0.55), P(0.6, -0.55), cls),
      ];
    case 'circular-runout':
      return [ln(P(-0.6, -0.9), P(0.4, 0.7), cls), arrowHead(P(0.5, 0.9), [0.5, 1], cls, r * 0.6)];
    case 'total-runout':
      return [
        ln(P(-0.9, -0.9), P(0.3, -0.9), cls),
        ln(P(-0.9, -0.9), P(-0.3, 0.7), cls),
        ln(P(-0.2, -0.9), P(0.4, 0.7), cls),
        arrowHead(P(-0.2, 0.95), [0.4, 1], cls, r * 0.6),
        arrowHead(P(0.5, 0.95), [0.4, 1], cls, r * 0.6),
      ];
  }
}

/** The leader from a symbol at `from` to the feature at `target`, with its arrow. */
function leader(target: Vec2, from: Vec2, cls: Cls): DrawingItem[] {
  if (len(sub(from, target)) < 0.5) return [];
  return [ln(from, target, cls), arrowHead(target, sub(target, from), cls)];
}

/**
 * A symbol's items: `target` is the point of the shape (paper mm), `at` where the symbol sits.
 * `missing` lists datum letters a frame names that the drawing has no datum for (drawn red).
 */
export function drawingSymbolItems(
  a: DrawingSymbol,
  target: Vec2,
  at: Vec2,
  cls: Cls,
  missing: ReadonlySet<string> = new Set(),
): DrawingItem[] {
  const h = a.heightMm;
  const sym = a.symbol;
  const out: DrawingItem[] = [];
  if (sym.type === 'gdt') {
    // A frame: symbol | [Ø]value [modifier] | datums; `at` is its left edge, mid-height.
    const H = 2 * h;
    const value = `${sym.diameter ? 'Ø' : ''}${sym.tolerance}`;
    const mod = sym.modifier ? 1.5 * h : 0;
    const cells = [
      H,
      width(value, h) + h + mod,
      ...sym.datums.map((d) => Math.max(H, width(d, h) + h)),
    ];
    const total = cells.reduce((s, w) => s + w, 0);
    const [x0, y] = at;
    out.push(
      poly(
        [
          [x0, y - h],
          [x0 + total, y - h],
          [x0 + total, y + h],
          [x0, y + h],
        ],
        true,
        cls,
      ),
    );
    let x = x0;
    cells.forEach((w, i) => {
      if (i) out.push(ln([x, y - h], [x, y + h], cls));
      const mid: Vec2 = [x + w / 2, y];
      if (i === 0) out.push(...drawingGdtSymbol(sym.characteristic, mid, h * 1.2, cls));
      else if (i === 1) {
        out.push(text([x + w / 2 - mod / 2, y - h / 2], value, h, 'middle', cls === 'error'));
        if (sym.modifier) {
          const c: Vec2 = [x + w - h * 0.95, y];
          out.push({ type: 'circle', center: c, radius: h * 0.6, cls });
          out.push(text([c[0], y - h * 0.35], sym.modifier, h * 0.7, 'middle', cls === 'error'));
        }
      } else {
        const d = sym.datums[i - 2]!;
        out.push(text([mid[0], y - h / 2], d, h, 'middle', cls === 'error' || missing.has(d)));
      }
      x += w;
    });
    // The leader leaves from the frame's nearer end.
    // Beside the frame: from that end; over or under it: straight from the facing side, so the
    // leader never crosses the cells (Codex on #1213).
    const from: Vec2 =
      target[0] > x0 + total
        ? [x0 + total, y]
        : target[0] < x0
          ? [x0, y]
          : [target[0], target[1] < y ? y - h : y + h];
    out.push(...leader(target, from, cls));
    return out;
  }
  if (sym.type === 'datum') {
    // A filled triangle on the feature, a line to the boxed letter centred at `at`.
    const u = unit(sub(at, target));
    const n: Vec2 = [-u[1], u[0]];
    const side = h * 1.2;
    const apex = add(target, mul(u, side * 0.87));
    out.push(
      poly([add(target, mul(n, side / 2)), sub(target, mul(n, side / 2)), apex], true, cls, true),
    );
    const H = 2 * h;
    const box = Math.max(H, width(sym.letter, h) + h);
    const [cx, cy] = at;
    // Where the line meets the box: its side towards the triangle.
    const toward = sub(apex, at);
    const k = Math.min(
      Math.abs(toward[0]) > 1e-9 ? box / 2 / Math.abs(toward[0]) : Infinity,
      Math.abs(toward[1]) > 1e-9 ? H / 2 / Math.abs(toward[1]) : Infinity,
    );
    if (k < 1) out.push(ln(apex, add(at, mul(toward, k)), cls));
    out.push(
      poly(
        [
          [cx - box / 2, cy - H / 2],
          [cx + box / 2, cy - H / 2],
          [cx + box / 2, cy + H / 2],
          [cx - box / 2, cy + H / 2],
        ],
        true,
        cls,
      ),
    );
    out.push(text([cx, cy - h / 2], sym.letter, h, 'middle', cls === 'error'));
    return out;
  }
  if (sym.type === 'surface') {
    // The tick with its tip at `at`: a short leg at 60° to the left, a long one to the right.
    const [x, y] = at;
    const k = Math.tan(Math.PI / 3);
    const sh = h * 1.4;
    const lh = h * 2.8;
    const left: Vec2 = [x - sh / k, y + sh];
    const right: Vec2 = [x + lh / k, y + lh];
    out.push(poly([left, at, right], false, cls));
    if (sym.process === 'removal') out.push(ln(left, [x + sh / k, y + sh], cls));
    if (sym.process === 'no-removal')
      out.push({ type: 'circle', center: [x, y + sh * 0.62], radius: sh * 0.36, cls });
    if (sym.text) {
      const w = width(sym.text, h) + h * 0.5;
      out.push(ln(right, [right[0] + w, right[1]], cls));
      out.push(
        text([right[0] + h * 0.25, right[1] - h * 1.3], sym.text, h, 'start', cls === 'error'),
      );
    }
    out.push(...leader(target, at, cls));
    return out;
  }
  // A weld: the arrow line from the joint to `at`, the reference line on from there.
  const dir = target[0] <= at[0] ? 1 : -1;
  const s = h * 1.2;
  const labels = width(sym.size, h) + width(sym.length, h);
  const L = Math.max(20, labels + s + 4 * h);
  const [x, y] = at;
  out.push(ln(target, at, cls), arrowHead(target, sub(target, at), cls));
  out.push(ln(at, [x + dir * L, y], cls));
  // The size reads before the symbol and the length after it, left to right, whichever way the
  // reference line runs (Codex on #1213).
  const cx =
    dir > 0 ? x + width(sym.size, h) + 1.5 * h + s / 2 : x - width(sym.length, h) - 1.5 * h - s / 2;
  const sides = sym.side === 'both' ? [-1, 1] : sym.side === 'arrow' ? [-1] : [1];
  for (const sgn of sides) {
    out.push(...weldSymbol(sym.weld, [cx, y], s, sgn, cls));
    const ty = sgn < 0 ? y - h * 1.3 : y + h * 0.4;
    if (sym.size) out.push(text([cx - s / 2 - h * 0.4, ty], sym.size, h, 'end', cls === 'error'));
    if (sym.length)
      out.push(text([cx + s / 2 + h * 0.4, ty], sym.length, h, 'start', cls === 'error'));
  }
  if (sym.allAround) out.push({ type: 'circle', center: at, radius: h * 0.6, cls });
  if (sym.field) {
    const top: Vec2 = [x, y + h * 2];
    out.push(ln(at, top, cls));
    out.push(poly([top, [x + dir * h * 1.2, y + h * 1.6], [x, y + h * 1.2]], true, cls, true));
  }
  return out;
}

/** A weld symbol on the reference line at `c`: below (`sgn` −1, arrow side) or above (+1). */
function weldSymbol(t: DrawingWeldType, c: Vec2, s: number, sgn: number, cls: Cls): DrawingItem[] {
  const [x, y] = c;
  const v = (dy: number) => y + sgn * dy;
  switch (t) {
    case 'fillet':
      return [
        poly(
          [
            [x - s / 2, y],
            [x - s / 2, v(s)],
            [x + s / 2, y],
          ],
          false,
          cls,
        ),
      ];
    case 'square':
      return [
        ln([x - s / 4, y], [x - s / 4, v(s)], cls),
        ln([x + s / 4, y], [x + s / 4, v(s)], cls),
      ];
    case 'v':
      return [
        poly(
          [
            [x - s / 2, v(s)],
            [x, y],
            [x + s / 2, v(s)],
          ],
          false,
          cls,
        ),
      ];
    case 'bevel':
      return [
        ln([x - s / 4, y], [x - s / 4, v(s)], cls),
        ln([x - s / 4, y], [x + s / 2, v(s)], cls),
      ];
    case 'spot':
      return [{ type: 'circle', center: [x, v(s / 2)], radius: s / 2, cls }];
    case 'plug':
      return [
        poly(
          [
            [x - s / 2, y],
            [x - s / 2, v(s / 2)],
            [x + s / 2, v(s / 2)],
            [x + s / 2, y],
          ],
          false,
          cls,
        ),
      ];
  }
}
