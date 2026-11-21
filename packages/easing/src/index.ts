// Keyframe easing and exact rates shared by the Animation and Character timelines. Core:
// no Editor depends on another through these types. See docs/kind-registry-design.md.

/** An exact rate such as 30000/1001 frames per second. */
export interface Rational {
  numerator: number;
  denominator: number;
}

/** How a keyframe segment moves from its left value to its right value. */
export type Easing =
  | { type: 'hold' }
  | { type: 'linear' }
  | { type: 'bezier'; x1: number; y1: number; x2: number; y2: number };

function curve(t: number, a: number, b: number) {
  return 3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
}

/** The eased progress (0–1) of a segment at linear progress `t`, as the Player samples keys. */
export function easingProgress(e: Easing, t: number): number {
  if (e.type === 'hold') return 0;
  if (e.type === 'linear' || t === 0 || t === 1) return t;
  let low = 0,
    high = 1;
  for (let i = 0; i < 52; i++) {
    const mid = (low + high) / 2;
    if (curve(mid, e.x1, e.x2) < t) low = mid;
    else high = mid;
  }
  return curve((low + high) / 2, e.y1, e.y2);
}
