/**
 * CL6 (docs/cad/car-look-process.md, 面): 「翔」's skin from its line drawing (F140, variant C
 * 「Canopy」). The lines drawn in two views become 3D character lines (CLF2's `twoView`), and the
 * skin is two curve networks (CR1d) through them, each made on the right half (+y) and mirrored:
 *
 * - The body, from the centre of the deck down to the lower edge: sections across the car (YZ)
 *   at stations along it, crossed by five lengthwise lines (the deck's centre, the deck's edge,
 *   the shoulder, the widest line and the lower edge).
 * - The canopy over it: sections from the roof's centre down to the belt, crossed by the roof's
 *   centre, its crown's shoulder, its side and its foot on the belt (the plan's greenhouse).
 *
 * Every lengthwise line passes through the stations' points exactly (a spline through points in
 * each view), and every section through its line's points, so the curves meet where the network
 * needs them to. Same frame as F82: x back from the front axle, y to the driver's (right) side,
 * z up.
 */
import { edgeRef, fixtureKernel } from './fixtures';
import { applyCadOperation } from './operations';
import {
  identityQuaternion,
  position,
  mm,
  type CadAppearance,
  type CadCurveSource,
  type CadDocument,
  type CadKernelProfile,
  type Length,
} from './model';
import type { CadFaceName } from './topology';
import { splinePointAt, splineThrough, type CadSketch } from './sketch';
import type { CadNewBody } from './operations';
import { f140Package, f140Variant, f84Poles, type F84Variant } from './car-look-lines';
import { f82Rules } from './car-look-package';

type V2 = readonly [number, number];
type Kernel = Pick<CadKernelProfile, 'id' | 'buildHash'>;

/**
 * The value of a CL4 line (its points are a B-spline's poles, as the sketch stores them) at `u`,
 * found on the curve's own parameter by bisection, so it is exact (the line must run one way
 * along u). Undefined off its range.
 */
export function f141At(points: readonly V2[], u: number): number | undefined {
  return polesAt(f84Poles(points), u);
}
function polesAt(poles: readonly V2[], u: number): number | undefined {
  const degree = Math.min(3, poles.length - 1);
  const spans = poles.length - degree;
  const at = (t: number) => splinePointAt(poles, degree, false, t);
  const [u0, u1] = [poles[0]![0], poles.at(-1)![0]];
  if (u < Math.min(u0, u1) - 1e-9 || u > Math.max(u0, u1) + 1e-9) return undefined;
  const dir = Math.sign(u1 - u0);
  let [a, b] = [0, spans];
  for (let i = 0; i < 60; i++) {
    const m = (a + b) / 2;
    if ((at(m)[0] - u) * dir < 0) a = m;
    else b = m;
  }
  return at((a + b) / 2)[1];
}

/**
 * CL6b: F140's lines with the canopy's plan made a teardrop. In CL6a the plan's greenhouse (CL4)
 * was as wide at its ends (560 and 480 mm) as in the middle, so the canopy read as a box from
 * above; back on the line drawing (N3), its ends close in to 300 mm and its widest moves over
 * the heads.
 *
 * CL6c: the front fender raised. CL4's shoulder ran 713 mm over the front axle, 33 mm above the
 * tyre and under the arch's top (770 mm: the tyre at full bump with the arch gap), so the arch
 * bit into the hood and left no room for a flare. Its pole over the axle goes from 800 to 980 mm:
 * the shoulder then runs about 820 mm there, above the hood's drawn centre (800 mm), so the
 * fenders stand up to 30 mm proud of a hood valley between them.
 */
export const f141Variant: F84Variant = Object.freeze({
  ...f140Variant,
  side: {
    ...f140Variant.side,
    shoulder: f140Variant.side.shoulder.map((p) => (p[0] === 0 ? ([0, 980] as V2) : p)),
  },
  plan: {
    ...f140Variant.plan,
    greenhouse: [
      [470, 300],
      [950, 700],
      [1550, 690],
      [2000, 300],
    ] as V2[],
  },
});

/** Stations of the body's sections along x, from the nose to the tail's face. */
export const f141BodyStations = [
  -950, -800, -600, -350, -100, 200, 450, 800, 1200, 1600, 2000, 2400, 2800, 3150, 3400,
] as const;
/** Stations of the canopy's sections, where its roof stands clear of the deck. */
export const f141CanopyStations = [500, 600, 800, 1000, 1200, 1400, 1600, 1800, 1950] as const;

