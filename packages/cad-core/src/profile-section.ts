/**
 * CR4d (docs/cad/car-design.md, W2): the cross-sections a `profileSweep` carries along its path,
 * drawn in the section's plane: u across, v up (the height), the path through (0, 0). A hat and a
 * channel open downwards (their open side at v = 0), so two hats facing each other, or a hat on a
 * flat closure, meet on their flanges.
 */
export type CadProfileKind = 'hat' | 'z' | 'channel' | 'flat';
export const cadProfileKinds: readonly CadProfileKind[] = ['hat', 'z', 'channel', 'flat'];
/** Limits of a profile's dimensions (mm). */
export const cadProfileLimitsMm = Object.freeze({
  height: [1, 500],
  width: [1, 500],
  flange: [0, 200],
  radius: [0, 50],
} as const);

/** One piece of a section outline: a straight side or a bend (an arc about `centre`). */
export type CadProfileSegment =
  | { name: string; kind: 'line'; a: [number, number]; b: [number, number] }
  | {
      name: string;
      kind: 'arc';
      a: [number, number];
      b: [number, number];
      centre: [number, number];
    };

/**
 * The outline of a section, its sides named (`flange:l`, `wall:l`, `top`, … ) and its corners
 * bent at `radiusMm` (`bend:1`, … in order). Refuses `profile-flange` for a hat or Z without a
 * flange and `profile-radius` when a bend does not fit its sides.
 */
export function profileOutline(
  kind: CadProfileKind,
  heightMm: number,
  widthMm: number,
  flangeMm: number,
  radiusMm: number,
): { segments: CadProfileSegment[] } | { code: 'profile-flange' | 'profile-radius' } {
  const [h, w, f] = [heightMm, widthMm, flangeMm];
  let points: [number, number][];
  let names: string[];
  if ((kind === 'hat' || kind === 'z') && !(f > 0)) return { code: 'profile-flange' };
  switch (kind) {
    case 'hat':
      points = [
        [-w / 2 - f, 0],
        [-w / 2, 0],
        [-w / 2, h],
        [w / 2, h],
        [w / 2, 0],
        [w / 2 + f, 0],
      ];
      names = ['flange:l', 'wall:l', 'top', 'wall:r', 'flange:r'];
      break;
    case 'z':
      // The lower flange `flange` wide to the left, the web up, the upper flange `width` right.
      points = [
        [-f, 0],
        [0, 0],
        [0, h],
        [w, h],
      ];
      names = ['flange:b', 'web', 'flange:t'];
      break;
    case 'channel':
      points = [
        [-w / 2, 0],
        [-w / 2, h],
        [w / 2, h],
        [w / 2, 0],
      ];
      names = ['wall:l', 'top', 'wall:r'];
      break;
    case 'flat':
      return {
        segments: [{ name: 'plate', kind: 'line', a: [-w / 2 - f, 0], b: [w / 2 + f, 0] }],
      };
  }
  const n = points.length;
  // Each inner corner's trim along its two sides: r tan(turn / 2).
  const trim = new Array<number>(n).fill(0);
  const dir = (i: number) => {
    const [a, b] = [points[i]!, points[i + 1]!];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return { d: [(b[0] - a[0]) / l, (b[1] - a[1]) / l] as [number, number], l };
  };
  for (let i = 1; i < n - 1; i++) {
    const [p, q] = [dir(i - 1).d, dir(i).d];
    const turn = Math.acos(Math.min(1, Math.max(-1, p[0] * q[0] + p[1] * q[1])));
    trim[i] = radiusMm * Math.tan(turn / 2);
  }
  for (let i = 0; i < n - 1; i++)
    if (trim[i]! + trim[i + 1]! > dir(i).l - 1e-9 && radiusMm > 0)
      return { code: 'profile-radius' };
  const segments: CadProfileSegment[] = [];
  const at = (i: number, s: number): [number, number] => {
    const { d } = dir(i);
    return [points[i]![0] + d[0] * s, points[i]![1] + d[1] * s];
  };
  for (let i = 0; i < n - 1; i++) {
    const { l } = dir(i);
    segments.push({
      name: names[i]!,
      kind: 'line',
      a: at(i, trim[i]!),
      b: at(i, l - trim[i + 1]!),
    });
    if (i + 1 < n - 1 && trim[i + 1]! > 0) {
      const { d } = dir(i);
      const next = dir(i + 1).d;
      // The centre lies on the inside of the turn, `radius` from the side.
      const left = d[0] * next[1] - d[1] * next[0] > 0;
      const normal: [number, number] = left ? [-d[1], d[0]] : [d[1], -d[0]];
      const a = at(i, l - trim[i + 1]!);
      segments.push({
        name: `bend:${i + 1}`,
        kind: 'arc',
        a,
        b: at(i + 1, trim[i + 1]!),
        centre: [a[0] + normal[0] * radiusMm, a[1] + normal[1] * radiusMm],
      });
    }
  }
  return { segments };
}

/** How far a section reaches from the path (mm): its farthest point from (0, 0). */
export function profileReach(segments: readonly CadProfileSegment[]): number {
  return Math.max(...segments.flatMap((s) => [Math.hypot(...s.a), Math.hypot(...s.b)]));
}
