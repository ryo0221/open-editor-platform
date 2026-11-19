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
import { f29Biw } from './biw-fixtures';
import { cadBuilder, cadBuildPlanes } from './builder';
import { fixtureKernel } from './fixtures';
import { mm, position } from './model';
import type { CadDocument, CadFeature, CadKernelProfile, Quaternion, Vec3 } from './model';
import { applyCadOperation, type CadNewBody } from './operations';
import type { CadSketch } from './sketch';
import { edgeName } from './topology';

type Kernel = Pick<CadKernelProfile, 'id' | 'buildHash'>;
type P2 = [number, number];
const { XZ, YZ } = cadBuildPlanes;
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

/**
 * F101 (VS8c): 凪's crash structure. F29's simplified BIW (CR4g, 40 bodies; its nose, the
 * radiator support, at x 3850) carries the front end of 凪 to its 4000 mm length: two crash boxes
 * (square tubes ahead of the front side members, butting on the radiator support) and the bumper
 * beam (a closed box section across the front, its back on the boxes' front ends). Each is one
 * sheet; their ends are joined in the analysis by bonds of their rims (no welds in the CAD). The
 * hood, a single skin over the front from the dash to the bumper (no inner panel), is for the
 * pedestrian head impact; a crash study leaves it out.
 */
export const f101NagiCrash = Object.freeze({
  /** The crash boxes' section (y centre ±, z bottom, size) and run (x from, to). */
  box: { y: 450, z: 400, size: 80, fromX: 3850, toX: 3970 },
  /** The bumper beam: x back to front, z bottom to top, half width. */
  bumper: { backX: 3970, frontX: 4000, z0: 390, z1: 490, halfWidth: 650 },
  /** The hood's side line (x, z), carried across its half width. */
  hood: {
    line: [
      [2960, 900],
      [3950, 820],
      [3990, 770],
    ] as readonly P2[],
    halfWidth: 620,
  },
});

/** F101's bodies besides F29's. */
export const f101Bodies = ['crash-box', 'crash-box-r', 'bumper', 'hood'] as const;

/** A polygon sketch (closed unless `open`) on `orientation` at `origin` through `pts`. */
function loop(
  id: string,
  name: string,
  orientation: Quaternion,
  origin: Vec3,
  pts: readonly P2[],
  open = false,
) {
  const points = Object.fromEntries(pts.map((p, i) => [`p${i}`, p]));
  const lines = pts.slice(0, open ? -1 : undefined).map((_, i) => ({
    type: 'line' as const,
    id: `s${i}`,
    start: `p${i}`,
    end: `p${(i + 1) % pts.length}`,
  }));
  const sketch: CadSketch = {
    id,
    name,
    plane: { origin: position(...origin), orientation },
    entities: [...Object.keys(points).map((p) => ({ type: 'point' as const, id: p })), ...lines],
    constraints: [],
    solved: points,
  };
  return { sketch, elements: lines.map((l) => l.id) };
}

/** F101: F29 with 凪's crash boxes and bumper beam (`f101NagiCrash`). */
export function f101NagiCrashBiw(options: Parameters<typeof f29Biw>[0] = {}): CadDocument {
  const { box, bumper } = f101NagiCrash;
  const sketches: CadSketch[] = [];
  const features: CadFeature[] = [];
  const bodies: CadNewBody[] = [];
  const sheet = (
    id: string,
    name: string,
    l: ReturnType<typeof loop>,
    distance: number,
    color: string,
  ) => {
    sketches.push(l.sketch);
    features.push({
      id: `${id}-sheet`,
      name,
      type: 'extrudeSurface',
      inputFeatureIds: [],
      args: {
        path: { sketchId: l.sketch.id, elements: l.elements },
        distance: mm(distance),
        direction: 1,
      },
    });
    bodies.push({
      id,
      name,
      sourceFeatureId: `${id}-sheet`,
      placementFeatureId: `${id}-placement`,
      appearance: { color, opacity: 1 },
    });
  };
  // The crash boxes: square sections on the YZ plane (normal +x) at the radiator support.
  for (const [id, side, s] of [
    ['crash-box', 'L', -1],
    ['crash-box-r', 'R', 1],
  ] as const) {
    const [y0, y1] = [s * box.y - box.size / 2, s * box.y + box.size / 2];
    const [z0, z1] = [box.z, box.z + box.size];
    sheet(
      id,
      `Crash box ${side}`,
      loop(
        `${id}-section`,
        `Crash box ${side} section`,
        YZ,
        [box.fromX, 0, 0],
        [
          [y0, z0],
          [y1, z0],
          [y1, z1],
          [y0, z1],
        ],
      ),
      box.toX - box.fromX,
      '#c98f5a',
    );
  }
  // The bumper beam: a box section on the XZ plane (normal −y) at the right end, across.
  sheet(
    'bumper',
    'Bumper beam',
    loop(
      'bumper-section',
      'Bumper beam section',
      XZ,
      [0, bumper.halfWidth, 0],
      [
        [bumper.backX, bumper.z0],
        [bumper.frontX, bumper.z0],
        [bumper.frontX, bumper.z1],
        [bumper.backX, bumper.z1],
      ],
    ),
    2 * bumper.halfWidth,
    '#c98f5a',
  );
  // The hood: its side line on the XZ plane at the right edge, carried across.
  const { hood } = f101NagiCrash;
  sheet(
    'hood',
    'Hood',
    loop('hood-line', 'Hood line', XZ, [0, hood.halfWidth, 0], hood.line, true),
    2 * hood.halfWidth,
    '#c9ccd1',
  );
  return applyCadOperation(f29Biw(options), { type: 'insertFeatures', sketches, features, bodies });
}