/** CL7a: the lower edge's points between the wheels (a fair rocker, see `f141BodyLines`). */
export const f141Rocker: readonly V2[] = [
  [450, 170],
  [1300, 166],
  [1800, 181],
];

/** A smooth line through points, read at u (a spline through them, exact by bisection). */
function through(points: readonly V2[]) {
  const poles = splineThrough(points, 3, false);
  return (u: number) => polesAt(poles, u)!;
}

/**
 * The body's five lengthwise lines at x, as (y, z) on the right half: the deck's centre, the
 * deck's edge, the shoulder, the widest line and the lower edge. Taken from the CL4 lines:
 * the side profile (and under the canopy a deck line between its ends), the side shoulder and
 * rocker, the plan outline; the front view's proportions place the widest line and the edges.
 */
export function f141BodyLines(
  v: F84Variant = f141Variant,
  hoodShoulder: readonly V2[] = f140Variant.side.shoulder,
) {
  const s = v.side;
  const outline = (x: number) => f141At(v.plan.outline, x)!;
  const profile = (x: number) => f141At(s.profile, x)!;
  const canopy = [s.belt[0]![0], 1850] as const;
  // Under the canopy the deck runs from the cowl to where the roof meets the fastback.
  const deck = through([
    [canopy[0] - 150, profile(canopy[0] - 150)],
    [canopy[0], profile(canopy[0])],
    [900, 845],
    [1400, 960],
    [canopy[1], profile(canopy[1])],
    [canopy[1] + 150, profile(canopy[1] + 150)],
  ]);
  const centre = (x: number) => (x > canopy[0] && x < canopy[1] ? deck(x) : profile(x));
  // The shoulder carried on straight past its drawn ends (the nose and the tail's face).
  const along = (sh: readonly V2[]) => (x: number) => {
    if (x < sh[0]![0]) {
      const [a, b] = [sh[0]!, sh[1]!];
      return a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]);
    }
    if (x > sh.at(-1)![0]) return sh.at(-1)![1];
    return f141At(sh, x)!;
  };
  const shoulderZ = along(s.shoulder);
  // The hood's camber follows the shoulder as CL4 drew it: where CL6c raised the fenders over
  // the front wheels, the fenders stand above the hood between them (a valley, as the Le Mans
  // cars' canopy bodies) and the side profile keeps its drawn line.
  const hoodShoulderZ = along(hoodShoulder);
  // The lower edge: the splitter's and the diffuser's edges at the ends and a fair rocker
  // between the wheels. CL7a: through the drawn rocker's points the edge sagged to 150 mm at the
  // door and climbed 80 mm to 230 mm in half a metre before levelling off, an S that the finer
  // zebra showed as waves along the lower side. Between the wheels it now runs through
  // `f141Rocker` instead, which dips 4 mm under the door and rises steadily: behind the front
  // arch the edge bends one way only, it keeps CL6's points at the wheels (the flares' split
  // lines meet it there) and stays within 50 mm of the drawn rocker.
  const lower = through([
    [-950, 270],
    [-500, 200],
    [0, 185],
    ...f141Rocker,
    [2650, 260],
    [3400, 380],
  ]);
  return (x: number) => {
    const w = outline(x);
    // At least 60 mm of camber from the drawn shoulder up to the deck's centre.
    const c = Math.max(centre(x), hoodShoulderZ(x) + 60);
    const zs = shoulderZ(x);
    const zl = lower(x);
    // The widest line at 64 % of the way from the lower edge to the shoulder (the front view's
    // 560 between 170 and 780).
    const zw = zl + 0.64 * (zs - zl);
    return {
      centre: [0, c] as V2,
      deckEdge: [0.62 * w, zs + 0.6 * (c - zs)] as V2,
      shoulder: [0.93 * w, zs] as V2,
      widest: [w, zw] as V2,
      lower: [0.9 * w, zl] as V2,
    };
  };
}

