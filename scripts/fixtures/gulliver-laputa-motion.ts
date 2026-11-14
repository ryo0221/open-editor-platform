/**
 * GV5b (docs/cad/gulliver-world.md, GV-U5): how the flying island moves, from the text's rules
 * only (Project Gutenberg #829, Part III chapter 3), not a physics of magnets:
 *
 * - "the stone is endued at one of its sides with an attractive power, and at the other with a
 *   repulsive. Upon placing the magnet erect, with its attracting end towards the earth, the
 *   island descends; but when the repelling extremity points downwards, the island mounts
 *   directly upwards. When the position of the stone is oblique, the motion of the island is so
 *   too: for in this magnet, the forces always act in lines parallel to its direction."
 *   So the island moves along the stone's line, from the repelling end (d) toward the attracting
 *   end (c): erect with d down, straight up; erect with c down, straight down; oblique, obliquely.
 * - "When the stone is put parallel to the plane of the horizon, the island stands still; for in
 *   that case the extremities of it, being at equal distance from the earth, act with equal
 *   force". The ends' unequal distance from the earth is what moves it, so the rate here is the
 *   stone's vertical part (|cos tilt|): full when erect, nothing when level (創作: the rate law).
 * - "this island cannot move beyond the extent of the dominions below, nor can it rise above the
 *   height of four miles": the stone's height above the earth stays within 4 miles, and the
 *   island's centre stays over the dominions (the land, and "the sea about six leagues distant
 *   from the shore").
 *
 * Lengths in mm, time in s. The island's position is its under surface's centre; z is its height
 * above the earth (the plane z = 0).
 */
import { axleZ, caveFloorZ } from './gulliver-laputa-cad';

export type V3 = [number, number, number];
const mile = 1_609_344;
const league = 3 * mile;

/** 本文: "nor can it rise above the height of four miles" (the magnetic virtue's reach). */
export const reachMm = 4 * mile;
/** 本文: the mineral lies "in the sea about six leagues distant from the shore". */
export const seaReachMm = 6 * league;
/** The stone's centre above the island's under surface (the cave floor plus the axle's height). */
export const stoneAboveUnderside = (): number => caveFloorZ() + axleZ();

/**
 * The stone's pose as the joints of F117 give it: `yawRad` turns the axle about the vertical
 * (0 = the axle along x), `tiltRad` turns the stone on the axle (0 = erect, the attracting end c
 * up). Returns the unit vector from d to c.
 */
export function attractingEnd(yawRad: number, tiltRad: number): V3 {
  // Erect: c along +z. A turn by tilt about the axle (x) takes +z to (0, −sin, cos); then the yaw.
  const v: V3 = [0, -Math.sin(tiltRad), Math.cos(tiltRad)];
  const [c, s] = [Math.cos(yawRad), Math.sin(yawRad)];
  return [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]];
}

/**
 * The island's velocity for a stone pose, at `rate` mm/s when erect: along d → c, scaled by the
 * stone's vertical part (none when level).
 */
export function islandVelocity(yawRad: number, tiltRad: number, rate: number): V3 {
  const u = attractingEnd(yawRad, tiltRad);
  const k = rate * Math.abs(u[2]);
  return [k * u[0], k * u[1], k * u[2]];
}

/** The dominions below: a polygon of the land (x, y in mm) and its sea margin. */
export interface Dominions {
  land: [number, number][];
}
function inPolygon(p: [number, number], poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!,
      [xj, yj] = poly[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}
function distanceToSegment(p: [number, number], a: [number, number], b: [number, number]): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const t = Math.max(
    0,
    Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)),
  );
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
/** Whether a point is over the dominions: on the land, or within six leagues of its shore. */
export function overDominions(d: Dominions, p: [number, number]): boolean {
  if (inPolygon(p, d.land)) return true;
  for (let i = 0; i < d.land.length; i++)
    if (distanceToSegment(p, d.land[i]!, d.land[(i + 1) % d.land.length]!) <= seaReachMm)
      return true;
  return false;
}

export type Stop = 'level' | 'reach' | 'earth' | 'border';
export interface StepResult {
  at: V3;
  /** What held the island back in this step, if anything. */
  stopped: Stop[];
}

/**
 * One step of `dt` seconds. Vertical and horizontal motion are held back separately: the height
 * stops at the earth and at four miles' reach of the stone, the centre at the dominions' edge.
 */
export function stepIsland(
  at: V3,
  stone: { yawRad: number; tiltRad: number },
  dt: number,
  d: Dominions,
  rate: number,
): StepResult {
  const v = islandVelocity(stone.yawRad, stone.tiltRad, rate);
  const stopped: Stop[] = [];
  if (Math.hypot(...v) < 1e-9) return { at, stopped: ['level'] };
  let z = at[2] + v[2] * dt;
  const top = reachMm - stoneAboveUnderside();
  if (z > top) {
    z = top;
    stopped.push('reach');
  }
  if (z < 0) {
    z = 0;
    stopped.push('earth');
  }
  let [x, y] = [at[0] + v[0] * dt, at[1] + v[1] * dt];
  if ((v[0] !== 0 || v[1] !== 0) && !overDominions(d, [x, y])) {
    [x, y] = [at[0], at[1]];
    stopped.push('border');
  }
  return { at: [x, y, z], stopped };
}

/** A leg of a voyage: hold the stone in a pose for some seconds. */
export interface Leg {
  name: string;
  yawRad: number;
  tiltRad: number;
  seconds: number;
}
/** Runs legs in steps of `dt`; returns the island's track (time, position) and each leg's end. */
export function voyage(start: V3, legs: Leg[], d: Dominions, rate: number, dt = 0.5) {
  const track: { t: number; at: V3; leg: number }[] = [{ t: 0, at: start, leg: 0 }];
  const ends: V3[] = [];
  let [t, at] = [0, start];
  legs.forEach((leg, i) => {
    const n = Math.max(1, Math.round(leg.seconds / dt));
    for (let k = 0; k < n; k++) {
      at = stepIsland(at, leg, leg.seconds / n, d, rate).at;
      t += leg.seconds / n;
      track.push({ t, at, leg: i });
    }
    ends.push(at);
  });
  return { track, ends };
}

/**
 * The text's figure: over C on a line AB across Balnibarbi (along +x), the stone is set
 * obliquely with its repelling end down and the island rises toward D; turned with its attracting
 * end toward E, it falls toward E; and so on to G; from G to H the repelling end points straight
 * down. `lean` is the stone's angle from upright (創作: "the obliquity being not considerable").
 */
export function figureLegs(lean: number, seconds: number): Leg[] {
  // With the axle along y (yaw π/2), a tilt of +lean leans c toward +x.
  const yaw = Math.PI / 2;
  return [
    { name: 'C→D', yawRad: yaw, tiltRad: lean, seconds },
    { name: 'D→E', yawRad: yaw, tiltRad: Math.PI - lean, seconds },
    { name: 'E→F', yawRad: yaw, tiltRad: lean, seconds },
    { name: 'F→G', yawRad: yaw, tiltRad: Math.PI - lean, seconds },
    { name: 'G→H', yawRad: yaw, tiltRad: 0, seconds: seconds / 2 },
  ];
}
