import {
  defaultDrawingFontFamily,
  drawingPrimitives,
  serializeSvg,
  type SvgPrimitive,
} from '@editor-platform/editor-core';
import {
  connectorGeometry,
  connectorPath,
  whiteboardDrawing,
  whiteboardPaintOrder,
  type WhiteboardContent,
} from './model';
import { migrateWhiteboard, boardSelection, boardBounds } from './sections';
export function exportBoardSvg(source: WhiteboardContent, ids?: string[]): string {
  const d = migrateWhiteboard(source),
    all = ids?.length
      ? boardSelection(d, ids)
      : new Set([...d.nodes.map((n) => n.id), ...(d.sections ?? []).map((s) => s.id)]),
    box = boardBounds(d, ids),
    bounds = { x: box.x - 30, y: box.y - 30, width: box.width + 60, height: box.height + 60 };
  const backgrounds: SvgPrimitive[] = (d.sections ?? [])
      .filter((s) => all.has(s.id))
      .map((s) => ({ tag: 'rect', attrs: { ...s.bounds, fill: s.background, rx: 8 } })),
    labels: SvgPrimitive[] = (d.sections ?? [])
      .filter((s) => all.has(s.id))
      .flatMap((s): SvgPrimitive[] => [
        {
          tag: 'rect',
          attrs: { ...s.bounds, fill: 'none', stroke: '#8998bb', 'stroke-width': 1, rx: 8 },
        },
        {
          tag: 'text',
          attrs: {
            x: s.bounds.x + 14,
            y: s.bounds.y + 26,
            'font-size': 16,
            'font-weight': 600,
            fill: '#465879',
          },
          children: [s.title],
        },
      ]);
  const edges: SvgPrimitive[] = d.connectors
    .filter((c) => (all.has(c.from) || !c.from) && (all.has(c.to) || !c.to))
    .flatMap((c) => {
      const p = connectorGeometry(d, c);
      if (!p) return [];
      const color = c.stroke ?? '#637187',
        result: SvgPrimitive[] = [
          {
            tag: 'path',
            attrs: {
              d: connectorPath(c, p),
              fill: 'none',
              stroke: color,
              'stroke-width': c.strokeWidth ?? 2,
            },
          },
        ];
      const arrow = (x: number, y: number, angle: number) => {
        const point = (dx: number, dy: number) =>
          `${x + Math.cos(angle) * dx - Math.sin(angle) * dy} ${y + Math.sin(angle) * dx + Math.cos(angle) * dy}`;
        return {
          tag: 'path' as const,
          attrs: { d: `M${point(0, 0)}L${point(-9, 4)}L${point(-9, -4)}Z`, fill: color },
        };
      };
      const angle =
        c.routing === 'elbow' || c.routing === 'curve'
          ? p.x2 >= p.x1
            ? 0
            : Math.PI
          : Math.atan2(p.y2 - p.y1, p.x2 - p.x1);
      if (c.arrowhead !== 'none') result.push(arrow(p.x2, p.y2, angle));
      if (c.arrowhead === 'both') result.push(arrow(p.x1, p.y1, angle + Math.PI));
      if (c.label)
        result.push({
          tag: 'text',
          attrs: {
            x: (p.x1 + p.x2) / 2,
            y: (p.y1 + p.y2) / 2 - 8,
            'text-anchor': 'middle',
            'font-size': 14,
            fill: '#253044',
            stroke: 'white',
            'stroke-width': 4,
            'paint-order': 'stroke',
          },
          children: [c.label],
        });
      return result;
    });
  const nodes = whiteboardPaintOrder(d)
    .filter((n) => all.has(n.id) && !n.hidden)
    .flatMap((n, i) => drawingPrimitives(whiteboardDrawing(n), `graphic-${i}`));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${bounds.width}" height="${bounds.height}" viewBox="${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}"><g font-family="${defaultDrawingFontFamily}">${serializeSvg([...backgrounds, ...edges, ...labels, ...nodes])}</g></svg>`;
}