/**
 * The canopy's four lengthwise lines at x: the roof's centre (the side's daylight opening), the crown's
 * shoulder, the canopy's side (a tenth of the way down from the roof, at 80 % of the foot's width: the tumblehome) and
 * the foot on the belt (the plan's greenhouse at the side's belt height, sunk 40 mm into the
 * deck).
 */
export function f141CanopyLines(v: F84Variant = f141Variant) {
  const s = v.side;
  return (x: number) => {
    // The roof's centre is the daylight opening's top: it meets the belt at both ends, so the
    // canopy tapers into the deck there.
    const roof = f141At(s.dlo, x)!;
    const belt = f141At(s.belt, x)! - 40;
    const foot = f141At(v.plan.greenhouse, x)!;
    return {
      centre: [0, roof] as V2,
      crown: [0.45 * foot, roof - 0.08 * (roof - belt)] as V2,
      side: [0.8 * foot, roof - 0.35 * (roof - belt)] as V2,
      foot: [foot, belt] as V2,
    };
  };
}

const YZ = [0.5, 0.5, 0.5, 0.5] as [number, number, number, number];
const XZ = [Math.SQRT1_2, 0, 0, Math.SQRT1_2] as [number, number, number, number];

/** A sketch of one cubic spline `c` through `points` on `plane`. */
function splineSketch(
  id: string,
  name: string,
  plane: CadSketch['plane'],
  points: readonly V2[],
): CadSketch {
  const poles = splineThrough(points, 3, false);
  const solved = Object.fromEntries(poles.map((p, i) => [`p${i}`, [p[0], p[1]]])) as Record<
    string,
    [number, number]
  >;
  return {
    id,
    name,
    plane,
    entities: [
      ...Object.keys(solved).map((p) => ({ type: 'point' as const, id: p })),
      { type: 'spline', id: 'c', poles: Object.keys(solved), degree: 3 },
    ],
    constraints: [],
    solved,
  };
}

/**
 * One curve network: sections at `stations` (YZ, from the first line to the last) and each
 * lengthwise line, a spline in the side view (XZ) and one in the plan (XY) through the stations'
 * points, as a `twoView` curve (a line on the centre, y = 0, is the side view alone).
 */
function network(
  prefix: string,
  name: string,
  stations: readonly number[],
  lines: (x: number) => Record<string, V2>,
) {
  const at = stations.map((x) => ({ x, l: lines(x) }));
  const keys = Object.keys(at[0]!.l);
  const sections = at.map(({ x, l }, i) =>
    splineSketch(
      `${prefix}-u${i}`,
      `${name} section ${i + 1}`,
      { origin: position(x, 0, 0), orientation: YZ },
      keys.map((k) => l[k]!),
    ),
  );
  const sketches: CadSketch[] = [...sections];
  const v: CadCurveSource[] = keys.map((k) => {
    const side = splineSketch(
      `${prefix}-${k}-side`,
      `${name} ${k} side`,
      { origin: position(0, 0, 0), orientation: XZ },
      at.map(({ x, l }) => [x, l[k]![1]]),
    );
    sketches.push(side);
    if (at.every(({ l }) => l[k]![0] === 0)) return { sketchId: side.id, element: 'c' };
    const plan = splineSketch(
      `${prefix}-${k}-plan`,
      `${name} ${k} plan`,
      { origin: position(0, 0, 0), orientation: identityQuaternion() },
      at.map(({ x, l }) => [x, l[k]![0]]),
    );
    sketches.push(plan);
    return {
      twoView: {
        side: { sketchId: side.id, element: 'c' },
        plan: { sketchId: plan.id, element: 'c' },
      },
    };
  });
  return {
    sketches,
    feature: {
      id: prefix,
      name,
      type: 'curveNetwork' as const,
      inputFeatureIds: [] as [],
      args: {
        u: sections.map((s) => ({ sketchId: s.id, element: 'c' })),
        v,
        toleranceMm: 0.1,
      },
    },
  };
}

/**
 * A planar cap closing the skin's open end at station x: the right section, the bottom across
 * and the left section, drawn on one YZ sketch and filled (its edges are the sections' own, so
 * the cap meets the skin).
 */
