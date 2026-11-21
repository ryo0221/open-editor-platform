import { cadUnderlayUv, type CadUnderlay } from '@editor-platform/cad-core';
import type { CadMesh } from '@editor-platform/cad-kernel-occt';

/**
 * #15 deviation of a model from an underlay drawing, headless: no GPU, no DOM. The shown bodies'
 * display triangles are projected into the underlay's view and filled on a grid of the image's
 * pixels (coarsened to at most `maxGridSide` cells a side); a body's silhouette is the edge of its
 * filled cells. The drawing's lines are its dark, opaque pixels. Each silhouette cell's deviation
 * is its distance to the nearest line cell (exact Euclidean distance transform), in mm. The same
 * meshes, image and underlay always give the same numbers.
 */
export interface CadUnderlayBodyDeviation {
  bodyId: string;
  /** Silhouette cells measured. */
  cells: number;
  meanMm: number;
  /** 95th percentile. */
  p95Mm: number;
  maxMm: number;
}
export interface CadUnderlayDeviation {
  underlayId: string;
  /** Grid size (cells) and the mm one cell covers. */
  width: number;
  height: number;
  cellMm: number;
  /** Per body with a silhouette inside the image; bodies wholly outside are left out. */
  bodies: CadUnderlayBodyDeviation[];
  /** Per grid cell: the deviation (mm) of a silhouette cell, NaN elsewhere (row-major, y down). */
  heat: Float32Array;
}
export interface CadUnderlayImage {
  width: number;
  height: number;
  /** RGBA, row-major, 4 bytes a pixel. */
  data: Uint8ClampedArray | Uint8Array;
}
export const underlayDeviationDefaults = Object.freeze({
  maxGridSide: 2048,
  /** A pixel is a line when its luminance is below this (0–255) and its alpha at least 128. */
  lineLuminance: 128,
});

/** The drawing's line cells on a grid `k` image pixels a side (a cell is a line if any pixel is). */
export function underlayLineMask(
  image: CadUnderlayImage,
  k = 1,
  threshold: number = underlayDeviationDefaults.lineLuminance,
) {
  const w = Math.ceil(image.width / k),
    h = Math.ceil(image.height / k);
  const mask = new Uint8Array(w * h);
  const d = image.data;
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const i = 4 * (y * image.width + x);
      if (d[i + 3]! < 128) continue;
      const lum = 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
      if (lum < threshold) mask[Math.floor(y / k) * w + Math.floor(x / k)] = 1;
    }
  return { mask, width: w, height: h };
}

/** Squared distance (cells²) from each cell to the nearest set cell; Infinity when none is set. */
export function distanceTransform(mask: Uint8Array, w: number, h: number): Float64Array {
  const INF = 1e20;
  const out = new Float64Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = mask[i] ? 0 : INF;
  const n = Math.max(w, h);
  const f = new Float64Array(n),
    d = new Float64Array(n),
    v = new Int32Array(n),
    z = new Float64Array(n + 1);
  // Felzenszwalb & Huttenlocher's 1D lower envelope of parabolas, along columns then rows.
  const pass = (len: number) => {
    let k = 0;
    v[0] = 0;
    z[0] = -Infinity;
    z[1] = Infinity;
    for (let q = 1; q < len; q++) {
      let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      while (s <= z[k]!) {
        k--;
        s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1]! < q) k++;
      d[q] = (q - v[k]!) * (q - v[k]!) + f[v[k]!]!;
    }
  };
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = out[y * w + x]!;
    pass(h);
    for (let y = 0; y < h; y++) out[y * w + x] = d[y]!;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = out[y * w + x]!;
    pass(w);
    for (let x = 0; x < w; x++) out[y * w + x] = d[x]! >= INF / 2 ? Infinity : d[x]!;
  }
  return out;
}

/** Fill a triangle (cell coordinates, cell centres at +0.5) into `mask`. */
function fillTriangle(
  mask: Uint8Array,
  w: number,
  h: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
) {
  const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
  if (!area) return;
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))),
    x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx))),
    y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))),
    y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy)));
  const s = Math.sign(area);
  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5;
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      const e0 = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) * s,
        e1 = ((cx - bx) * (py - by) - (cy - by) * (px - bx)) * s,
        e2 = ((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) * s;
      if (e0 >= 0 && e1 >= 0 && e2 >= 0) mask[y * w + x] = 1;
    }
  }
}

