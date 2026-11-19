/**
 * CL2 (docs/cad/car-look-process.md): the hard points and the package of 「翔」 (F82). The wheels
 * with their steering and bump, the two occupants (F64's figure, CR7d, seated at the H-point and
 * reclined), the engine, gearbox, fuel tank, radiators and front luggage as boxes, and the side
 * and plan envelopes the skin must stay outside of, as sketches. Same frame as F80: front axle at
 * x = 0, the car running towards −X, +y its right side, z up, the ground at z = 0.
 */
import { fixtureKernel } from './fixtures';
import type { CadSketch, CadSketchEntity } from './sketch';
import { applyCadOperation, type CadNewBody } from './operations';
import {
  emptyCad,
  identityQuaternion,
  mm,
  position,
  type CadAppearance,
  type CadDocument,
  type CadFeature,
  type CadKernelProfile,
} from './model';
import { f80Rules } from './car-look-fixtures';

type V2 = readonly [number, number];
type V3 = readonly [number, number, number];

/**
 * F64's seated figure (character-core `seatedFigure({ spine: -25 })`, 1.69 m) about its hip, in
 * the car's side view: `x` behind the hip (+x is rearwards), `z` up. Checked against the figure
 * by character-core's occupant tests (CL2).
 */
export const f82Occupant = Object.freeze({
  /** The back reclined 25° from upright; thighs and shins as F64's Sit. */
  reclineDegrees: 25,
  headTop: [129, 736] as V2,
  eye: [90, 654] as V2,
  /** The head's front face (the figure's head box) above this height. */
  headFrontX: 129,
  backX: 328,
  knee: [-418, -13] as V2,
  toeX: -838,
  heelZ: -175,
  /** Half the shoulders' width. */
  shoulder: 245,
  /** Each foot's centre from the hip across, and its half width. */
  foot: { y: 100, half: 55 },
});

/** F82's CL2 numbers (mm), on top of CL1's (`f80Rules`). */
export const f82Rules = Object.freeze({
  ...f80Rules,
  clearance: 100,
  /** The floor's top: the clearance and a 20 mm floor. */
  floor: 120,
  /** The H-points, driver on the right (+y). */
  hPoint: { x: 1250, y: 370, z: 300 },
  /** The roof's outer line, and its inner surface 30 mm below. */
  roof: 1130,
  roofInner: 1100,
  /** Steering lock and bump travel of the wheel envelopes; 20 mm between tyre and arch. */
  steerDegrees: 30,
  bump: 70,
  archGap: 20,
  /** The firewall behind the seats. */
  firewall: 1700,
  /** The windscreen: its base (the cowl) and its top (the header), both on the centre line. */
  screen: { base: [400, 700] as V2, header: [1150, 1110] as V2 },
  /** Boxes: [x0, y0, z0] to [x1, y1, z1]. */
  boxes: {
    engine: [
      [1720, -310, 230],
      [2470, 310, 780],
    ],
    gearbox: [
      [2470, -200, 240],
      [2920, 200, 590],
    ],
    fuel: [
      [550, -110, 120],
      [1450, 110, 370],
    ],
    radiatorRight: [
      [1850, 780, 230],
      [2200, 880, 630],
    ],
    radiatorLeft: [
      [1850, -880, 230],
      [2200, -780, 630],
    ],
    luggage: [
      [-680, -400, 170],
      [-220, 400, 470],
    ],
  } as Record<string, readonly [V3, V3]>,
  /** The side envelope (x, z): the skin's outline stays on or outside it. */
  side: [
    [-950, 100],
    [-950, 420],
    [-500, 680],
    [0, 790],
    [400, 770],
    [1150, 1130],
    [1450, 1130],
    [1900, 1060],
    [2650, 990],
    [3400, 930],
    [3400, 380],
    [2950, 100],
  ] as V2[],
  /** Half the plan envelope (x, y ≥ 0), mirrored about y = 0. */
  plan: [
    [-950, 650],
    [-600, 900],
    [0, 975],
    [2650, 975],
    [3400, 850],
  ] as V2[],
});

const tyreLook: CadAppearance = { color: '#1d1f22', opacity: 1 };
const occupantLook: CadAppearance = { color: '#d9a066', opacity: 1 };
const machineLook: CadAppearance = { color: '#7a828c', opacity: 1 };
const fuelLook: CadAppearance = { color: '#c0504d', opacity: 1 };
const coolLook: CadAppearance = { color: '#4f81bd', opacity: 1 };
const luggageLook: CadAppearance = { color: '#9bbb59', opacity: 1 };