function cap(id: string, name: string, x: number, points: readonly V2[]) {
  const right = splineThrough(points, 3, false);
  const left = right.map(([y, z]) => [-y, z] as [number, number]);
  const solved: Record<string, [number, number]> = {};
  right.forEach((p, i) => (solved[`r${i}`] = [p[0], p[1]]));
  left.forEach((p, i) => (solved[`l${i}`] = [p[0], p[1]]));
  const last = right.length - 1;
  const sketch: CadSketch = {
    id: `${id}-loop`,
    name: `${name} loop`,
    plane: { origin: position(x, 0, 0), orientation: YZ },
    entities: [
      ...Object.keys(solved).map((p) => ({ type: 'point' as const, id: p })),
      { type: 'spline', id: 'r', poles: right.map((_, i) => `r${i}`), degree: 3 },
      { type: 'spline', id: 'l', poles: left.map((_, i) => `l${i}`), degree: 3 },
      { type: 'line', id: 'b', start: `r${last}`, end: `l${last}` },
    ],
    constraints: [],
    solved,
  };
  return {
    sketch,
    feature: {
      id,
      name,
      type: 'fill' as const,
      inputFeatureIds: [] as [],
      args: {
        boundary: ['r', 'b', 'l'].map((e) => ({
          curve: { sketchId: sketch.id, element: e },
          continuity: 'G0' as const,
        })),
      },
    },
  };
}

/**
 * CL6b: a wheel's arch as a circle on the side (two arcs, so it never starts where the skin's
 * edge would split), round `z` (the tyre's centre at full bump) with radius `r`. The sketch's x
 * runs down (as F25's arches), so the arcs' angles never cross a start.
 */
function archSketch(
  id: string,
  name: string,
  x: number,
  z: number,
  r: number,
  [from, to]: [number, number] = [-20, 200],
  closed = true,
): CadSketch {
  const pt = (deg: number): [number, number] => [
    -r * Math.sin((deg * Math.PI) / 180),
    r * Math.cos((deg * Math.PI) / 180),
  ];
  const solved: Record<string, [number, number]> = { c: [0, 0], s: pt(from), e: pt(to) };
  return {
    id,
    name,
    plane: { origin: position(x, 0, z), orientation: [0.5, 0.5, -0.5, 0.5] },
    entities: [
      ...Object.keys(solved).map((p) => ({ type: 'point' as const, id: p })),
      { type: 'arc', id: 'a0', center: 'c', start: 's', end: 'e', clockwise: false },
      ...(closed
        ? [{ type: 'arc' as const, id: 'a1', center: 'c', start: 'e', end: 's', clockwise: false }]
        : []),
    ],
    constraints: [],
    solved,
  };
}

/**
 * The arches hold the package's wheel envelope (CL2, F82's `package-side`): the tyre at full bump
 * (its centre `bump` mm up) with the arch gap round it (Codex on #1243: a static circle 45 mm
 * larger left the bumped tyre 25 mm outside).
 */
export const f141Arch = (diameter: number) => ({
  z: diameter / 2 + f82Rules.bump,
  r: diameter / 2 + f82Rules.archGap,
});
/**
 * CL6c: the flares, F25's way (CR2d): the skin split along a line `f141FlareLine` mm outside the
 * arch, the arch moved `f141FlareHeight` mm out and joined back G1 (G2 missed its check at the
 * rear). CL5's fender stood 12.4 mm proud of the body; the flare makes it read from the front
 * and the rear three-quarter. The front line stays 25 mm out: at 40 mm it ran by the shoulder's
 * crease and the fill's seam opened 0.9 mm.
 */
export const f141FlareLine = { front: 25, rear: 40 } as const;
export const f141FlareHeight = 22;
/**
 * The arches' arcs (degrees, from the front through the top to the rear, 0 level with the
 * axle): their ends below the skin's lower edge, so the arc a0 is the whole arch on the skin.
 */
const archArc: [number, number] = [-45, 225];
/**
 * CL6c: the side intake ahead of the rear wheel (side view, x and z in mm): a scoop whose point
 * leads forward along the door's lower half and whose mouth stands upright ahead of the rear
 * flare, under the widest line, cut from the skin.
 */
export const f141Intake: readonly V2[] = [
  [1700, 470],
  [1850, 535],
  [2060, 555],
  [2120, 490],
  [2070, 415],
  [1850, 425],
];

