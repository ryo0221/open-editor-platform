import {
  geometryLimits,
  validateGeometry,
  type GeometryGraph,
  type GeometryLoop,
  type GeometryOp,
  type GeometryVec3,
} from '@editor-platform/geometry-core';
import { loopBounds, loopEdges, loopsTouch, loopWithin, roundedRectLoop } from './geometry';
import { pcbChipSizes, pcbGenerators } from './generators';
import { pcbDrillHits } from './gerber';
import type { PcbComponent, PcbDocument, PcbFootprint, PcbLoop, PcbMaskColor } from './model';
import { circleLoop, padLoop } from './placement';

/**
 * The board in 3D (PB7, PCB-U5) as a `geometry-core` op graph the kernel runs: the board is its
 * outline swept by its thickness with the cut-outs and drilled holes through it, and each part
 * is a simplified shape made from its generator's numbers (body, pins, metal shell). Copper,
 * mask and silkscreen are not solids: the view paints them on the board's faces. Units are mm,
 * z up; the board's bottom face is at z = 0 and its top at its thickness.
 */

/** What a part of the model is made of, for its colour and finish. */
export type Pcb3dMaterial =
  | 'board'
  | 'plastic'
  | 'plastic-light'
  | 'metal'
  | 'gold'
  | 'ceramic'
  | 'substrate';

export interface Pcb3dPart {
  /** The graph node that makes it (a solid, or a compound of solids). */
  node: string;
  /** "Board", or a part's reference and what the piece is ("J8 shell"). */
  name: string;
  /** The placed part it belongs to; absent for the board. */
  component?: string;
  /** PB8: the stacked board entry it belongs to; absent for this board's own pieces. */
  stacked?: string;
  material: Pcb3dMaterial;
  /** sRGB `#rrggbb`. */
  color: string;
}

export interface Pcb3dModel {
  graph: GeometryGraph;
  parts: Pcb3dPart[];
  /** Holes the board solid was not given (past the kernel's hole limit), drawn on its faces. */
  omittedHoles: number;
}

export const pcbMaskRgb: Record<PcbMaskColor, string> = {
  green: '#1f6b3a',
  red: '#9b1c1c',
  blue: '#1d3f8f',
  black: '#1b1b1b',
  white: '#e6e6e6',
  purple: '#5b2a86',
};
const colors: Record<Exclude<Pcb3dMaterial, 'board'>, string> = {
  plastic: '#222222',
  'plastic-light': '#e8e0cc',
  metal: '#c9cacd',
  gold: '#d4a73a',
  ceramic: '#2a2a2a',
  substrate: '#2c4a3e',
};

type Box = [x0: number, y0: number, x1: number, y1: number];
type Op = GeometryOp;

const up: GeometryVec3 = [0, 0, 1];
const xAxis: GeometryVec3 = [1, 0, 0];
const rect = ([x0, y0, x1, y1]: Box): GeometryLoop => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];
/** A box from `b` (plan) and `z0`..`z1`. */
const block = (b: Box, z0: number, z1: number): Op => ({
  op: 'prism',
  frame: { origin: [0, 0, z0], x: xAxis, z: up },
  outer: rect(b),
  vector: [0, 0, z1 - z0],
});
/**
 * A tube along +y from `y0` to `y1`: a `w` × `h` rounded rectangle (corner `r`) about
 * (0, zc), with a wall `wall` thick, open at both ends (a connector's metal shell).
 */
const tube = (
  w: number,
  h: number,
  r: number,
  zc: number,
  y0: number,
  y1: number,
  wall: number,
) => {
  // The plane's y is z × x = -z of the model, so the loop is drawn upside down; it is symmetric.
  // A full round end makes a side of zero length: its vertex is dropped.
  const loop = (ww: number, hh: number, rr: number) =>
    (roundedRectLoop([-ww / 2, -hh / 2], ww, hh, rr) as GeometryLoop).filter((v, i, l) => {
      const n = l[(i + 1) % l.length]!;
      return Math.hypot(n[0] - v[0], n[1] - v[1]) > 1e-9;
    });
  const op: Op = {
    op: 'prism',
    frame: { origin: [0, y0, zc], x: xAxis, z: [0, 1, 0] },
    outer: loop(w, h, r),
    holes: [loop(w - 2 * wall, h - 2 * wall, Math.max(0, r - wall))],
    vector: [0, y1 - y0, 0],
  };
  return op;
};

/** A part's pieces in its footprint's frame: z = 0 on the board's face, up away from it. */
interface Piece {
  role: string;
  material: Exclude<Pcb3dMaterial, 'board'>;
  ops: Op[];
  /** Openings cut from the piece's single op (a connector's ports). */
  cuts?: Op[];
}

const num = (fp: PcbFootprint, k: string, fallback: number) => {
  const v = fp.generator?.params[k];
  return typeof v === 'number' ? v : fallback;
};

