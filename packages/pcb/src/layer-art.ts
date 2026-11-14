import {
  componentPads,
  componentTransform,
  loopBounds,
  padPolygon,
  pcbDrillHits,
  pcbMaskRgb,
  type PcbDocument,
  type PcbSide,
  type PcbZoneFill,
  type Vec2,
} from '@editor-platform/pcb-core';

/**
 * What one side of the board looks like (PB7b), as plain shapes in board millimetres: the mask
 * over the board, copper seen through the mask, pads where the mask is open, the silkscreen,
 * and the drilled holes (clear). The 3D view paints it on the board's face and GLB carries the
 * picture; both sides are drawn in plan coordinates seen from the top.
 */
export type PcbArtShape =
  | { kind: 'polygon'; polygons: Vec2[][]; color: string }
  | { kind: 'line'; from: Vec2; to: Vec2; widthMm: number; color: string }
  | { kind: 'disc'; at: Vec2; radiusMm: number; color: string }
  | { kind: 'ring'; at: Vec2; radiusMm: number; widthMm: number; color: string }
  | { kind: 'hole'; at: Vec2; radiusMm: number };

export interface PcbSideArt {
  /** The board outline's box, mm: the picture's extent. */
  bounds: [number, number, number, number];
  shapes: PcbArtShape[];
}

const finishRgb = { enig: '#d8b04c', hasl: '#c9cbcf' } as const;
const silkRgb = { white: '#f2f2ec', black: '#1c1c1c' } as const;

/** A colour between `a` and `b` (#rrggbb), `t` of the way to `b`. */
export function mixRgb(a: string, b: string, t: number): string {
  const p = (s: string) => [1, 3, 5].map((i) => Number.parseInt(s.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return `#${x
    .map((v, i) =>
      Math.round(v + (y[i]! - v) * t)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

export function pcbSideArt(doc: PcbDocument, fills: PcbZoneFill[], side: PcbSide): PcbSideArt {
  const layer = side === 'top' ? 'F.Cu' : 'B.Cu';
  const mask = pcbMaskRgb[doc.board.maskColor];
  // Copper under the mask shows as a lighter tint of it.
  const covered = mixRgb(mask, '#d9a441', 0.28);
  const shapes: PcbArtShape[] = [
    { kind: 'polygon', polygons: [padPolygon(doc.board.outline)], color: mask },
  ];
  for (const f of fills) {
    if (f.layer !== layer) continue;
    shapes.push({
      kind: 'polygon',
      polygons: f.trapezoids.map((t) => [
        [t.xl0, t.y0],
        [t.xr0, t.y0],
        [t.xr1, t.y1],
        [t.xl1, t.y1],
      ]),
      color: covered,
    });
  }
  for (const t of doc.tracks)
    if (t.layer === layer)
      shapes.push({ kind: 'line', from: t.from, to: t.to, widthMm: t.widthMm, color: covered });
  for (const v of doc.vias)
    shapes.push({ kind: 'disc', at: v.at, radiusMm: v.diameterMm / 2, color: covered });
  const silk = silkRgb[doc.board.silkColor];
  const footprints = new Map(doc.footprints.map((f) => [f.id, f]));
  for (const c of doc.components) {
    const fp = footprints.get(c.footprint);
    if (!fp || c.side !== side) continue;
    const f = componentTransform(c);
    for (const g of fp.silk) {
      if (g.kind === 'line')
        shapes.push({
          kind: 'line',
          from: f(g.from),
          to: f(g.to),
          widthMm: g.widthMm,
          color: silk,
        });
      else if (g.filled)
        shapes.push({
          kind: 'disc',
          at: f(g.center),
          radiusMm: g.radiusMm + g.widthMm / 2,
          color: silk,
        });
      else
        shapes.push({
          kind: 'ring',
          at: f(g.center),
          radiusMm: g.radiusMm,
          widthMm: g.widthMm,
          color: silk,
        });
    }
  }
  // Pads where the mask is open: over the silkscreen, as a board maker clips it.
  const finish = finishRgb[doc.board.finish];
  for (const c of doc.components)
    for (const p of componentPads(doc, c))
      if (p.layers.includes(layer))
        shapes.push({ kind: 'polygon', polygons: [padPolygon(p.loop)], color: finish });
  const { plated, unplated } = pcbDrillHits(doc);
  for (const h of [...plated, ...unplated])
    shapes.push({ kind: 'hole', at: h.at, radiusMm: h.drillMm / 2 });
  for (const c of doc.board.cutouts)
    shapes.push({ kind: 'polygon', polygons: [padPolygon(c)], color: '' });
  return { bounds: loopBounds(doc.board.outline), shapes };
}

/**
 * Paints `art` on a 2D canvas, `pxPerMm` pixels to the millimetre, y up (the image's top row
 * is the board's top edge). Outside the board and inside holes and cut-outs stay clear.
 */
export function paintSideArt(
  ctx: CanvasRenderingContext2D,
  art: PcbSideArt,
  pxPerMm: number,
): void {
  const [x0, , , y1] = art.bounds;
  const X = (x: number) => (x - x0) * pxPerMm;
  const Y = (y: number) => (y1 - y) * pxPerMm;
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.lineCap = 'round';
  for (const s of art.shapes) {
    ctx.globalCompositeOperation =
      s.kind === 'hole' || (s.kind === 'polygon' && !s.color) ? 'destination-out' : 'source-over';
    ctx.beginPath();
    switch (s.kind) {
      case 'polygon':
        for (const poly of s.polygons) {
          poly.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))));
          ctx.closePath();
        }
        ctx.fillStyle = s.color || '#000';
        ctx.fill('nonzero');
        break;
      case 'line':
        ctx.moveTo(X(s.from[0]), Y(s.from[1]));
        ctx.lineTo(X(s.to[0]), Y(s.to[1]));
        ctx.lineWidth = Math.max(1, s.widthMm * pxPerMm);
        ctx.strokeStyle = s.color;
        ctx.stroke();
        break;
      case 'disc':
      case 'hole':
        ctx.arc(X(s.at[0]), Y(s.at[1]), s.radiusMm * pxPerMm, 0, 2 * Math.PI);
        ctx.fillStyle = s.kind === 'disc' ? s.color : '#000';
        ctx.fill();
        break;
      case 'ring':
        ctx.arc(X(s.at[0]), Y(s.at[1]), s.radiusMm * pxPerMm, 0, 2 * Math.PI);
        ctx.lineWidth = Math.max(1, s.widthMm * pxPerMm);
        ctx.strokeStyle = s.color;
        ctx.stroke();
        break;
    }
  }
  ctx.globalCompositeOperation = 'source-over';
}

/** The picture's size in pixels for a board, at most `maxPx` on its longer side. */
export function sideArtSize(art: PcbSideArt, maxPx = 2048) {
  const w = art.bounds[2] - art.bounds[0];
  const h = art.bounds[3] - art.bounds[1];
  const pxPerMm = Math.min(40, maxPx / Math.max(w, h));
  return {
    pxPerMm,
    width: Math.max(1, Math.round(w * pxPerMm)),
    height: Math.max(1, Math.round(h * pxPerMm)),
  };
}