/**
 * F99 (VS12): 凪's front brake disc, a solid grey-iron disc: the friction ring (outer radius 129,
 * inner 86, 18 thick), the hat's wall (radius 80–86) up to its mounting face (radius 30–86, 6
 * thick, 40–46 from the ring's inner face). Profile [radius, axial] (mm), revolved about the axis.
 */
export const f99Disc = Object.freeze({
  outerRadius: 129,
  ringInnerRadius: 86,
  ringThickness: 18,
  hatRadius: 80,
  boreRadius: 30,
  hatDepth: 46,
  hatThickness: 6,
  profile: Object.freeze([
    [80, 0],
    [129, 0],
    [129, 18],
    [86, 18],
    [86, 46],
    [30, 46],
    [30, 40],
    [80, 40],
  ] as readonly (readonly [number, number])[]),
});

/**
 * F99 (VS12): the brake disc as one revolved solid, its axis along Y through `origin`, the ring's
 * outboard friction face (radius 80–129) at y = origin y and the hat towards +y. Body `disc`.
 */
export function f99BrakeDisc(
  options: { origin?: [number, number, number] } = {},
  kernel: Kernel = fixtureKernel,
): CadDocument {
  const [x, y, z] = options.origin ?? [0, 0, 0];
  const b = cadBuilder(kernel);
  const profile = b.polygon(
    'Disc profile',
    { origin: [x, y, z], orientation: cadBuildPlanes.XY },
    f99Disc.profile.map(([r, a]) => [r, a] as [number, number]),
  );
  b.revolve('Disc', profile, { axisDirection: [0, 1] }, { color: '#6d6f73', opacity: 1 });
  return b.build().document;
}

/**
 * F102 / F103 (VS12): a 200 mm stretch of an exhaust pipe under a floor panel with a fuel tank on
 * it, without (F102) or with (F103) a heat shield between pipe and floor. Local frame: x along the
 * pipe, z up, the floor's underside at z = 0; the stretch's ends are cuts (no heat crosses them).
 * Sizes (mm), after 凪's rear floor: the floor 300 wide and 12 thick (the panel with its deadening,
 * thick enough for solid elements the browser can hold), the tank a 200 wide, 60 high block
 * standing on it (one solid with the floor, so heat conducts across), the pipe a 40 mm square
 * duct (about a 50 mm pipe's surface; a round one's curvature would take the browser's whole mesh)
 * with its top 30 mm below the floor, the shield 160 wide and 8 thick at z −19 to −11 (11 mm above the
 * pipe).
 */
export const f102Exhaust = Object.freeze({
  floor: { min: [0, -150, 0], size: [200, 300, 12] },
  tank: { min: [0, -100, 12], size: [200, 200, 60] },
  pipe: { side: 40, axisZ: -50, length: 200 },
  shield: { min: [0, -80, -19], size: [200, 160, 8] },
} as const);

/**
 * F102 (no shield) or F103 (`shield`): body `exhaust`, one body of separate solids (the pipe,
 * the floor with its tank, the shield) so that one heat analysis sees them all.
 */