/** The parts of each pad outside `b`, `z0`..`z1` thick: a lead's foot or a tail. */
function feet(fp: PcbFootprint, b: Box, z1: number): Op[] {
  const out: Op[] = [];
  for (const p of fp.pads) {
    if (p.type !== 'smd' || p.number === 'EP') continue;
    const [px0, py0, px1, py1] = loopBounds(padLoop(p));
    // The part of the pad's box beyond the body's side it leaves from.
    let f: Box | undefined;
    if (px1 > b[2] + 1e-6 && px0 >= b[0]) f = [Math.max(px0, b[2]), py0, px1, py1];
    else if (px0 < b[0] - 1e-6 && px1 <= b[2]) f = [px0, py0, Math.min(px1, b[0]), py1];
    else if (py1 > b[3] + 1e-6 && py0 >= b[1]) f = [px0, Math.max(py0, b[3]), px1, py1];
    else if (py0 < b[1] - 1e-6 && py1 <= b[3]) f = [px0, py0, px1, Math.min(py1, b[1])];
    if (!f || f[2] - f[0] < 0.01 || f[3] - f[1] < 0.01) continue;
    // A little narrower than the pad, as a lead sits on it.
    const shrink = (lo: number, hi: number) => {
      const m = Math.min(0.05, (hi - lo) / 4);
      return [lo + m, hi - m] as const;
    };
    const [x0, x1] = shrink(f[0], f[2]);
    const [y0, y1] = shrink(f[1], f[3]);
    out.push(block([x0, y0, x1, y1], 0, z1));
  }
  return out;
}

/** The courtyard's box at the part's height: a part its generator cannot describe. */
function courtyardPiece(fp: PcbFootprint): Piece[] {
  const [x0, y0, x1, y1] = loopBounds(fp.courtyard);
  return [{ role: 'body', material: 'plastic', ops: [block([x0, y0, x1, y1], 0, fp.heightMm)] }];
}

/**
 * A footprint's pieces from its generator's numbers. The numbers are checked by the generator
 * itself first (a document may carry any finite numbers), and the pieces by `validateGeometry`:
 * a part they cannot describe, or one without a generator, is its courtyard's box at its height.
 * `thickness` is the board's, for pins through it.
 */
function footprintPieces(fp: PcbFootprint, ref: string, thickness: number): Piece[] {
  if (!(fp.heightMm > 0)) return [];
  const g = fp.generator;
  const spec = g && pcbGenerators.get(g.kind);
  if (!spec) return courtyardPiece(fp);
  try {
    spec.make(g.params as Record<string, number | string>);
  } catch {
    return courtyardPiece(fp);
  }
  const pieces = generatorPieces(fp, ref, thickness);
  const nodes: Record<string, GeometryOp> = {};
  pieces.forEach((p, i) =>
    [...p.ops, ...(p.cuts ?? [])].forEach((op, k) => (nodes[`${i}:${k}`] = op)),
  );
  return validateGeometry({ nodes }).length ? courtyardPiece(fp) : pieces;
}

