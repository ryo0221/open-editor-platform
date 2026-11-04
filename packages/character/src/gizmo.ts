import type { Projected } from './mesh-edit';

/** One of the cage's own axes (x, y, z in the part's mesh space). */
export type GizmoAxis = 0 | 1 | 2;
/** A move handle on screen: from the selection's centre along one axis, in canvas pixels. */
export interface GizmoHandle {
  axis: GizmoAxis;
  from: [number, number];
  to: [number, number];
  /** Pixels the axis moves on screen per millimetre, at the centre. */
  perMm: [number, number];
}

/**
 * The move gizmo's handles (C3g) from the projected centre and the projected points `step` mm
 * from it along each axis (`[centre, +x, +y, +z]`). Each handle is `length` pixels long; an
 * axis that points along the view (a few hundredths of a pixel per step) or a point behind the
 * camera has no handle, as a drag along it could not say how far to move.
 */
export function gizmoHandles(
  screen: readonly Projected[],
  step: number,
  length = 80,
): GizmoHandle[] {
  const [c] = screen;
  if (!c || !visible(c) || !(step > 0)) return [];
  const out: GizmoHandle[] = [];
  for (const axis of [0, 1, 2] as const) {
    const p = screen[axis + 1];
    if (!p || !visible(p)) continue;
    const dx = p[0] - c[0],
      dy = p[1] - c[1];
    const l = Math.hypot(dx, dy);
    if (l < 0.05) continue;
    out.push({
      axis,
      from: [c[0], c[1]],
      to: [c[0] + (dx / l) * length, c[1] + (dy / l) * length],
      perMm: [dx / step, dy / step],
    });
  }
  return out;
}
const visible = (p: Projected) => p[2] > -1 && p[2] < 1;

/**
 * How far (mm, along the handle's axis) a drag from `start` to `now` moves: the pointer's
 * travel along the axis on screen, measured at the centre where the drag began, to 0.1 mm.
 */
export function dragDistance(
  handle: GizmoHandle,
  start: readonly [number, number],
  now: readonly [number, number],
): number {
  const [ax, ay] = handle.perMm;
  const l2 = ax * ax + ay * ay;
  if (!(l2 > 0)) return 0;
  const d = ((now[0] - start[0]) * ax + (now[1] - start[1]) * ay) / l2;
  return Math.round(d * 10) / 10 || 0;
}