export function f102ExhaustFloor(
  options: { shield?: boolean } = {},
  kernel: Kernel = fixtureKernel,
): CadDocument {
  const { floor, tank, pipe, shield } = f102Exhaust;
  const b = cadBuilder(kernel);
  // A box's origin is its min corner.
  const at = (m: readonly number[]) => [m[0]!, m[1]!, m[2]!] as [number, number, number];
  const floorId = b.box(
    'Exhaust',
    { origin: at(floor.min), size: [...floor.size] },
    { color: '#8a8f96', opacity: 1 },
  );
  const tankId = b.box('Tank', { origin: at(tank.min), size: [...tank.size] });
  b.boolean(floorId, [tankId], 'union', 'Exhaust');
  const pipeId = b.box('Pipe', {
    origin: [0, -pipe.side / 2, pipe.axisZ - pipe.side / 2],
    size: [pipe.length, pipe.side, pipe.side],
  });
  const tools = [pipeId];
  if (options.shield)
    tools.push(b.box('Shield', { origin: at(shield.min), size: [...shield.size] }));
  b.boolean(floorId, tools, 'union', 'Exhaust');
  return b.build().document;
}

/** The skin's half width at drawing x `d` and height `z` (mm), on the section's points. */
function skinHalfWidth(d: number, z: number): number {
  const s = f95Section(d);
  // The left half, crown to the rocker (y ≤ 0, z falling): the side's |y| at z.
  const half = s.slice(0, 8);
  for (let i = 1; i < half.length; i++) {
    const [a, b] = [half[i - 1]!, half[i]!];
    if ((z <= a[1] && z >= b[1]) || (z >= a[1] && z <= b[1])) {
      const t = (z - a[1]) / (b[1] - a[1] || 1);
      return -(a[0] + t * (b[0] - a[0]));
    }
  }
  return 0;
}
/** The skin's top (crown side) height at drawing x `d` and half width `y` ≥ 0 (mm). */
function skinTop(d: number, y: number): number {
  const s = f95Section(d).slice(0, 6);
  for (let i = 1; i < s.length; i++) {
    const [a, b] = [s[i - 1]!, s[i]!];
    if (-y <= a[0] && -y >= b[0]) {
      const t = (-y - a[0]) / (b[0] - a[0] || 1);
      return a[1] + t * (b[1] - a[1]);
    }
  }
  return s.at(-1)![1];
}

/** A rounded rectangle [u0, u1] × [v0, v1] with corner radius `r` in a sketch's u/v. */
export interface F95Outline {
  u: [number, number];
  v: [number, number];
  r: number;
}
const grown = (o: F95Outline, by: number): F95Outline => ({
  u: [o.u[0] - by, o.u[1] + by],
  v: [o.v[0] - by, o.v[1] + by],
  r: Math.max(1, o.r + by),
});

/**
 * VS9 (docs/cad/vehicle-simulation.md, V3): the openings of 凪's water model and their pockets.
 * Each opening is a rounded outline on a plane (`plane`: origin, orientation; the outline's u/v
 * in it) whose normal points out of the car; the pocket floor lies on that plane, `depth` mm
 * under the skin at its shallowest. Doors are in drawing x / z on the sides (the floor square to
 * y), the hood and the rear lid on planes tilted along the deck.
 */
