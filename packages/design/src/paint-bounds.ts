import {
  gridTextExtent,
  rotatedBounds,
  usesGridText,
  layoutDrawingText,
  unionBounds,
  type Bounds,
  type Drawing,
} from '@editor-platform/editor-core';

/** Conservative native paint extent. Unbounded text and image error UI keep rendering. */
export function designPaintBounds(
  drawings: Drawing[],
  hit: Bounds,
  rotation?: number,
): Bounds | undefined {
  if (drawings.some((d) => d.kind === 'image' || (d.text && d.typography?.overflow === 'expand')))
    return undefined;
  return unionBounds([
    rotatedBounds(hit, rotation),
    ...drawings.map((drawing) => {
      if (drawing.path) return drawing.path.paintBounds;
      // SVG's default miter limit is four half-stroke widths.
      const pad = 2 * (drawing.strokeWidth ?? 1);
      const box = rotatedBounds(drawing.bounds, drawing.rotation);
      return {
        x: box.x - pad,
        y: box.y - pad,
        width: box.width + 2 * pad,
        height: box.height + 2 * pad,
      };
    }),
  ]);
}

/** Finite conservative export extent, including the renderer's expanded text layout. */
export function designExportPaintBounds(
  drawings: Drawing[],
  hit: Bounds,
  rotation?: number,
): Bounds {
  const geometry =
    designPaintBounds(
      drawings.map((d) =>
        d.typography?.overflow === 'expand'
          ? { ...d, text: '', typography: { ...d.typography, overflow: 'clip' } }
          : d,
      ),
      hit,
      rotation,
    ) ?? rotatedBounds(hit, rotation);
  const text = drawings
    .filter((d) => d.text && d.typography?.overflow === 'expand')
    .map((d) => {
      const b = d.bounds;
      let left: number, right: number, top: number, bottom: number;
      if (usesGridText(d)) {
        // Vertical and ruby text is set on the cell grid, which can run past the box on any side
        // (Codex on #29).
        const e = gridTextExtent(d);
        const margin = 4 * (d.typography?.fontSize ?? 28);
        [left, right, top, bottom] = [
          e.x - margin,
          e.x + e.width + margin,
          e.y - margin,
          e.y + e.height + margin,
        ];
      } else {
        const layout = layoutDrawingText(d);
        const margin = 4 * Math.max(layout.fontSize, ...layout.lines.map((line) => line.ascent));
        [left, right, top, bottom] = [
          b.x - margin,
          b.x + b.width + margin,
          Math.min(b.y, layout.startY) - margin,
          Math.max(b.y + b.height, layout.startY + layout.totalHeight) + margin,
        ];
      }
      const angle = ((d.rotation ?? 0) * Math.PI) / 180,
        cos = Math.cos(angle),
        sin = Math.sin(angle),
        cx = b.x + b.width / 2,
        cy = b.y + b.height / 2;
      const corners = [
        [left, top],
        [right, top],
        [right, bottom],
        [left, bottom],
      ].map(([x, y]) => {
        const dx = (x - cx) * (d.flipX ? -1 : 1),
          dy = (y - cy) * (d.flipY ? -1 : 1);
        return { x: cx + cos * dx - sin * dy, y: cy + sin * dx + cos * dy, width: 0, height: 0 };
      });
      return unionBounds(corners);
    });
  const result = unionBounds([geometry, ...text]);
  if (![result.x, result.y, result.width, result.height].every(Number.isFinite))
    throw Error('Unsupported Design export extent');
  return result;
}
