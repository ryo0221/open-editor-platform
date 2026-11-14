import { loopEdges, loopsTouch, loopWithin, pointInLoop, loopDistance } from './geometry';
import {
  pcbCopperLayerNames,
  type PcbComponent,
  type PcbDocument,
  type PcbFootprint,
  type PcbLoop,
  type PcbPad,
  type Vec2,
} from './model';

/** A quarter turn counter-clockwise as a bulge (tan(90° / 4)); a half circle is 1. */
const quarter = Math.tan(Math.PI / 8);

/** A `w` × `h` rectangle centred on the origin with corners rounded by `r` (0 ≤ r ≤ half side). */
function centredRoundRect(w: number, h: number, r: number): PcbLoop {
  const x = w / 2;
  const y = h / 2;
  const rr = Math.min(Math.max(r, 0), x, y);
  if (rr <= 1e-9)
    return [
      [-x, -y],
      [x, -y],
      [x, y],
      [-x, y],
    ];
  const eps = 1e-9;
  if (Math.abs(x - y) <= eps && rr >= x - eps) return circleLoop([0, 0], x);
  // A stadium: the round ends are half circles.
  if (rr >= y - eps && x > y)
    return [
      [-x + y, -y],
      [x - y, -y, 1],
      [x - y, y],
      [-x + y, y, 1],
    ];
  if (rr >= x - eps && y > x)
    return [
      [x, -y + x],
      [x, y - x, 1],
      [-x, y - x],
      [-x, -y + x, 1],
    ];
  return [
    [-x + rr, -y],
    [x - rr, -y, quarter],
    [x, -y + rr],
    [x, y - rr, quarter],
    [x - rr, y],
    [-x + rr, y, quarter],
    [-x, y - rr],
    [-x, -y + rr, quarter],
  ];
}

/** A circle of radius `r` about `c` as two half arcs. */
export function circleLoop(c: Vec2, r: number): PcbLoop {
  return [
    [c[0] + r, c[1], 1],
    [c[0] - r, c[1], 1],
  ];
}

/** The pad's copper outline in its footprint's frame. */
export function padLoop(pad: PcbPad): PcbLoop {
  const quarterTurns = (((Math.round(pad.rotationDeg / 90) % 4) + 4) % 4) as 0 | 1 | 2 | 3;
  const [w, h] = quarterTurns % 2 ? [pad.size[1], pad.size[0]] : pad.size;
  const short = Math.min(w, h);
  const local =
    pad.shape === 'circle'
      ? circleLoop([0, 0], w / 2)
      : pad.shape === 'rect'
        ? centredRoundRect(w, h, 0)
        : pad.shape === 'oval'
          ? centredRoundRect(w, h, short / 2)
          : centredRoundRect(w, h, short * (pad.roundness ?? 0.25));
  const r = (v: number) => Math.round(v * 1e9) / 1e9 + 0;
  return local.map((v) =>
    v.length === 3
      ? [r(v[0] + pad.at[0]), r(v[1] + pad.at[1]), v[2]]
      : [r(v[0] + pad.at[0]), r(v[1] + pad.at[1])],
  );
}

/** Maps a point of the footprint's frame to the board: mirror (bottom), rotate, move. */
export function componentTransform(c: Pick<PcbComponent, 'at' | 'rotationDeg' | 'side'>) {
  const a = (c.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const mirror = c.side === 'bottom' ? -1 : 1;
  const clean = (v: number) => Math.round(v * 1e9) / 1e9 + 0;
  return (p: Vec2): Vec2 => {
    const x = p[0] * mirror;
    return [clean(c.at[0] + x * cos - p[1] * sin), clean(c.at[1] + x * sin + p[1] * cos)];
  };
}
/** A loop of the footprint's frame on the board; a mirror turns every arc the other way. */
export function transformLoop(
  loop: PcbLoop,
  c: Pick<PcbComponent, 'at' | 'rotationDeg' | 'side'>,
): PcbLoop {
  const f = componentTransform(c);
  const flip = c.side === 'bottom' ? -1 : 1;
  return loop.map((v) => {
    const p = f([v[0], v[1]]);
    return v.length === 3 ? [p[0], p[1], v[2] * flip] : p;
  });
}

/** The copper layers a pad of a part on `side` covers. */
export function padCopperLayers(
  pad: Pick<PcbPad, 'type'>,
  side: PcbComponent['side'],
  copperLayers: PcbDocument['board']['copperLayers'],
): string[] {
  if (pad.type === 'npth') return [];
  if (pad.type === 'smd') return [side === 'top' ? 'F.Cu' : 'B.Cu'];
  return pcbCopperLayerNames(copperLayers);
}

export interface PcbPlacedPad {
  component: string;
  ref: string;
  pad: PcbPad;
  /** The pad's centre on the board. */
  at: Vec2;
  loop: PcbLoop;
  layers: string[];
}

/** Every pad of a placed part, on the board. */
export function componentPads(
  doc: PcbDocument,
  c: PcbComponent,
  fp: PcbFootprint | undefined = doc.footprints.find((f) => f.id === c.footprint),
): PcbPlacedPad[] {
  if (!fp) return [];
  const f = componentTransform(c);
  return fp.pads.map((pad) => ({
    component: c.id,
    ref: c.ref,
    pad,
    at: f(pad.at),
    loop: transformLoop(padLoop(pad), c),
    layers: padCopperLayers(pad, c.side, doc.board.copperLayers),
  }));
}
export function componentCourtyard(doc: PcbDocument, c: PcbComponent): PcbLoop | undefined {
  const fp = doc.footprints.find((f) => f.id === c.footprint);
  return fp && transformLoop(fp.courtyard, c);
}

export interface PcbPlacementProblem {
  code: 'courtyard-overlap' | 'part-outside-board' | 'part-over-hole';
  ids: string[];
}
/**
 * Placement problems (PB2): parts on the same side whose courtyards overlap, parts whose
 * courtyard leaves the board, and parts over a mounting hole's keep-out. Shown, not refused:
 * a part is moved through such places while it is being laid out.
 */
export function pcbPlacementProblems(doc: PcbDocument): PcbPlacementProblem[] {
  const out: PcbPlacementProblem[] = [];
  const board = loopEdges(doc.board.outline);
  const cutouts = doc.board.cutouts.map(loopEdges);
  const placed = doc.components.flatMap((c) => {
    const loop = componentCourtyard(doc, c);
    return loop ? [{ c, edges: loopEdges(loop) }] : [];
  });
  for (const { c, edges } of placed) {
    // Off the board's material: over its edge, or over (or inside) a cut-out.
    if (
      loopsTouch(edges, board) ||
      !loopWithin(edges, board) ||
      cutouts.some((k) => loopsTouch(edges, k) || loopWithin(edges, k) || loopWithin(k, edges))
    )
      out.push({ code: 'part-outside-board', ids: [c.id] });
    for (const h of doc.holes) {
      const r = Math.max(h.drillMm, h.keepoutMm) / 2;
      if (pointInLoop(h.at, edges) || loopDistance(h.at, edges) < r)
        out.push({ code: 'part-over-hole', ids: [c.id, h.id] });
    }
  }
  for (let i = 0; i < placed.length; i++)
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i];
      const b = placed[j];
      if (a.c.side !== b.c.side) continue;
      if (
        loopsTouch(a.edges, b.edges) ||
        loopWithin(a.edges, b.edges) ||
        loopWithin(b.edges, a.edges)
      )
        out.push({ code: 'courtyard-overlap', ids: [a.c.id, b.c.id] });
    }
  return out;
}