export const f95WaterOpenings = (() => {
  const door = { d: [1600, 2480] as [number, number], z: [300, 0] as [number, number] };
  // The door top 30 mm under the shoulder at its lowest over the door.
  let top = Infinity;
  let side = Infinity;
  for (let d = door.d[0]; d <= door.d[1]; d += 20) {
    top = Math.min(top, polyAt(lines.S, d) - 30);
  }
  for (let d = door.d[0] - 20; d <= door.d[1] + 20; d += 20)
    for (let z = door.z[0] - 20; z <= top + 20; z += 20) side = Math.min(side, skinHalfWidth(d, z));
  door.z[1] = Math.round(top);
  /** The door floor's |y|: 45 mm in from the side at its narrowest. */
  const doorFloor = Math.floor(side - 45);
  // Car x of the door (the outline's u runs along car x on XZ).
  const doorOutline: F95Outline = { u: [X(door.d[1]), X(door.d[0])], v: [...door.z], r: 60 };
  /** A deck opening between drawing x `d0` (front) and `d1` with half width `w`. */
  const deck = (d0: number, d1: number, w: number) => {
    // The floor plane through the skin 45 mm under its lowest along the line, tilted along x.
    const zf = (d: number) => {
      let low = Infinity;
      for (let y = 0; y <= w + 20; y += 20) low = Math.min(low, skinTop(d, y));
      return low;
    };
    const [x0, x1] = [X(d1), X(d0)];
    const [z0, z1] = [zf(d1), zf(d0)];
    const m = (z1 - z0) / (x1 - x0);
    let lift = Infinity;
    for (let d = d0 - 20; d <= d1 + 20; d += 20) {
      const x = X(d);
      lift = Math.min(lift, zf(d) - (z0 + m * (x - x0)));
    }
    const beta = Math.atan(-m);
    const origin: [number, number, number] = [x0, 0, z0 + lift - 45];
    const orientation: Quaternion = [0, Math.sin(beta / 2), 0, Math.cos(beta / 2)];
    const length = (x1 - x0) / Math.cos(beta);
    return { origin, orientation, outline: { u: [0, length], v: [-w, w], r: 80 } as F95Outline };
  };
  const XZq: Quaternion = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
  return Object.freeze({
    doorFloor,
    'door-l': { origin: [0, -doorFloor, 0], orientation: XZq, outline: doorOutline, side: 1 },
    'door-r': { origin: [0, doorFloor, 0], orientation: XZq, outline: doorOutline, side: -1 },
    hood: { ...deck(220, 1420, 520), side: 1 },
    lid: { ...deck(2820, 3700, 560), side: 1 },
  } as Record<
    'door-l' | 'door-r' | 'hood' | 'lid',
    {
      origin: [number, number, number];
      orientation: Quaternion;
      outline: F95Outline;
      /** 1: the plane's normal points out of the car; −1: against it (the right door). */
      side: 1 | -1;
    }
  > & { doorFloor: number });
})();

export interface F95WaterOptions {
  /** The panel gap round each opening (mm, default 4). */
  gap?: number;
  /** The space between a closure's inner face and the pocket floor (mm, default 10). */
  clearance?: number;
  /** Which closures (default all four). */
  openings?: readonly F95WaterOpening[];
}
export type F95WaterOpening = 'door-l' | 'door-r' | 'hood' | 'lid';
type WaterPlane = (typeof f95WaterOpenings)['hood'];

/** The opening's plane moved `offset` mm out along its outward normal. */
function planeOut(o: WaterPlane, offset: number) {
  const [qx, qy, qz, qw] = o.orientation;
  const n = [2 * (qx * qz + qy * qw), 2 * (qy * qz - qx * qw), 1 - 2 * (qx * qx + qy * qy)].map(
    (c) => c * o.side,
  );
  return {
    origin: [
      o.origin[0] + n[0]! * offset,
      o.origin[1] + n[1]! * offset,
      o.origin[2] + n[2]! * offset,
    ] as [number, number, number],
    orientation: o.orientation,
  };
}

/**
 * VS9: a pocket round an opening and its closure, on body `body`. `copy` is a fresh copy of the
 * body for the closure. The pocket is cut later (all at once, `pockets`): a prism `gap / 2`
 * outside the outline from the floor plane outwards. The closure is the copy's part inside a
 * prism `gap / 2` inside the outline, from `clearance` above the floor outwards. Names: the
 * closure `name`, its tool `${name} cut`, the pocket tool `${name} pocket`.
 */
function waterClosure(
  b: ReturnType<typeof cadBuilder>,
  name: string,
  o: WaterPlane,
  copy: string,
  gap: number,
  clearance: number,
) {
  const prism = (tool: string, outline: F95Outline, offset: number) =>
    b.extrude(
      tool,
      roundedOutline(b, `${tool} line`, planeOut(o, offset), outline),
      2000,
      undefined,
      o.side,
    );
  b.boolean(copy, [prism(`${name} cut`, grown(o.outline, -gap / 2), clearance)], 'common', name);
  return prism(`${name} pocket`, grown(o.outline, gap / 2), 0);
}

/**
 * VS9 (docs/cad/vehicle-simulation.md, V3): 凪's water model, an F95 variant. The skin `Body`
 * with a pocket cut under each opening (both doors, the hood and the rear lid): its walls
 * `gap / 2` outside the opening's outline (`f95WaterOpenings`), its floor (where the seal runs) on
 * the opening's plane. Each closure is the skin inside the outline shrunk by `gap / 2`, down to
 * `clearance` above the floor: its outer face is the skin, its inner face (the one the seal
 * presses on) flat. The closures are modelled shut; a seal's hinge turns one open (VS9). The hard
 * top is its own body over the skin, as in F95 (their union is refused by the kernel). Bodies
 * `body`, `hard-top`, `door-l`, `door-r`, `hood`, `lid`.
 */