/** A quarter turn about X: a cylinder's +Z axis to −Y (`out` −1) or +Y (`out` +1). */
const across = (out: 1 | -1) =>
  [(-out * Math.SQRT1_2) as number, 0, 0, Math.SQRT1_2] as [number, number, number, number];
/** A turn about Y by `deg` (a box's +Z leaning towards +X: rearwards). */
const aboutY = (deg: number) => {
  const h = (deg * Math.PI) / 360;
  return [0, Math.sin(h), 0, Math.cos(h)] as [number, number, number, number];
};
/** The sketch plane of the side view: u along +X, v along +Z (a quarter turn about X). */
export const sidePlane = [Math.SQRT1_2, 0, 0, Math.SQRT1_2] as [number, number, number, number];

/** The occupant's boxes about an H-point: torso (reclined), head, thighs, shins with feet. */
export function f82OccupantBoxes(h: { x: number; y: number; z: number }) {
  const o = f82Occupant;
  const t = (o.reclineDegrees * Math.PI) / 180;
  // The torso's front-bottom corner 90 mm ahead of the hip; 230 deep, 520 along the back.
  const torso = {
    origin: [h.x - 90, h.y - o.shoulder, h.z + 20] as V3,
    size: [230, 2 * o.shoulder, 520] as V3,
    degrees: o.reclineDegrees,
    /** Its corners in the side view (x, z), for checks. */
    side: [
      [0, 0],
      [230, 0],
      [230, 520],
      [0, 520],
    ].map(
      ([u, w]) =>
        [
          h.x - 90 + u! * Math.cos(t) + w! * Math.sin(t),
          h.z + 20 - u! * Math.sin(t) + w! * Math.cos(t),
        ] as V2,
    ),
  };
  const aligned = (x0: number, x1: number, z0: number, z1: number, half: number) =>
    [
      [h.x + x0, h.y - half, h.z + z0],
      [h.x + x1, h.y + half, h.z + z1],
    ] as const satisfies readonly [V3, V3];
  return {
    torso,
    head: aligned(110, 330, 500, o.headTop[1], 100),
    thighs: aligned(o.knee[0] - 50, 60, -110, 60, o.foot.y + 80),
    shins: aligned(o.toeX - 20, o.knee[0] + 20, o.heelZ, -20, o.foot.y + o.foot.half),
  };
}

/** The plan outline (x, y) of a tyre steered through ±`deg` about its centre: the sweep's hull. */
export function steeredTyre(cx: number, cy: number, diameter: number, width: number, deg: number) {
  const pts: V2[] = [];
  // Every whole degree of the range (and its ends): a corner reaches furthest between them.
  const steps = Math.max(1, Math.ceil(2 * deg));
  for (let k = 0; k <= steps; k++) {
    const a = -deg + (2 * deg * k) / steps;
    const r = (a * Math.PI) / 180;
    for (const [u, v] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      const x = (u * diameter) / 2;
      const y = (v * width) / 2;
      pts.push([cx + x * Math.cos(r) - y * Math.sin(r), cy + x * Math.sin(r) + y * Math.cos(r)]);
    }
  }
  return hull(pts);
}