const paint: CadAppearance = { color: '#c9ccd1', opacity: 1 };
const glass: CadAppearance = { color: '#1f2a36', opacity: 0.85 };
const duct: CadAppearance = { color: '#15181c', opacity: 1 };

/**
 * F141: F140 with the skin. The body and the canopy, each a curve network on the right half and
 * its mirror copy across y = 0 (four bodies: Body right/left, Canopy right/left).
 */
export function f141Package(v: F84Variant = f141Variant, kernel: Kernel = fixtureKernel) {
  const doc = f140Package(v, kernel);
  const body = network('skin-body', 'Body', f141BodyStations, f141BodyLines(v));
  const canopy = network('skin-canopy', 'Canopy', f141CanopyStations, f141CanopyLines(v));
  const lines = f141BodyLines(v);
  const ends = (
    [
      ['skin-nose', 'Nose', f141BodyStations[0]],
      ['skin-tail', 'Tail', f141BodyStations.at(-1)!],
    ] as const
  ).map(([id, name, x]) => cap(id, name, x, Object.values(lines(x))));
  const mirrored = (id: string) => ({
    id: `${id}-left`,
    name: `${id} left`,
    type: 'mirrorCopy' as const,
    inputFeatureIds: [] as [],
    args: {
      source: { featureId: id },
      plane: { origin: position(0, 0, 0), normal: [0, 1, 0] as [number, number, number] },
    },
  });
  const bodyOf = (id: string, name: string, look: CadAppearance): CadNewBody => ({
    id: `${id}-body`,
    name,
    sourceFeatureId: id,
    placementFeatureId: `${id}-placement`,
    appearance: look,
  });
  const r = f82Rules;
  const wheels = [
    { end: 'front', name: 'Front', x: 0, diameter: r.tyre.front.diameter },
    { end: 'rear', name: 'Rear', x: r.wheelbase, diameter: r.tyre.rear.diameter },
  ] as const;
  const arches = wheels.map((w) =>
    archSketch(
      `skin-${w.end}-wheel`,
      `${w.name} arch`,
      w.x,
      f141Arch(w.diameter).z,
      f141Arch(w.diameter).r,
      archArc,
    ),
  );
  // Two open splines (a trim takes a chain, not a loop alone): over the top from the point to
  // the mouth's middle, and back along the bottom; they share their ends.
  const top = splineThrough(f141Intake.slice(0, 4), 3, false);
  const bottom = splineThrough([...f141Intake.slice(3), f141Intake[0]!], 3, false);
  const intakeSolved: Record<string, [number, number]> = {};
  const ids = (poles: [number, number][], tag: string, first: string, last?: string) =>
    poles.map((p, i) => {
      const id = i === 0 ? first : i === poles.length - 1 && last ? last : `${tag}${i}`;
      intakeSolved[id] = [p[0], p[1]];
      return id;
    });
  const topIds = ids(top, 't', 'tip', 'mouth');
  const bottomIds = ids(bottom, 'b', 'mouth', 'tip');
  const intake: CadSketch = {
    id: 'skin-intake-line',
    name: 'Side intake',
    plane: { origin: position(0, 0, 0), orientation: XZ },
    entities: [
      ...Object.keys(intakeSolved).map((p) => ({ type: 'point' as const, id: p })),
      { type: 'spline', id: 'top', poles: topIds, degree: 3 },
      { type: 'spline', id: 'bottom', poles: bottomIds, degree: 3 },
    ],
    constraints: [],
    solved: intakeSolved,
  };
  const flareLines = wheels.map((w) =>
    archSketch(
      `skin-${w.end}-flare-line`,
      `${w.name} flare line`,
      w.x,
      f141Arch(w.diameter).z,
      f141Arch(w.diameter).r + f141FlareLine[w.end],
      archArc,
      false,
    ),
  );
  let next = applyCadOperation(doc as CadDocument, {
    type: 'insertFeatures',
    parameters: [],
    sketches: [
      ...body.sketches,
      ...canopy.sketches,
      ...ends.map((e) => e.sketch),
      ...arches,
      ...flareLines,
      intake,
    ],
    features: [
      body.feature,
      canopy.feature,
      ...([1, -1] as const).map((side) => ({
        id: `skin-intake-duct-${side > 0 ? 'right' : 'left'}`,
        name: `Intake duct ${side > 0 ? 'right' : 'left'}`,
        type: 'box' as const,
        inputFeatureIds: [] as [],
        args: {
          size: [mm(440), mm(240), mm(240)] as [Length, Length, Length],
          origin: position(1690, side > 0 ? 600 : -840, 330),
          orientation: identityQuaternion(),
        },
      })),
    ],
    bodies: [
      bodyOf('skin-body', 'Body right', paint),
      bodyOf('skin-canopy', 'Canopy right', glass),
      // Dark ducts behind the intakes, so the openings read as intakes, not holes.
      bodyOf('skin-intake-duct-right', 'Intake duct right', duct),
      bodyOf('skin-intake-duct-left', 'Intake duct left', duct),
    ],
  });
  // The arches trimmed out of the body's right half; the left is its mirror.
  for (const a of arches) {
    const id = a.id.replace('wheel', 'arch');
    const on = next.bodies.find((b) => b.id === 'skin-body-body')!;
    next = applyCadOperation(next, {
      type: 'detailBody',
      bodyId: on.id,
      placementFeatureId: `${id}-placement`,
      feature: {
        id,
        name: a.name,
        type: 'trim',
        inputFeatureIds: [on.resultFeatureId],
        args: { tool: { sketchId: a.id, elements: ['a0', 'a1'] }, keep: 'outside' },
      },
    });
  }
  // The flares, the rear's first (as F25): the skin's face and the arch's edge by their names
  // after the trims, each carrying the first flare's prefix for the second.
  const skinFace: CadFaceName = [
    'trim:skin-rear-arch:outside',
    'trim:skin-front-arch:outside',
    'surface',
  ];
  for (const [i, w] of [wheels[1], wheels[0]].entries()) {
    const on = next.bodies.find((b) => b.id === 'skin-body-body')!;
    const kept = i ? ['flare:skin-rear-flare'] : [];
    const arch = f141Arch(w.diameter);
    const id = `skin-${w.end}-flare`;
    next = applyCadOperation(next, {
      type: 'detailBody',
      bodyId: on.id,
      placementFeatureId: `${id}-placement`,
      feature: {
        id,
        name: `${w.name} flare`,
        type: 'flare',
        inputFeatureIds: [on.resultFeatureId],
        args: {
          tool: { sketchId: `skin-${w.end}-flare-line`, elements: ['a0'] },
          arch: edgeRef(
            on.resultFeatureId,
            [...kept, ...skinFace],
            [
              ...kept,
              ...(w.end === 'front' ? ['trim:skin-rear-arch:outside'] : []),
              `sketch:skin-${w.end}-wheel`,
              'cut:e:a0',
            ],
            [w.x, 880, arch.z + arch.r * 0.6],
            (arch.r * (archArc[1] - archArc[0]) * Math.PI) / 180,
          ),
          height: mm(f141FlareHeight),
          continuity: 'G1',
        },
      },
    });
  }
  // The side intake cut through the skin, after the flares (their names stay as they are).
  {
    const on = next.bodies.find((b) => b.id === 'skin-body-body')!;
    next = applyCadOperation(next, {
      type: 'detailBody',
      bodyId: on.id,
      placementFeatureId: 'skin-side-intake-placement',
      feature: {
        id: 'skin-side-intake',
        name: 'Side intake',
        type: 'trim',
        inputFeatureIds: [on.resultFeatureId],
        args: { tool: { sketchId: intake.id, elements: ['top', 'bottom'] }, keep: 'outside' },
      },
    });
  }
  return applyCadOperation(next, {
    type: 'insertFeatures',
    parameters: [],
    sketches: [],
    features: [
      {
        ...mirrored(next.bodies.find((b) => b.id === 'skin-body-body')!.resultFeatureId),
        id: 'skin-body-left',
        name: 'Body left',
      },
      mirrored('skin-canopy'),
      ...ends.map((e) => e.feature),
    ],
    bodies: [
      bodyOf('skin-body-left', 'Body left', paint),
      bodyOf('skin-canopy-left', 'Canopy left', glass),
      bodyOf('skin-nose', 'Nose', paint),
      bodyOf('skin-tail', 'Tail', paint),
    ],
  });
}
