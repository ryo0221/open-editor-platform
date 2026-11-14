/**
 * F95 (docs/cad/vehicle-simulation.md, VS1, VS-U6): the fictional roadster 凪 for the analyses,
 * rebuilt with the O1 builder from main's tools only, at the two-view drawing's sizes. The look
 * model (the demo outside Git) uses tools that are not on main; this one keeps its sizes.
 *
 * Frame: X from the tail forward (car x = 4000 − the drawing's x, nose at x = 4000), Y to the left
 * side negative, Z up from the ground. mm.
 *
 * The aero shape (VS1a) is several closed bodies that overlap: the skin (a loft of full-width
 * sections with a flat floor between the wheels), the closed hard top or the windscreen alone, the
 * four wheels and the two door mirrors. A flow grid takes their union (`geometry-cfd` joins
 * overlapping closed surfaces), so no Boolean is needed. Not modelled: wheel wells, the cockpit
 * opening with the top down, the grille and ducts, the underbody parts.
 */
import { cadBuilder, cadBuildPlanes } from './builder';
import { fixtureKernel } from './fixtures';
import type { CadDocument, CadKernelProfile, Quaternion } from './model';

type Kernel = Pick<CadKernelProfile, 'id' | 'buildHash'>;
type P2 = [number, number];
const { YZ } = cadBuildPlanes;
/** The car's x of the drawing's x. */
const X = (xDrawing: number) => 4000 - xDrawing;

/** 凪's main sizes (the drawing). */
export const f95Nagi = Object.freeze({
  length: 4000,
  /** Axle x (car frame). */
  axles: { front: X(820), rear: X(3200) },
  wheelbase: 2380,
  track: { front: 1500, rear: 1510 },
  tyre: { radius: 308, width: 205 },
  /** Roof top of the closed hard top (mm above the ground). */
  roofHeight: 1247,
  /** Widest half width of the skin (mm). */
  halfWidth: 880,
});

/** Catmull–Rom through `pts`, `n` points a span. */
function catmull(pts: P2[], n = 12): P2[] {
  const out: P2[] = [];
  const p = [pts[0]!, ...pts, pts.at(-1)!];
  for (let i = 1; i < p.length - 2; i++) {
    const [p0, p1, p2, p3] = [p[i - 1]!, p[i]!, p[i + 1]!, p[i + 2]!];
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 *
        (2 * b +
          (-a + c) * t +
          (2 * a - 5 * b + 4 * c - d) * t * t +
          (-a + 3 * b - 3 * c + d) * t * t * t);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(pts.at(-1)!);
  return out;
}
/** The polyline `pts` (x ascending) at x, held flat past its ends. */
function polyAt(pts: P2[], x: number): number {
  if (x <= pts[0]![0]) return pts[0]![1];
  for (let i = 1; i < pts.length; i++)
    if (x <= pts[i]![0]) {
      const [a, b] = [pts[i - 1]!, pts[i]!];
      return a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0] || 1);
    }
  return pts.at(-1)![1];
}
/** A line smoothed along x (Gaussian, `sigma` mm, narrowing at the ends), every 10 mm. */
function smoothLine(f: (x: number) => number, x0: number, x1: number, sigma: number): P2[] {
  const out: P2[] = [];
  for (let x = x0; x <= x1 + 1e-9; x += 10) {
    const s = Math.max(1, Math.min(sigma, (x - x0) / 2.5, (x1 - x) / 2.5));
    let sum = 0;
    let wsum = 0;
    for (let k = -30; k <= 30; k++) {
      const w = Math.exp(-0.5 * (k / 10) ** 2);
      sum += w * f(Math.min(x1, Math.max(x0, x + (k / 10) * s)));
      wsum += w;
    }
    out.push([x, sum / wsum]);
  }
  return out;
}