function hull(points: V2[]): V2[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: V2, a: V2, b: V2) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: V2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: V2[] = [];
  for (const q of p.reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * A sketch of polylines, closed unless named in `open`: points `<loop>p<k>`, lines `<loop>l<k>`
 * (and circles, each with its centre `<id>c`).
 */
export function outlineSketch(
  id: string,
  name: string,
  plane: CadSketch['plane'],
  loops: Record<string, readonly V2[]>,
  circles: Record<string, { c: V2; r: number }> = {},
  open: readonly string[] = [],
): CadSketch {
  const entities: CadSketchEntity[] = [];
  const solved: Record<string, [number, number]> = {};
  for (const [loop, pts] of Object.entries(loops)) {
    pts.forEach((p, k) => {
      solved[`${loop}p${k}`] = [p[0], p[1]];
      entities.push({ type: 'point', id: `${loop}p${k}` });
    });
    pts.forEach((_, k) => {
      if (open.includes(loop) && k === pts.length - 1) return;
      entities.push({
        type: 'line',
        id: `${loop}l${k}`,
        start: `${loop}p${k}`,
        end: `${loop}p${(k + 1) % pts.length}`,
      });
    });
  }
  for (const [c, { c: at, r }] of Object.entries(circles)) {
    solved[`${c}c`] = [at[0], at[1]];
    solved[c] = [r, 0];
    entities.push({ type: 'point', id: `${c}c` }, { type: 'circle', id: c, center: `${c}c` });
  }
  return { id, name, plane, entities, constraints: [], solved };
}

/**
 * F82: 「翔」's package (CL2). The four wheels, both occupants, the machinery as boxes, and the
 * sketches `package-side` (the side envelope, the wheel arches at full bump and the windscreen
 * line) and `package-plan` (the plan envelope and the steered front tyres).
 */
export function f82Package(
  kernel: Pick<CadKernelProfile, 'id' | 'buildHash'> = fixtureKernel,
): CadDocument {
  const r = f82Rules;
  const features: CadFeature[] = [];
  const bodies: CadNewBody[] = [];
  const add = (
    id: string,
    name: string,
    args: CadFeature['args'],
    type: 'box' | 'cylinder',
    look: CadAppearance,
  ) => {
    features.push({ id, name, type, inputFeatureIds: [], args } as CadFeature);
    bodies.push({
      id: `${id}-body`,
      name,
      sourceFeatureId: id,
      placementFeatureId: `${id}-placement`,
      appearance: look,
    });
  };
  const aligned = (id: string, name: string, [a, b]: readonly [V3, V3], look: CadAppearance) =>
    add(
      id,
      name,
      {
        size: [mm(b[0] - a[0]), mm(b[1] - a[1]), mm(b[2] - a[2])],
        origin: position(a[0], a[1], a[2]),
        orientation: identityQuaternion(),
      },
      'box',
      look,
    );
  for (const [axle, x, tyre, track] of [
    ['front', 0, r.tyre.front, r.track.front],
    ['rear', r.wheelbase, r.tyre.rear, r.track.rear],
  ] as const)
    for (const out of [1, -1] as const) {
      const side = out > 0 ? 'right' : 'left';
      add(
        `${axle}-${side}`,
        `${axle === 'front' ? 'Front' : 'Rear'} ${side} wheel`,
        {
          radius: mm(tyre.diameter / 2),
          height: mm(tyre.width),
          origin: position(x, out * (track / 2 - tyre.width / 2), tyre.diameter / 2),
          orientation: across(out),
        },
        'cylinder',
        tyreLook,
      );
    }
  for (const [seat, y] of [
    ['driver', r.hPoint.y],
    ['passenger', -r.hPoint.y],
  ] as const) {
    const b = f82OccupantBoxes({ ...r.hPoint, y });
    const name = seat === 'driver' ? 'Driver' : 'Passenger';
    add(
      `${seat}-torso`,
      `${name} torso`,
      {
        size: [mm(b.torso.size[0]), mm(b.torso.size[1]), mm(b.torso.size[2])],
        origin: position(...b.torso.origin),
        orientation: aboutY(b.torso.degrees),
      },
      'box',
      occupantLook,
    );
    aligned(`${seat}-head`, `${name} head`, b.head, occupantLook);
    aligned(`${seat}-thighs`, `${name} thighs`, b.thighs, occupantLook);
    aligned(`${seat}-shins`, `${name} shins`, b.shins, occupantLook);
  }
  const names: Record<string, [string, CadAppearance]> = {
    engine: ['Engine', machineLook],
    gearbox: ['Gearbox', machineLook],
    fuel: ['Fuel tank', fuelLook],
    radiatorRight: ['Right radiator', coolLook],
    radiatorLeft: ['Left radiator', coolLook],
    luggage: ['Front luggage', luggageLook],
  };
  for (const [key, box] of Object.entries(r.boxes)) {
    const [name, look] = names[key]!;
    aligned(
      key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`),
      name,
      box,
      look,
    );
  }
  const arch = (x: number, d: number) => ({ c: [x, d / 2 + r.bump] as V2, r: d / 2 + r.archGap });
  const side = outlineSketch(
    'package-side',
    'Package side',
    { origin: position(0, 0, 0), orientation: sidePlane },
    { env: r.side, scr: [r.screen.base, r.screen.header] },
    { archF: arch(0, r.tyre.front.diameter), archR: arch(r.wheelbase, r.tyre.rear.diameter) },
    ['scr'],
  );
  const plan = outlineSketch(
    'package-plan',
    'Package plan',
    { origin: position(0, 0, 0), orientation: identityQuaternion() },
    {
      env: [...r.plan, ...[...r.plan].reverse().map(([x, y]) => [x, -y] as V2)],
      steerR: steeredTyre(
        0,
        r.track.front / 2,
        r.tyre.front.diameter,
        r.tyre.front.width,
        r.steerDegrees,
      ),
      steerL: steeredTyre(
        0,
        -r.track.front / 2,
        r.tyre.front.diameter,
        r.tyre.front.width,
        r.steerDegrees,
      ),
    },
  );
  return applyCadOperation(emptyCad(kernel), {
    type: 'insertFeatures',
    parameters: [],
    sketches: [side, plan],
    features,
    bodies,
  });
}
