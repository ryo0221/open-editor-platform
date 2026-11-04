import type { DesignElement } from './model';
import { rectanglePolygon } from './division-geometry';

/** Fit a horizontal text box inside every edge of the convex panel, in world coordinates. */
export function mangaDialoguePlacement(parent: DesignElement, width = 300) {
  const b = parent.bounds;
  const points = parent.panelGeometry
    ? parent.panelGeometry.polygon.map((p) => ({ x: p.x * b.width, y: p.y * b.height }))
    : rectanglePolygon({ ...b, x: 0, y: 0 });
  // The average of convex vertices is strictly inside, even for a thin slanted panel.
  const center = {
    x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
    y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
  };
  const height = 70;
  const margin = Math.max(8, parent.strokeWidth ?? 0);
  let scale = 1;
  for (const [i, a] of points.entries()) {
    const next = points[(i + 1) % points.length];
    const dx = next.x - a.x,
      dy = next.y - a.y;
    const clearance = dx * (center.y - a.y) - dy * (center.x - a.x);
    const extent = (Math.abs(dy) * width + Math.abs(dx) * height) / 2;
    scale = Math.min(scale, (clearance - margin * Math.hypot(dx, dy)) / extent);
  }
  // Do not silently insert unreadable text into a panel too small for an 8-unit font.
  if (scale < 8 / 28) return undefined;
  return {
    bounds: {
      x: b.x + center.x - (width * scale) / 2,
      y: b.y + center.y - (height * scale) / 2,
      width: width * scale,
      height: height * scale,
    },
    typography: { fontSize: 28 * scale, padding: 8 * scale },
  };
}