/**
 * The deviation of each shown body's silhouette from the underlay's lines. `image` is the
 * underlay's decoded image (its pixel size must match the underlay's). Bodies not in `shown`, and
 * coarse or before-failure meshes, are left out.
 */
export function underlayDeviation(
  underlay: CadUnderlay,
  image: CadUnderlayImage,
  meshes: readonly CadMesh[],
  shown: ReadonlySet<string>,
  maxGridSide: number = underlayDeviationDefaults.maxGridSide,
): CadUnderlayDeviation {
  if (image.width !== underlay.pixels[0] || image.height !== underlay.pixels[1])
    throw Error('underlay-image-size');
  const k = Math.max(1, Math.ceil(Math.max(image.width, image.height) / maxGridSide));
  const lines = underlayLineMask(image, k);
  const { width: w, height: h } = lines;
  const cellMm = underlay.mmPerPixel * k;
  const dist = distanceTransform(lines.mask, w, h);
  const hasLine = lines.mask.some((m) => m === 1);
  const heat = new Float32Array(w * h).fill(NaN);
  const [ou, ov] = underlay.originMm;
  const bodies: CadUnderlayBodyDeviation[] = [];
  const byBody = new Map<string, CadMesh[]>();
  for (const m of meshes) {
    if (m.lod || m.beforeFailure || !shown.has(m.bodyId)) continue;
    byBody.set(m.bodyId, [...(byBody.get(m.bodyId) ?? []), m]);
  }
  for (const [bodyId, list] of [...byBody].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const fill = new Uint8Array(w * h);
    for (const mesh of list) {
      const { positions: p, indices, origin: o } = mesh;
      const cells = new Float64Array((p.length / 3) * 2);
      for (let i = 0; i < p.length / 3; i++) {
        const [u, v] = cadUnderlayUv(underlay.view, [
          p[3 * i]! + o[0],
          p[3 * i + 1]! + o[1],
          p[3 * i + 2]! + o[2],
        ]);
        cells[2 * i] = (u - ou) / cellMm;
        cells[2 * i + 1] = (ov - v) / cellMm;
      }
      for (let t = 0; t + 2 < indices.length; t += 3) {
        const [a, b, c] = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
        fillTriangle(
          fill,
          w,
          h,
          cells[2 * a]!,
          cells[2 * a + 1]!,
          cells[2 * b]!,
          cells[2 * b + 1]!,
          cells[2 * c]!,
          cells[2 * c + 1]!,
        );
      }
    }
    const found: number[] = [];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!fill[i]) continue;
        // An edge cell: a 4-neighbour is empty. The image's own border is not an edge (the body
        // goes on past it, and the drawing shows nothing there).
        const edge =
          (x > 0 && !fill[i - 1]) ||
          (x < w - 1 && !fill[i + 1]) ||
          (y > 0 && !fill[i - w]) ||
          (y < h - 1 && !fill[i + w]);
        if (!edge) continue;
        const mm = hasLine ? Math.sqrt(dist[i]!) * cellMm : Infinity;
        found.push(mm);
        heat[i] = Math.min(Number.isFinite(heat[i]) ? heat[i]! : Infinity, mm);
      }
    if (!found.length) continue;
    const sorted = Float64Array.from(found).sort();
    const mean = found.reduce((s, x) => s + x, 0) / found.length;
    bodies.push({
      bodyId,
      cells: found.length,
      meanMm: mean,
      p95Mm: sorted[Math.min(sorted.length - 1, Math.floor(0.95 * (sorted.length - 1)))]!,
      maxMm: sorted[sorted.length - 1]!,
    });
  }
  return { underlayId: underlay.id, width: w, height: h, cellMm, bodies, heat };
}

/**
 * The heat overlay as RGBA: silhouette cells from green (within `toleranceMm`) through yellow to
 * red (at 4× the tolerance or more); every other cell transparent.
 */
export function underlayHeatImage(d: CadUnderlayDeviation, toleranceMm: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(d.width * d.height * 4);
  for (let i = 0; i < d.heat.length; i++) {
    const mm = d.heat[i]!;
    if (Number.isNaN(mm)) continue;
    const t = Math.max(0, Math.min(1, (mm - toleranceMm) / (3 * toleranceMm)));
    out[4 * i] = Math.round(255 * Math.min(1, 2 * t));
    out[4 * i + 1] = Math.round(200 * Math.min(1, 2 * (1 - t)));
    out[4 * i + 2] = 40;
    out[4 * i + 3] = 255;
  }
  return out;
}