const archX = (cx: number, r: number, z: number) => {
  const d = Math.sqrt(r * r - (z - 308) ** 2);
  return [cx - d, cx + d] as const;
};
/** The drawing's lines (drawing x from the nose; side view z, plan view half width). */
const lines = (() => {
  const [FA0] = archX(820, 345, 175);
  const [, RA1] = archX(3200, 352, 195);
  const top = catmull([
    [0, 430],
    [30, 540],
    [180, 615],
    [480, 680],
    [820, 728],
    [1150, 760],
    [1560, 850],
  ])
    .concat(
      catmull([
        [1560, 850],
        [1900, 868],
        [2300, 878],
        [2680, 890],
      ]).slice(1),
    )
    .concat(
      catmull([
        [2680, 890],
        [2900, 930],
        [3200, 958],
        [3600, 935],
        [3880, 905],
        [3975, 860],
        [4000, 760],
      ]).slice(1),
    );
  const bottom = [
    ...catmull([
      [8, 330],
      [40, 230],
      [120, 165],
      [300, 165],
      [FA0, 175],
    ]),
    [RA1, 195] as P2,
    ...catmull([
      [RA1, 195],
      [3680, 255],
      [3820, 300],
      [3930, 380],
      [3965, 470],
      [3995, 600],
    ]).slice(1),
  ];
  const half = catmull([
    [0, 0],
    [4, 300],
    [40, 560],
    [170, 760],
    [480, 858],
    [820, 875],
    [1200, 862],
    [1650, 818],
    [2150, 800],
    [2650, 828],
    [3200, 880],
    [3600, 872],
    [3850, 815],
    [3970, 680],
    [3998, 420],
    [4000, 0],
  ]);
  const shoulder = catmull([
    [150, 560],
    [820, 640],
    [1600, 655],
    [2400, 690],
    [3200, 770],
    [3800, 790],
  ]);
  const T = smoothLine((x) => polyAt(top, x), 0, 4000, 90);
  const B = smoothLine((x) => polyAt(bottom, x), 8, 3995, 90);
  const H = smoothLine((x) => polyAt(half, x), 0, 4000, 60);
  const S = smoothLine(
    (x) => Math.min(polyAt(shoulder, x), polyAt(B, x) + 0.8 * (polyAt(T, x) - polyAt(B, x))),
    0,
    4000,
    160,
  );
  return { T, B, H, S };
})();

/**
 * The skin's full-width section at drawing x `d`, (y, z) round the loop: the crown, a
 * superellipse quadrant to the shoulder each side, the side wall tucking in 4% to the rocker, and
 * the flat floor. Every section has the same 19 points, parametrised alike.
 */
export function f95Section(d: number): P2[] {
  const T = polyAt(lines.T, d);
  const B = polyAt(lines.B, d);
  const w = polyAt(lines.H, d);
  const sh = polyAt(lines.S, d);
  const D = T - sh;
  const left = [0.18, 0.38, 0.58, 0.78, 1].map((f): P2 => {
    const t = (f * Math.PI) / 2;
    return [-w * Math.sin(t) ** 0.5, sh + D * Math.cos(t) ** 0.5];
  });
  const wall: P2[] = [
    [-w * 0.99, (sh + B) / 2],
    [-w * 0.96, B],
  ];
  const half = [...left, ...wall];
  const floor = [-0.6, -0.2, 0.2, 0.6].map((f): P2 => [f * 0.96 * w, B]);
  const right = [...half].reverse().map(([y, z]): P2 => [-y, z]);
  return [[0, T], ...half, ...floor, ...right];
}

/** Drawing x of the skin's sections, tail first (car x ascending), closer at the ends. */
export const f95SectionX = (() => {
  const n = 18;
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    return 3985 - 3970 * (0.45 * t + (0.55 * (1 - Math.cos(Math.PI * t))) / 2);
  });
})();

/** Cylinder axis (+Z) turned onto +Y. */
const alongY: Quaternion = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
/** A rounded section of half width `w` from `z0` to `z1` round (0, 0), the top `top` × as wide. */
const rounded = (w: number, z0: number, z1: number, top: number): P2[] => [
  [0, z0],
  [w * 0.9, z0],
  [w, z0 + (z1 - z0) * 0.4],
  [w * top, z1],
  [0, z1],
  [-w * top, z1],
  [-w, z0 + (z1 - z0) * 0.4],
  [-w * 0.9, z0],
];