export function f95NagiWater(
  options: F95WaterOptions = {},
  kernel: Kernel = fixtureKernel,
): CadDocument {
  const gap = options.gap ?? 4;
  const clearance = options.clearance ?? 10;
  const openings = options.openings ?? (['door-l', 'door-r', 'hood', 'lid'] as const);
  const b = cadBuilder(kernel);
  const sections = f95SectionX.map((d, i) =>
    b.closedSpline(
      `Skin section ${i + 1}`,
      { origin: [X(d), 0, 0], orientation: YZ },
      f95Section(d),
      { through: true },
    ),
  );
  const skin = b.loft('Body', sections, false, { color: '#c9ccd1', opacity: 1 });
  const rows: [number, number, number][] = [
    [2735, 690, 905],
    [2680, 695, 1140],
    [2600, 700, 1240],
    [2400, 705, 1247],
    [2150, 705, 1240],
    [1950, 705, 1222],
    [1760, 728, 1050],
    [1575, 745, 860],
  ];
  b.loft(
    'Hard top',
    rows.map(([d, w, z1], i) =>
      b.closedSpline(
        `Top section ${i + 1}`,
        { origin: [X(d), 0, 0], orientation: YZ },
        rounded(w, 780, z1, 0.88),
        { through: true },
      ),
    ),
    false,
    { color: '#1b1d21', opacity: 1 },
  );
  const pockets = openings.map((id) =>
    waterClosure(
      b,
      f95WaterNames[id],
      f95WaterOpenings[id],
      b.loft(f95WaterNames[id], sections, false, { color: '#aeb6c0', opacity: 1 }),
      gap,
      clearance,
    ),
  );
  b.boolean(skin, pockets, 'cut', 'Pockets');
  return b.build().document;
}
export const f95WaterNames: Record<F95WaterOpening, string> = Object.freeze({
  'door-l': 'Door L',
  'door-r': 'Door R',
  hood: 'Hood',
  lid: 'Lid',
});

/**
 * VS9: each opening's hinge (a point on the axis and its direction, so a positive angle opens
 * the closure, right hand): the doors' front edges (vertical), the hood's front edge and the
 * lid's back edge (across the car).
 */
export const f95WaterHinges: Record<
  F95WaterOpening,
  { origin: [number, number, number]; axis: [number, number, number] }
> = (() => {
  const door = f95WaterOpenings['door-l'].outline;
  const y = f95WaterOpenings.doorFloor + 60;
  const hood = f95WaterOpenings.hood;
  const lid = f95WaterOpenings.lid;
  const along = (o: WaterPlane, u: number) => {
    const [, qy, , qw] = o.orientation;
    const beta = 2 * Math.atan2(qy, qw);
    return [o.origin[0] + u * Math.cos(beta), 0, o.origin[2] - u * Math.sin(beta) + 40] as [
      number,
      number,
      number,
    ];
  };
  return Object.freeze({
    // The front edge (car x of the outline's high u); the rear swings out (−y on the left).
    'door-l': {
      origin: [door.u[1], -y, 0] as [number, number, number],
      axis: [0, 0, 1] as [number, number, number],
    },
    'door-r': {
      origin: [door.u[1], y, 0] as [number, number, number],
      axis: [0, 0, -1] as [number, number, number],
    },
    // The hood hinges at its back edge (by the screen) and lifts its front; the lid at its front.
    hood: { origin: along(hood, 0), axis: [0, -1, 0] as [number, number, number] },
    lid: { origin: along(lid, lid.outline.u[1]), axis: [0, 1, 0] as [number, number, number] },
  });
})();

/** F98's box, opening (in the top's x / y, mm) and the space under its lid. */
export const f98GapBox = Object.freeze({
  size: [600, 400, 300] as [number, number, number],
  /** The lid's outline on the top, round the box's middle. */
  outline: { u: [-200, 200], v: [-120, 120], r: 30 } as F95Outline,
  /** The pocket floor 40 mm under the top. */
  depth: 40,
});

/**
 * F98 (docs/cad/vehicle-simulation.md, VS10 試験): the gap box. A closed box (600 × 400 × 300,
 * on the ground, centred on x = y = 0) with a lid pocket in its top: the floor `depth` under the
 * top, the walls `gap / 2` outside the lid's outline; the lid is the box's top inside the outline
 * shrunk by `gap / 2`, down to `clearance` above the floor. The water tests spray its top and
 * look for water inside the seal. Bodies `box` and `lid`.
 */
