/**
 * #15 underlays: approved 2D drawings (front, side, top…) laid under the matching view, so a model
 * is matched to them by eye and by the deviation check (packages/cad, `underlayDeviation`). Each
 * underlay is a PNG or JPEG asset of the document, placed in its view's plane by the millimetres
 * one pixel covers and where the image's top-left corner lies. Display and checks only: an
 * underlay never changes a shape and is never snapped to.
 *
 * A view looks at the model from outside, Z up (as a drawing's third-angle views): `front` from
 * −Y, `back` from +Y, `right` from +X, `left` from −X, `top` from +Z, `bottom` from −Z. The view's
 * (u, v) are its right and up on the page; the image's rows go down, so a pixel (x, y) lies at
 * u = origin.u + x·mm, v = origin.v − y·mm.
 */
import type { CadAssetRef, CadDocument, Vec3 } from './model';

export type CadUnderlayView = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';
export const cadUnderlayViews: readonly CadUnderlayView[] = Object.freeze([
  'front',
  'back',
  'left',
  'right',
  'top',
  'bottom',
]);
export interface CadUnderlay {
  id: string;
  name: string;
  view: CadUnderlayView;
  /** A `texture-png` or `texture-jpeg` asset of the document. */
  assetId: string;
  /** The image's width and height in pixels. */
  pixels: [number, number];
  /** The size one pixel covers (mm). */
  mmPerPixel: number;
  /** Where the image's top-left corner lies in the view (u, v in mm). */
  originMm: [number, number];
  /** 0.05–1. */
  opacity: number;
  /** Not drawn (still checked when asked). */
  hidden?: boolean;
}
export const cadUnderlayLimits = Object.freeze({
  underlays: 64,
  /** Pixels on a side. */
  pixels: 16_384,
  minMmPerPixel: 1e-4,
  maxMmPerPixel: 1e4,
  /** |origin| (mm), as any model coordinate. */
  coordinateMm: 10_000_000,
  minOpacity: 0.05,
});

/** The share of the view's GPU budget the drawings and their heat may take together. */
export const cadUnderlayGpuShare = 0.25;
/** An RGBA texture's bytes with its mipmaps. */
export const cadUnderlayTextureBytes = (width: number, height: number) =>
  Math.ceil((width * height * 4 * 4) / 3);
/**
 * The one scale (at most 1) that brings the underlay images (pixel sizes) within `bytes`, and each
 * image's size at that scale: drawings are set coarser rather than pass the GPU budget (Codex on
 * #35).
 */
export function cadUnderlayTextureSizes(
  sizes: readonly (readonly [number, number])[],
  bytes: number,
): { scale: number; sizes: [number, number][] } {
  const total = sizes.reduce((n, [w, h]) => n + cadUnderlayTextureBytes(w, h), 0);
  let scale = total > bytes && total > 0 ? Math.sqrt(Math.max(0, bytes) / total) : 1;
  const at = (k: number) =>
    sizes.map(([w, h]) => [Math.max(1, Math.floor(w * k)), Math.max(1, Math.floor(h * k))]) as [
      number,
      number,
    ][];
  // Rounding a side up to one pixel can still pass: shrink until the sizes fit (or are 1 × 1).
  let out = at(scale);
  for (
    let n = 0;
    n < 64 && out.reduce((t, [w, h]) => t + cadUnderlayTextureBytes(w, h), 0) > bytes;
    n++
  ) {
    if (out.every(([w, h]) => w === 1 && h === 1)) break;
    scale *= 0.9;
    out = at(scale);
  }
  return { scale, sizes: out };
}

/** Right, up and toward-the-viewer axes of a view, in model space. */
export function cadUnderlayAxes(view: CadUnderlayView): { u: Vec3; v: Vec3; toward: Vec3 } {
  switch (view) {
    case 'front':
      return { u: [1, 0, 0], v: [0, 0, 1], toward: [0, -1, 0] };
    case 'back':
      return { u: [-1, 0, 0], v: [0, 0, 1], toward: [0, 1, 0] };
    case 'right':
      return { u: [0, 1, 0], v: [0, 0, 1], toward: [1, 0, 0] };
    case 'left':
      return { u: [0, -1, 0], v: [0, 0, 1], toward: [-1, 0, 0] };
    case 'top':
      return { u: [1, 0, 0], v: [0, 1, 0], toward: [0, 0, 1] };
    case 'bottom':
      return { u: [1, 0, 0], v: [0, -1, 0], toward: [0, 0, -1] };
  }
}
/** A model point's (u, v) in a view. */
export function cadUnderlayUv(view: CadUnderlayView, p: Vec3): [number, number] {
  const { u, v } = cadUnderlayAxes(view);
  return [p[0] * u[0] + p[1] * u[1] + p[2] * u[2], p[0] * v[0] + p[1] * v[1] + p[2] * v[2]];
}
/** The (u, v) box an underlay covers: u from, v from, u to, v to. */
export function cadUnderlayBox(u: CadUnderlay): [number, number, number, number] {
  const [w, h] = u.pixels;
  const [ou, ov] = u.originMm;
  return [ou, ov - h * u.mmPerPixel, ou + w * u.mmPerPixel, ov];
}