export interface F95Options {
  /** `hardtop` (closed, the default) or `open` (the windscreen alone). */
  roof?: 'hardtop' | 'open';
  /** The door mirrors (default true). */
  mirrors?: boolean;
}

/**
 * F95 凪's aero shape: bodies `skin`, `hard-top` or `windscreen`, `wheel-fl`, `wheel-fr`,
 * `wheel-rl`, `wheel-rr`, and `mirror-l` / `mirror-r` with mirrors. Each is one closed solid.
 */
export function f95NagiAero(options: F95Options = {}, kernel: Kernel = fixtureKernel): CadDocument {
  const { roof = 'hardtop', mirrors = true } = options;
  const b = cadBuilder(kernel);
  const paint = { color: '#c9ccd1', opacity: 1 };
  b.loft(
    'Skin',
    f95SectionX.map((d, i) =>
      b.closedSpline(
        `Skin section ${i + 1}`,
        { origin: [X(d), 0, 0], orientation: YZ },
        f95Section(d),
        {
          through: true,
        },
      ),
    ),
    false,
    paint,
  );
  // The hard top (closed) or the windscreen (open): rounded sections from inside the deck (z 780)
  // up to the drawing's roof line [drawing x, half width, top].
  const screen: [number, number, number][] = [
    [1575, 745, 860],
    [1760, 728, 1050],
    [1950, 705, 1222],
  ];
  const rows: [number, number, number][] =
    roof === 'hardtop'
      ? [
          ...screen,
          [2150, 705, 1240],
          [2400, 705, 1247],
          [2600, 700, 1240],
          [2680, 695, 1140],
          [2735, 690, 905],
        ]
      : [...screen, [1985, 705, 1222]];
  b.loft(
    roof === 'hardtop' ? 'Hard top' : 'Windscreen',
    [...rows]
      .reverse()
      .map(([d, w, z1], i) =>
        b.closedSpline(
          `${roof === 'hardtop' ? 'Top' : 'Screen'} section ${i + 1}`,
          { origin: [X(d), 0, 0], orientation: YZ },
          rounded(w, 780, z1, 0.88),
          { through: true },
        ),
      ),
    false,
    { color: '#1b1d21', opacity: 1 },
  );
  const tyre = { color: '#1b1b1b', opacity: 1 };
  const { radius, width } = f95Nagi.tyre;
  for (const [axle, x, track] of [
    ['f', f95Nagi.axles.front, f95Nagi.track.front],
    ['r', f95Nagi.axles.rear, f95Nagi.track.rear],
  ] as const)
    for (const [side, s] of [
      ['l', -1],
      ['r', 1],
    ] as const)
      b.cylinder(
        `Wheel ${axle}${side}`,
        {
          radius,
          height: width,
          // The base on the outer face for the left wheels, on the inner face for the right.
          origin: [x, s < 0 ? -(track / 2 + width / 2) : track / 2 - width / 2, radius],
          orientation: alongY,
        },
        tyre,
      );
  if (mirrors)
    // The housing after the drawing (side x 1640–1800, z 880–960, plan |y| 812–965), its
    // inner end reaching into the door top.
    for (const [side, s] of [
      ['l', -1],
      ['r', 1],
    ] as const)
      b.loft(
        `Mirror ${side}`,
        [1800, 1760, 1680, 1640].map((d, i) =>
          b.closedSpline(
            `Mirror ${side} section ${i + 1}`,
            { origin: [X(d), s * 880, 0], orientation: YZ },
            rounded(i === 0 ? 70 : 85, i === 0 ? 895 : 880, i === 0 ? 945 : 960, 0.85),
            { through: true },
          ),
        ),
        false,
        { color: '#cfd6dc', opacity: 1 },
      );
  return b.build().document;
}
