import type { CadCamera, CadNamedView, CadProjection, Vec3 } from '@editor-platform/cad-core';

/** Model bounds in millimetres, as [min, max]. */
export type Bounds = [Vec3, Vec3];

/** The grid when nothing is shown yet: 400 mm with 10 mm cells. */
export const defaultGrid = { step: 10, divisions: 40, center: [0, 0] as [number, number] };

/** 1, 2 or 5 × 10ⁿ: the smallest such step that is at least `raw`. */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return defaultGrid.step;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw * (1 - 1e-9));
  return step ?? 10 * power;
}

/**
 * A grid on the Z = 0 plane sized to the model: about ten cells across its longer horizontal
 * side, reaching well past the model so it stays visible around it. Snapped to whole cells so
 * the lines pass through the origin.
 */
export function gridFor([min, max]: Bounds): {
  step: number;
  divisions: number;
  center: [number, number];
} {
  const extent = Math.max(max[0] - min[0], max[1] - min[1]);
  if (!(extent > 0)) return defaultGrid;
  const step = niceStep(extent / 10);
  const snap = (v: number) => Math.round(v / step) * step;
  const center: [number, number] = [snap((min[0] + max[0]) / 2), snap((min[1] + max[1]) / 2)];
  // Cover the model from the snapped center plus a margin of half its extent on each side.
  const reach = Math.max(
    Math.abs(min[0] - center[0]),
    Math.abs(max[0] - center[0]),
    Math.abs(min[1] - center[1]),
    Math.abs(max[1] - center[1]),
  );
  const half = Math.ceil((reach + extent / 2) / step);
  return { step, divisions: 2 * half, center };
}

/**
 * Orbit speed for the viewport. A drag across the full viewport height turns the view by π
 * (OrbitControls' default turns it by 2π, so a short drag swung below the model).
 */
export const orbitRotateSpeed = 0.5;

/** Whether the view direction is (nearly) parallel to up, which validateCad rejects. */
function degenerate({ position, target, up }: CadCamera) {
  const dir = target.map((t, i) => t - position[i]);
  const cross = [
    dir[1] * up[2] - dir[2] * up[1],
    dir[2] * up[0] - dir[0] * up[2],
    dir[0] * up[1] - dir[1] * up[0],
  ];
  return Math.hypot(...cross) <= 1e-12 * Math.hypot(...dir) * Math.hypot(...up);
}

/**
 * Camera and projection of the current view, rounded to micrometres for stable content. A camera
 * that rounding would make degenerate (looking almost straight along up) keeps full precision.
 */
export function viewOf(camera: CadCamera, projection: CadProjection) {
  const round = (v: Vec3): Vec3 => v.map((x) => Math.round(x * 1000) / 1000 || 0) as Vec3;
  const rounded = {
    position: round(camera.position),
    target: round(camera.target),
    up: round(camera.up),
  };
  return {
    camera: degenerate(rounded) ? camera : rounded,
    projection:
      projection.type === 'perspective'
        ? projection
        : { type: 'orthographic' as const, spanMm: Math.round(projection.spanMm * 1000) / 1000 },
  };
}

/**
 * The view to open with: the first named view that shows every active body, if any. A view that
 * hides some bodies (an interior view) is chosen in Views, never opened by itself (SU2).
 */
export function initialView(views: CadNamedView[], activeBodyIds: ReadonlySet<string>) {
  return views.find((v) => [...activeBodyIds].every((id) => v.bodyIds.includes(id)));
}

/** The fixed views of the viewport's View menu: view state only, never stored in the document. */
export type CadStandardView = 'plan' | 'front' | 'right' | 'three-quarter';
/**
 * Where each standard view looks from (a unit vector from the target towards the camera) and
 * its up. Plan looks down Z with Y up; front looks along +Y and right along −X, both Z up. The
 * planar views are orthographic so equal lengths read equal anywhere on screen.
 */
export const standardViews: Record<
  CadStandardView,
  { label: string; from: Vec3; up: Vec3; orthographic: boolean }
> = {
  plan: { label: 'Plan (top)', from: [0, 0, 1], up: [0, 1, 0], orthographic: true },
  front: { label: 'Front', from: [0, -1, 0], up: [0, 0, 1], orthographic: true },
  right: { label: 'Right', from: [1, 0, 0], up: [0, 0, 1], orthographic: true },
  'three-quarter': {
    label: 'Three-quarter',
    from: [0.55, -0.75, 0.6].map((v) => v / Math.hypot(0.55, 0.75, 0.6)) as Vec3,
    up: [0, 0, 1],
    orthographic: false,
  },
};

/**
 * Sizes of two bodies' bounds along X, Y and Z, and `a` minus `b`: what Compare size shows. Bounds
 * are the evaluated shapes' axis-aligned boxes, so this compares overall extents only.
 */
export function compareSizes(a: Bounds, b: Bounds) {
  return [0, 1, 2].map((i) => {
    const sa = a[1][i]! - a[0][i]!;
    const sb = b[1][i]! - b[0][i]!;
    return { axis: 'XYZ'[i] as 'X' | 'Y' | 'Z', a: sa, b: sb, difference: sa - sb };
  });
}