function generatorPieces(fp: PcbFootprint, ref: string, thickness: number): Piece[] {
  const h = fp.heightMm;
  const kind = fp.generator?.kind;
  switch (kind) {
    case 'pin-header': {
      const pitch = num(fp, 'pitch', 2.54);
      const rows = num(fp, 'rows', 2);
      const n = num(fp, 'pinsPerRow', 20);
      const half = pitch / 2;
      const base = Math.min(2.5, h / 2);
      const pin = Math.min(0.64, pitch * 0.4) / 2;
      return [
        {
          role: 'body',
          material: 'plastic',
          ops: [block([-half, -half, (n - 1) * pitch + half, (rows - 1) * pitch + half], 0, base)],
        },
        {
          role: 'pins',
          material: 'gold',
          ops: fp.pads
            .filter((p) => p.type === 'thru')
            .map((p) =>
              block(
                [p.at[0] - pin, p.at[1] - pin, p.at[0] + pin, p.at[1] + pin],
                -(thickness + 3),
                h,
              ),
            ),
        },
      ];
    }
    case 'chip': {
      const size = fp.generator?.params.size;
      const [l, w] = pcbChipSizes[typeof size === 'string' ? size : '']?.body ?? [
        Math.max(0.4, loopBounds(fp.courtyard)[2] - loopBounds(fp.courtyard)[0] - 0.5),
        Math.max(0.2, loopBounds(fp.courtyard)[3] - loopBounds(fp.courtyard)[1] - 0.5),
      ];
      const cap = l * 0.2;
      const letters = ref.replace(/[^A-Za-z]/g, '').toUpperCase();
      const material: Piece['material'] =
        letters === 'C' || letters === 'D' || letters === 'LED' ? 'plastic-light' : 'ceramic';
      return [
        { role: 'body', material, ops: [block([-l / 2 + cap, -w / 2, l / 2 - cap, w / 2], 0, h)] },
        {
          role: 'terminals',
          material: 'metal',
          ops: [
            block([-l / 2, -w / 2, -l / 2 + cap, w / 2], 0, h),
            block([l / 2 - cap, -w / 2, l / 2, w / 2], 0, h),
          ],
        },
      ];
    }
    case 'soic':
    case 'qfn': {
      const bx = kind === 'soic' ? num(fp, 'bodyWidth', 3.9) / 2 : num(fp, 'size', 5) / 2;
      let by = bx;
      if (kind === 'soic') {
        const ys = fp.pads.map((p) => Math.abs(p.at[1]));
        by = Math.max(...ys) + num(fp, 'pitch', 1.27) / 2 + 0.2;
      }
      const b: Box = [-bx, -by, bx, by];
      const lift = kind === 'soic' ? Math.min(0.1, h / 4) : 0;
      const legs = feet(fp, b, kind === 'soic' ? Math.min(0.25, h / 3) : Math.min(0.1, h / 3));
      return [
        { role: 'body', material: 'plastic', ops: [block(b, lift, h)] },
        ...(legs.length ? [{ role: 'leads', material: 'metal' as const, ops: legs }] : []),
      ];
    }
    case 'bga': {
      const bx = num(fp, 'bodyX', 10) / 2;
      const by = num(fp, 'bodyY', 10) / 2;
      const ball = Math.min(0.3, h / 4);
      const sub = Math.min(ball + 0.35, h * 0.6);
      const inset = Math.min(0.3, bx / 4, by / 4);
      return [
        { role: 'substrate', material: 'substrate', ops: [block([-bx, -by, bx, by], ball, sub)] },
        {
          role: 'body',
          material: 'plastic',
          ops: [block([-bx + inset, -by + inset, bx - inset, by - inset], sub, h)],
        },
      ];
    }
    case 'fpc': {
      const pitch = num(fp, 'pitch', 0.5);
      const n = num(fp, 'pins', 22);
      const bx = ((n - 1) * pitch) / 2 + 1.8;
      const base = h * 0.7;
      const b: Box = [-bx, 0.4, bx, 4.2];
      return [
        { role: 'body', material: 'plastic-light', ops: [block(b, 0, base)] },
        { role: 'actuator', material: 'plastic', ops: [block([-bx, 2.6, bx, 4.2], base, h)] },
        { role: 'leads', material: 'metal', ops: feet(fp, b, 0.15) },
      ];
    }
    case 'jst-sh': {
      const n = num(fp, 'pins', 4);
      const span = n - 1;
      const bx = span / 2 + 1.5;
      return [
        {
          role: 'body',
          material: 'plastic-light',
          ops: [block([-bx, 0, bx, 4.25], 0, h)],
          cuts: [block([-span / 2 - 0.45, -0.01, span / 2 + 0.45, 3.0], 0.6, h - 0.4)],
        },
      ];
    }
    case 'usb-c':
      return [
        { role: 'shell', material: 'metal', ops: [tube(8.94, 3.2, 1.6, 1.6, 0, 7.35, 0.25)] },
        { role: 'tongue', material: 'plastic', ops: [block([-3.3, 0.8, 3.3, 7.1], 1.25, 1.95)] },
      ];
    case 'micro-hdmi':
      return [
        { role: 'shell', material: 'metal', ops: [tube(7.5, 3.0, 0.6, 1.7, 0, 6.6, 0.25)] },
        { role: 'tongue', material: 'plastic', ops: [block([-2.9, 0.8, 2.9, 6.3], 1.4, 2.0)] },
      ];
    case 'usb-a-stack': {
      const ports = [
        [1.9, 7.0],
        [9.0, 14.1],
      ] as const;
      return [
        {
          role: 'shell',
          material: 'metal',
          ops: [block([-7.25, -2, 7.25, 15.5], 0, h)],
          cuts: ports.map(([z0, z1]) => block([-6.0, -2.01, 6.0, 12], z0, z1)),
        },
        {
          role: 'tongues',
          material: 'plastic',
          ops: ports.map(([z0]) => block([-5.5, -1.2, 5.5, 12], z0 + 1.6, z0 + 3.4)),
        },
      ];
    }
    case 'rj45':
      return [
        {
          role: 'shell',
          material: 'metal',
          ops: [block([-8, -2, 8, 19.3], 0, h)],
          cuts: [block([-5.85, -2.01, 5.85, 12], 1.5, 10)],
        },
        { role: 'insert', material: 'plastic', ops: [block([-5.85, 6, 5.85, 12], 1.5, 10)] },
      ];
    default:
      return courtyardPiece(fp);
  }
}