export type CadUnderlaysOperation = {
  type: 'setUnderlays';
  /** The whole list; empty removes it. */
  underlays: CadUnderlay[];
  /** New image assets the list names (the Host has stored their bytes first). */
  assets?: CadAssetRef[];
};
export function applyUnderlaysOperation(next: CadDocument, op: CadUnderlaysOperation) {
  if (JSON.stringify(next.underlays ?? []) === JSON.stringify(op.underlays))
    throw new Error('underlays-unchanged');
  for (const ref of op.assets ?? []) {
    const kept = next.assets.find((a) => a.id === ref.id);
    if (kept) {
      if (JSON.stringify(kept) !== JSON.stringify(ref)) throw new Error('asset-conflict');
      continue;
    }
    if (ref.kind !== 'texture-png' && ref.kind !== 'texture-jpeg') throw new Error('asset-kind');
    next.assets.push(structuredClone(ref));
  }
  if (op.underlays.length) next.underlays = structuredClone(op.underlays);
  else delete next.underlays;
  return next;
}

type Rec = Record<string, unknown>;
const record = (v: unknown): v is Rec =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export interface UnderlaysCheck {
  error(code: string, path: string): boolean;
  keys(v: Rec, required: string[], path: string, optional?: string[]): boolean;
  id(v: unknown, path: string): boolean;
  name(v: unknown, path: string): boolean;
}
/**
 * The shape of `underlays`: 1–64 with distinct IDs, a known view, an image asset of the document
 * (`imageAsset`), whole pixel sizes up to 16,384, a scale and origin within the limits and an
 * opacity from 0.05 to 1. Returns the asset IDs the list reads.
 */
export function validateUnderlays(
  c: UnderlaysCheck,
  list: unknown,
  imageAsset: (id: unknown) => boolean,
): string[] {
  const path = '$.underlays';
  const L = cadUnderlayLimits;
  if (!Array.isArray(list) || !list.length || list.length > L.underlays)
    return (c.error('underlays', path), []);
  const ids = new Set<string>();
  const used: string[] = [];
  list.forEach((u, i) => {
    const at = `${path}[${i}]`;
    if (!record(u)) return c.error('underlay', at);
    c.keys(
      u,
      ['id', 'name', 'view', 'assetId', 'pixels', 'mmPerPixel', 'originMm', 'opacity'],
      at,
      ['hidden'],
    );
    if (c.id(u.id, `${at}.id`)) {
      if (ids.has(u.id as string)) c.error('duplicate-id', `${at}.id`);
      ids.add(u.id as string);
    }
    if (c.name(u.name, `${at}.name`) && (u.name as string).trim() === '')
      c.error('underlay-name', `${at}.name`);
    if (!cadUnderlayViews.includes(u.view as CadUnderlayView))
      c.error('underlay-view', `${at}.view`);
    if (!imageAsset(u.assetId)) c.error('asset-missing', `${at}.assetId`);
    else used.push(u.assetId as string);
    if (
      !Array.isArray(u.pixels) ||
      u.pixels.length !== 2 ||
      !u.pixels.every((n) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= L.pixels)
    )
      c.error('underlay-pixels', `${at}.pixels`);
    if (!finite(u.mmPerPixel) || u.mmPerPixel < L.minMmPerPixel || u.mmPerPixel > L.maxMmPerPixel)
      c.error('underlay-scale', `${at}.mmPerPixel`);
    if (
      !Array.isArray(u.originMm) ||
      u.originMm.length !== 2 ||
      !u.originMm.every((n) => finite(n) && Math.abs(n) <= L.coordinateMm)
    )
      c.error('underlay-origin', `${at}.originMm`);
    if (!finite(u.opacity) || u.opacity < L.minOpacity || u.opacity > 1)
      c.error('underlay-opacity', `${at}.opacity`);
    if (Object.hasOwn(u, 'hidden') && u.hidden !== true) c.error('underlay-hidden', `${at}.hidden`);
  });
  return used;
}
