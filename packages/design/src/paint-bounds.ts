import {
  rotatedBounds,
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