export function f98GapBoxDoc(
  options: { gap?: number; clearance?: number } = {},
  kernel: Kernel = fixtureKernel,
): CadDocument {
  const gap = options.gap ?? 4;
  const clearance = options.clearance ?? 10;
  const b = cadBuilder(kernel);
  const [sx, sy, sz] = f98GapBox.size;
  const box = (name: string) =>
    b.box(
      name,
      { origin: [-sx / 2, -sy / 2, 0], size: [sx, sy, sz] },
      { color: '#c9ccd1', opacity: 1 },
    );
  const body = box('Box');
  const plane: WaterPlane = {
    origin: [0, 0, sz - f98GapBox.depth],
    orientation: [0, 0, 0, 1],
    outline: f98GapBox.outline,
    side: 1,
  };
  const pocket = waterClosure(b, 'Lid', plane, box('Lid'), gap, clearance);
  b.boolean(body, [pocket], 'cut', 'Pocket');
  return b.build().document;
}

/**
 * VS9: the seal round opening `name` (a `waterClosure`) of a water model, as CAD references: the
 * eight edges where the pocket floor meets its walls (the line), the floor (the base), and the
 * closure's flat inner face (the mating face), on the bodies' result features `bodyFeature` and
 * `closureFeature`. `centre` is a point of the floor, for the references' hints.
 */
export function waterSealRefs(
  name: string,
  bodyFeature: string,
  closureFeature: string,
  centre: [number, number, number],
) {
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const floor = [`tool:${id}-pocket-placement`, 'start'];
  const inner = [`tool:${id}-cut-placement`, 'start'];
  const sides = ['bottom', 'corner-a', 'right', 'corner-b', 'top', 'corner-c', 'left', 'corner-d'];
  const hint = { centroid: centre, size: 100 };
  return {
    line: sides.map((s) => ({
      kind: 'edge' as const,
      featureId: bodyFeature,
      name: edgeName(floor, [`tool:${id}-pocket-placement`, `side:e:${s}`]),
      hint,
    })),
    base: { kind: 'face' as const, featureId: bodyFeature, name: [floor], hint },
    mating: { kind: 'face' as const, featureId: closureFeature, name: [inner], hint },
  };
}

/** A rounded rectangle sketch section (lines and quarter arcs, anticlockwise). */
function roundedOutline(
  b: ReturnType<typeof cadBuilder>,
  name: string,
  plane: { origin: [number, number, number]; orientation: Quaternion },
  o: F95Outline,
) {
  const [u0, u1] = o.u;
  const [v0, v1] = o.v;
  const r = Math.min(o.r, (u1 - u0) / 2 - 1, (v1 - v0) / 2 - 1);
  const p: Record<string, [number, number]> = {
    a0: [u0 + r, v0],
    a1: [u1 - r, v0],
    b0: [u1, v0 + r],
    b1: [u1, v1 - r],
    c0: [u1 - r, v1],
    c1: [u0 + r, v1],
    d0: [u0, v1 - r],
    d1: [u0, v0 + r],
    ka: [u1 - r, v0 + r],
    kb: [u1 - r, v1 - r],
    kc: [u0 + r, v1 - r],
    kd: [u0 + r, v0 + r],
  };
  const sketchId = b.sketch(name, plane, p, [
    { type: 'line', id: 'bottom', start: 'a0', end: 'a1' },
    { type: 'arc', id: 'corner-a', center: 'ka', start: 'a1', end: 'b0', clockwise: false },
    { type: 'line', id: 'right', start: 'b0', end: 'b1' },
    { type: 'arc', id: 'corner-b', center: 'kb', start: 'b1', end: 'c0', clockwise: false },
    { type: 'line', id: 'top', start: 'c0', end: 'c1' },
    { type: 'arc', id: 'corner-c', center: 'kc', start: 'c1', end: 'd0', clockwise: false },
    { type: 'line', id: 'left', start: 'd0', end: 'd1' },
    { type: 'arc', id: 'corner-d', center: 'kd', start: 'd1', end: 'a0', clockwise: false },
  ]);
  return {
    sketchId,
    region: {
      outer: ['bottom', 'corner-a', 'right', 'corner-b', 'top', 'corner-c', 'left', 'corner-d'],
      holes: [],
    },
  };
}
