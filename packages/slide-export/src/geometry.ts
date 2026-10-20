import { shapePath, type Bounds, type Drawing } from '@editor-platform/editor-core';

const cubic = (p0: number, p1: number, p2: number, p3: number, t: number) =>
  (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3 * p3;
/** Roots of a cubic Bézier coordinate's derivative (candidate extrema). */
function cubicRoots(p0: number, p1: number, p2: number, p3: number) {
  const a = -p0 + 3 * p1 - 3 * p2 + p3,
    c = p1 - p0,
    q = 2 * (p0 - 2 * p1 + p2);
  if (Math.abs(a) < 1e-10) return Math.abs(q) < 1e-10 ? [] : [-c / q];
  const disc = q * q - 4 * a * c;
  return disc < 0 ? [] : [(-q + Math.sqrt(disc)) / (2 * a), (-q - Math.sqrt(disc)) / (2 * a)];
}
/** Local paint extent, starting from the nominal object box. */
class Extent {
  left = 0;
  top = 0;
  constructor(
    public right: number,
    public bottom: number,
  ) {}
  include(x: number, y: number) {
    this.left = Math.min(this.left, x);
    this.right = Math.max(this.right, x);
    this.top = Math.min(this.top, y);
    this.bottom = Math.max(this.bottom, y);
  }
}
/** Includes every segment end point and cubic extremum of a native M/L/H/V/C/Z path. */
function includePath(extent: Extent, path: string) {
  const tokens = path.match(/[MLHVCZ]|[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi) ?? [];
  let i = 0,
    x = 0,
    y = 0,
    sx = 0,
    sy = 0;
  const next = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const command = tokens[i++];
    if (command === 'M' || command === 'L') {
      x = next();
      y = next();
      if (command === 'M') [sx, sy] = [x, y];
    } else if (command === 'H') x = next();
    else if (command === 'V') y = next();
    else if (command === 'Z') [x, y] = [sx, sy];
    else if (command === 'C') {
      const [x1, y1, x2, y2, nx, ny] = [next(), next(), next(), next(), next(), next()];
      for (const t of [...cubicRoots(x, x1, x2, nx), ...cubicRoots(y, y1, y2, ny)])
        if (t > 0 && t < 1) extent.include(cubic(x, x1, x2, nx, t), cubic(y, y1, y2, ny, t));
      [x, y] = [nx, ny];
    } else throw Error('Unknown native shape path');
    extent.include(x, y);
  }
}
/** Include cubic extrema outside the nominal object box (notably the cloud's right edge). */
export function shapeRasterBounds(drawing: Drawing): Bounds {
  const b = drawing.bounds;
  if (drawing.kind !== 'shape') return { ...b };
  const kind = drawing.shape ?? 'rectangle';
  const extent = new Extent(b.width, b.height);
  includePath(extent, shapePath(kind, b.width, b.height));
  if (
    kind === 'arrow' ||
    kind === 'double-arrow' ||
    drawing.arrowhead === 'end' ||
    drawing.arrowhead === 'both'
  ) {
    const endY = kind === 'elbow' ? b.height : kind === 'curve' ? 0 : b.height / 2;
    extent.include(b.width - 10, endY - 6);
    extent.include(b.width, endY + 6);
  }
  if (kind === 'double-arrow' || drawing.arrowhead === 'both') {
    extent.include(0, b.height / 2 - 6);
    extent.include(10, b.height / 2 + 6);
  }
  const { left, top, right, bottom } = extent;
  return { x: b.x + left, y: b.y + top, width: right - left, height: bottom - top };
}

/** Position a sub-box around the original drawing's transform center exactly once. */
export function transformDrawingBox(box: Bounds, drawing: Drawing): Bounds {
  const b = drawing.bounds,
    cx = b.x + b.width / 2,
    cy = b.y + b.height / 2;
  const dx = (box.x + box.width / 2 - cx) * (drawing.flipX ? -1 : 1);
  const dy = (box.y + box.height / 2 - cy) * (drawing.flipY ? -1 : 1);
  const radians = ((drawing.rotation ?? 0) * Math.PI) / 180;
  return {
    ...box,
    x: cx + dx * Math.cos(radians) - dy * Math.sin(radians) - box.width / 2,
    y: cy + dx * Math.sin(radians) + dy * Math.cos(radians) - box.height / 2,
  };
}
export interface PptxImagePlacement {
  bounds: Bounds;
  /** Fractions of the original binary cropped away, before rotation/flip. */
  crop: { left: number; right: number; top: number; bottom: number };
}
/** SVG xMidYMid meet/slice, scaled viewport and object clip, independent of a browser. */
export function pptxImagePlacement(
  drawing: Drawing,
  width: number,
  height: number,
): PptxImagePlacement | undefined {
  const b = drawing.bounds,
    crop = drawing.crop ?? { x: 0, y: 0, scale: 1 };
  const w = b.width * crop.scale,
    h = b.height * crop.scale;
  const ratio = (drawing.imageFit === 'fit' ? Math.min : Math.max)(w / width, h / height);
  const image = {
    x: b.x + crop.x + (w - width * ratio) / 2,
    y: b.y + crop.y + (h - height * ratio) / 2,
    width: width * ratio,
    height: height * ratio,
  };
  const x = Math.max(b.x, image.x),
    y = Math.max(b.y, image.y);
  const right = Math.min(b.x + b.width, image.x + image.width),
    bottom = Math.min(b.y + b.height, image.y + image.height);
  if (right <= x || bottom <= y) return;
  return {
    bounds: { x, y, width: right - x, height: bottom - y },
    crop: {
      left: (x - image.x) / image.width,
      right: (image.x + image.width - right) / image.width,
      top: (y - image.y) / image.height,
      bottom: (image.y + image.height - bottom) / image.height,
    },
  };
}