/** The rotation (row-major) and translation that place a part's frame on the board. */
function placement(c: PcbComponent, thickness: number) {
  const a = (c.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const clean = (v: number) => Math.round(v * 1e12) / 1e12 + 0;
  // Bottom: a half turn about y (x mirrored, z down) before the turn about z.
  const rotation =
    c.side === 'top'
      ? [cos, -sin, 0, sin, cos, 0, 0, 0, 1]
      : [-cos, -sin, 0, -sin, cos, 0, 0, 0, -1];
  return {
    rotation: rotation.map(clean),
    translation: [c.at[0], c.at[1], c.side === 'top' ? thickness : 0] as GeometryVec3,
  };
}

/** The board's drilled holes that fit in it, apart from each other and from the cut-outs. */
function boardHoles(doc: PcbDocument): { holes: PcbLoop[]; omitted: number } {
  const outline = loopEdges(doc.board.outline);
  const taken: { box: Box; edges: ReturnType<typeof loopEdges> }[] = doc.board.cutouts.map((c) => ({
    box: loopBounds(c),
    edges: loopEdges(c),
  }));
  const { plated, unplated } = pcbDrillHits(doc);
  const vias = new Set(doc.vias.map((v) => `${v.at[0]},${v.at[1]}`));
  // Holes of parts and the board first, then vias while the limit allows.
  const hits = [...plated, ...unplated].sort(
    (a, b) =>
      Number(vias.has(`${a.at[0]},${a.at[1]}`)) - Number(vias.has(`${b.at[0]},${b.at[1]}`)) ||
      b.drillMm - a.drillMm,
  );
  const room = geometryLimits.holes - doc.board.cutouts.length;
  const holes: PcbLoop[] = [...doc.board.cutouts];
  let omitted = 0;
  for (const h of hits) {
    const r = h.drillMm / 2;
    const loop = circleLoop(h.at, r);
    const box: Box = [h.at[0] - r, h.at[1] - r, h.at[0] + r, h.at[1] + r];
    const edges = loopEdges(loop);
    const clash = taken.some(
      (t) =>
        t.box[0] <= box[2] &&
        box[0] <= t.box[2] &&
        t.box[1] <= box[3] &&
        box[1] <= t.box[3] &&
        (loopsTouch(t.edges, edges) || loopWithin(edges, t.edges) || loopWithin(t.edges, edges)),
    );
    if (clash || loopsTouch(edges, outline) || !loopWithin(edges, outline)) continue;
    if (holes.length - doc.board.cutouts.length >= room) {
      omitted++;
      continue;
    }
    taken.push({ box, edges });
    holes.push(loop);
  }
  return { holes, omitted };
}

/** The board and its parts as an op graph, with one entry per coloured piece. */
export function pcbModel3d(doc: PcbDocument): Pcb3dModel {
  const nodes: Record<string, GeometryOp> = {};
  const parts: Pcb3dPart[] = [];
  const t = doc.board.thicknessMm;
  const { holes, omitted } = boardHoles(doc);
  nodes.board = {
    op: 'prism',
    frame: { origin: [0, 0, 0], x: xAxis, z: up },
    outer: doc.board.outline as GeometryLoop,
    ...(holes.length ? { holes: holes as GeometryLoop[] } : {}),
    vector: [0, 0, t],
  };
  parts.push({
    node: 'board',
    name: 'Board',
    material: 'board',
    color: pcbMaskRgb[doc.board.maskColor],
  });
  const footprints = new Map(doc.footprints.map((f) => [f.id, f]));
  for (const c of doc.components) {
    const fp = footprints.get(c.footprint);
    if (!fp) continue;
    const place = placement(c, t);
    for (const piece of footprintPieces(fp, c.ref, t)) {
      if (!piece.ops.length) continue;
      const base = `${c.id}\u0000${piece.role}`;
      const ids = piece.ops.map((op, i) => {
        const id = `${base}\u0000${i}`;
        nodes[id] = op;
        return id;
      });
      let local = ids.length === 1 ? ids[0]! : `${base}\u0000all`;
      if (ids.length > 1) nodes[local] = { op: 'compound', inputs: ids };
      if (piece.cuts?.length) {
        const tools = piece.cuts.map((op, i) => {
          const id = `${base}\u0000cut${i}`;
          nodes[id] = op;
          return id;
        });
        const cut = `${base}\u0000cut`;
        nodes[cut] = { op: 'boolean', kind: 'cut', target: local, tools };
        local = cut;
      }
      nodes[base] = { op: 'transform', input: local, ...place };
      parts.push({
        node: base,
        name: `${c.ref} ${piece.role}`,
        component: c.id,
        material: piece.material,
        color: colors[piece.material],
      });
    }
  }
  return { graph: { nodes }, parts, omittedHoles: omitted };
}
