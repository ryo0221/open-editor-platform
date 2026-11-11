/**
 * D5–D6 sample (docs/cad/mecha-look-process.md, D5 armour, D6 detail): 迅雷 (Jinrai), the original high-speed
 * interceptor that D1–D4 drew and checked in boxes, built as a CAD assembly with its armour.
 * 360 mm tall (1:50 of 18 m), on a display base; the robot faces −y, z up, its right side +x.
 *
 * Armour plates are the common part of a front outline and a side outline (`front`/`side`), so
 * each plate is chamfered in both views; plates over a dark frame give the steps and thickness.
 *
 * The skeleton is D4's (cad-mecha-look/d4): the body pitches 90° at the hips on the base; the
 * shoulders slide out and the elbows (pivot on the arm's front) fold the forearms over the upper
 * arms; the hips slide forward and out and the thighs fold up against the belly, the shins back
 * onto the thighs; three wing joints a side fold the wings down the back or sweep them back 38°,
 * every feather following its wing joint. The shield on the left forearm becomes the nose: on
 * the head as a hood, its flaps folded round. The rifle moves from the right hand to under the
 * chest. Forms: "Stand" and "Flight".
 */
import { fixtureComponent, fixturePart, fixtureVersion } from './assembly-fixtures';
import { currentConfigurationValues } from './configurations';
import { fixtureKernel } from './fixtures';
import { parameterValues } from './graph';
import { fixtureConnector, fixtureJoint } from './joints-fixtures';
import { solveJoints, type CadConnector, type CadJoint, type CadJointValueKey } from './joints';
import { identityPose } from './assembly';
import {
  emptyCad,
  identityQuaternion,
  mm,
  position,
  type CadDocument,
  type CadKernelProfile,
  type Length,
  type Quaternion,
  type Vec3,
} from './model';
import { applyCadOperation, cadContentHash } from './operations';
import { assertCad } from './validation';

type Kernel = Pick<CadKernelProfile, 'id' | 'buildHash'>;
type P2 = [number, number];
/** A prism: an outline in a plane, `span` along the third axis. */
type Prism = { plane: 'xy' | 'xz' | 'yz'; pts: P2[]; span: [number, number] };
/**
 * One body: a box, a prism, or an armour plate; `cuts` are prisms cut out of it (panel lines,
 * slits, nozzle bores).
 */
type Shape = { id: string; color: string; cuts?: Prism[] } & (
  | { box: [Vec3, Vec3] }
  | { plane: 'xy' | 'xz' | 'yz'; pts: P2[]; span: [number, number] }
  /** The common part of the `front` outline (x, z) and the `side` outline (y, z). */
  | { front: P2[]; side: P2[] }
);

const deg = Math.PI / 180;
/** Scale: the design's 18 m is 360 mm here. */
const H = 360;
const r = (ratio: number) => Math.round(ratio * H * 1000) / 1000;

/** D7 colours, scheme A 雷光: white armour, navy inner plates, gunmetal frame, orange accents. */
const armour = '#eef0f3';
const sub = '#24324f';
const frame = '#4a4f58';
const visor = '#38d8ff';
const accent = '#f0a92c';
const metal = '#9aa0aa';
/** Bodies painted in the accent colour, and the nozzles left bare metal. */
const ACCENT_BODIES = /^(antenna|crest|sternum|shield-ridge|edge-|toe-|covert-|mark-)/;
const paint = (s: Shape) =>
  ACCENT_BODIES.test(s.id) ? accent : /nozzle/.test(s.id) ? metal : s.color;

/** The plane's orientation: local x, y map to the outline's u, v and local z to the prism's axis. */
const planes = {
  xy: {
    orientation: [0, 0, 0, 1] as Quaternion,
    place: (u: number, v: number, w: number) => [u, v, w],
  },
  xz: {
    orientation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] as Quaternion,
    place: (u: number, v: number, w: number) => [u, w, v],
  },
  yz: {
    orientation: [0.5, 0.5, 0.5, 0.5] as Quaternion,
    place: (u: number, v: number, w: number) => [w, u, v],
  },
} as const;
function ccw(pts: P2[]): P2[] {
  let area = 0;
  pts.forEach(([u, v], i) => {
    const [u2, v2] = pts[(i + 1) % pts.length]!;
    area += u * v2 - u2 * v;
  });
  return area < 0 ? [...pts].reverse() : pts;
}
const range = (pts: P2[], i: 0 | 1): [number, number] => [
  Math.min(...pts.map((p) => p[i])),
  Math.max(...pts.map((p) => p[i])),
];
/** The shape on the robot's other side (mirrored across x = 0). */
function mirror(s: Shape, id = s.id.replace(/-r$/, '-l')): Shape {
  if (s.cuts)
    return { ...mirror({ ...s, cuts: undefined }, id), cuts: s.cuts.map((c) => mirrorPrism(c)) };
  if ('box' in s) {
    const [lo, hi] = s.box;
    return {
      ...s,
      id,
      box: [
        [-hi[0], lo[1], lo[2]],
        [-lo[0], hi[1], hi[2]],
      ],
    };
  }
  if ('front' in s) return { ...s, id, front: s.front.map(([u, v]) => [-u, v] as P2) };
  if (s.plane === 'yz') return { ...s, id, span: [-s.span[1], -s.span[0]] };
  return { ...s, id, pts: s.pts.map(([u, v]) => [-u, v] as P2) };
}
function mirrorPrism(c: Prism): Prism {
  if (c.plane === 'yz') return { ...c, span: [-c.span[1], -c.span[0]] };
  return { ...c, pts: c.pts.map(([u, v]) => [-u, v] as P2) };
}
const both = (s: Shape): Shape[] => [s, mirror(s)];
/** The shape moved by `dy` along y. */
function shiftY(s: Shape, dy: number): Shape {
  if (s.cuts)
    return {
      ...shiftY({ ...s, cuts: undefined }, dy),
      cuts: s.cuts.map((c) => {
        if (c.plane === 'yz') return { ...c, pts: c.pts.map(([u, v]) => [u + dy, v] as P2) };
        if (c.plane === 'xz') return { ...c, span: [c.span[0] + dy, c.span[1] + dy] };
        return { ...c, pts: c.pts.map(([u, v]) => [u, v + dy] as P2) };
      }),
    };
  if ('box' in s)
    return {
      ...s,
      box: [
        [s.box[0][0], s.box[0][1] + dy, s.box[0][2]],
        [s.box[1][0], s.box[1][1] + dy, s.box[1][2]],
      ],
    };
  if ('front' in s) return { ...s, side: s.side.map(([u, v]) => [u + dy, v] as P2) };
  if (s.plane === 'yz') return { ...s, pts: s.pts.map(([u, v]) => [u + dy, v] as P2) };
  if (s.plane === 'xz') return { ...s, span: [s.span[0] + dy, s.span[1] + dy] };
  return { ...s, pts: s.pts.map(([u, v]) => [u, v + dy] as P2) };
}

/** The feature that makes the shape's solid, before its cuts. */
const solidOf = (s: Shape) =>
  'box' in s ? `${s.id}-box` : 'front' in s ? `${s.id}-common` : `${s.id}-extrude`;
/** A part version of the shapes, one body each. */
function part(artifactId: string, shapes: Shape[], kernel: Kernel) {
  let doc = emptyCad(kernel);
  const corners: number[][] = [];
  type Named = Prism & { id: string };
  const cutPrisms: Named[] = shapes.flatMap((s) =>
    (s.cuts ?? []).map((c, i) => ({ ...c, id: `${s.id}-c${i}` })),
  );
  const prisms: Named[] = shapes.flatMap((s): Named[] => {
    if ('box' in s) return [];
    if ('plane' in s) return [{ id: s.id, plane: s.plane, pts: s.pts, span: s.span }];
    const [y0, y1] = range(s.side, 0);
    const [x0, x1] = range(s.front, 0);
    return [
      { id: `${s.id}-f`, plane: 'xz', pts: s.front, span: [y0 - 1, y1 + 1] },
      { id: `${s.id}-s`, plane: 'yz', pts: s.side, span: [x0 - 1, x1 + 1] },
    ];
  });
  for (const p of prisms)
    for (const [u, v] of p.pts)
      for (const w of p.span) corners.push(planes[p.plane].place(u, v, w));
  doc = applyCadOperation(doc, {
    type: 'insertFeatures',
    profiles: [...prisms, ...cutPrisms].map((p) => {
      const plane = planes[p.plane];
      const [near, far] = p.span;
      const origin = p.plane === 'xz' ? plane.place(0, 0, far) : plane.place(0, 0, near);
      return {
        id: `${p.id}-profile`,
        name: p.id,
        plane: {
          origin: position(...(origin as [number, number, number])),
          orientation: plane.orientation,
        },
        shape: {
          type: 'polyline' as const,
          vertices: ccw(p.pts).map(([u, v], i) => ({ id: `${p.id}-v${i}`, u: mm(u), v: mm(v) })),
        },
      };
    }),
    features: [
      ...shapes
        .filter((s) => 'box' in s)
        .map((s) => {
          const [lo, hi] = (s as { box: [Vec3, Vec3] }).box;
          corners.push(lo, hi);
          return {
            id: `${s.id}-box`,
            name: s.id,
            type: 'box' as const,
            inputFeatureIds: [] as [],
            args: {
              size: [mm(hi[0] - lo[0]), mm(hi[1] - lo[1]), mm(hi[2] - lo[2])] as [
                Length,
                Length,
                Length,
              ],
              origin: position(...lo),
              orientation: identityQuaternion(),
            },
          };
        }),
      ...[...prisms, ...cutPrisms].map((p) => ({
        id: `${p.id}-extrude`,
        name: p.id,
        type: 'extrude' as const,
        inputFeatureIds: [] as [],
        args: {
          profileId: `${p.id}-profile`,
          distance: mm(p.span[1] - p.span[0]),
          direction: 1 as const,
        },
      })),
      ...shapes
        .filter((s) => 'front' in s)
        .map((s) => ({
          id: `${s.id}-common`,
          name: s.id,
          type: 'boolean' as const,
          inputFeatureIds: [`${s.id}-f-extrude`, `${s.id}-s-extrude`] as [string, string],
          args: { mode: 'common' as const },
        })),
      ...shapes.flatMap((s) =>
        (s.cuts ?? []).map((_, i) => ({
          id: `${s.id}-cut${i}`,
          name: `${s.id} cut ${i + 1}`,
          type: 'boolean' as const,
          inputFeatureIds: [
            i === 0 ? solidOf(s) : `${s.id}-cut${i - 1}`,
            `${s.id}-c${i}-extrude`,
          ] as [string, string],
          args: { mode: 'cut' as const },
        })),
      ),
    ],
    bodies: shapes.map((s) => ({
      id: s.id,
      name: s.id,
      sourceFeatureId: s.cuts?.length ? `${s.id}-cut${s.cuts.length - 1}` : solidOf(s),
      placementFeatureId: `${s.id}-placement`,
      appearance: { color: paint(s), opacity: 1 },
    })),
  });
  const bounds = corners.reduce<[Vec3, Vec3]>(
    ([lo, hi], p) => [
      [Math.min(lo[0], p[0]!), Math.min(lo[1], p[1]!), Math.min(lo[2], p[2]!)],
      [Math.max(hi[0], p[0]!), Math.max(hi[1], p[1]!), Math.max(hi[2], p[2]!)],
    ],
    [
      [Infinity, Infinity, Infinity],
      [-Infinity, -Infinity, -Infinity],
    ],
  );
  return { version: fixtureVersion(artifactId, 'v1', doc), bounds };
}

const quat = (axis: 0 | 1 | 2, d: number): Quaternion => {
  const q: Quaternion = [0, 0, 0, Math.cos((d * deg) / 2)];
  q[axis] = Math.sin((d * deg) / 2);
  return q;
};
const qmul = ([ax, ay, az, aw]: Quaternion, [bx, by, bz, bw]: Quaternion): Quaternion => [
  aw * bx + ax * bw + ay * bz - az * by,
  aw * by - ax * bz + ay * bw + az * bx,
  aw * bz + ax * by - ay * bx + az * bw,
  aw * bw - ax * bx - ay * by - az * bz,
];
/** Connector frames whose z (a revolute's or slider's axis) points along +x, −x, −y, +y, +z. */
const AX = {
  px: quat(1, 90),
  nx: quat(1, -90),
  ny: quat(0, 90),
  py: quat(0, -90),
  pz: identityQuaternion(),
  nz: quat(0, 180),
};
const conn = (
  path: string[],
  [x, y, z]: Vec3,
  rotation: Quaternion = [0, 0, 0, 1],
): CadConnector => ({
  ...fixtureConnector(path),
  offset: { translation: position(x, y, z), rotation },
});

// ---------------------------------------------------------------- the skeleton (D2–D4), mm
const CROTCH = r(0.53);
const KNEE = r(0.265);
const FOOT_H = r(0.035);
const WY1 = CROTCH + r(0.05) + r(0.08);
const CY1 = WY1 + r(0.218);
const SX = r(0.37 / 2 - 0.085 / 2);
/** The armoured shoulder blocks sit this much further out than the prototype's, clear of the chest. */
const ARM_OUT = 8;
const SY = CY1 - r(0.06);
const UA = r(0.16);
const FA = r(0.165);
const HAND = r(0.075);
/** The elbow's pivot in front of the arm's axis, so the forearm folds over the upper arm. */
const EZ = r(0.075 * 0.6);
const LX = r(0.056);
const SHOULDER_OUT = r(0.06);
const HIP_TO: Vec3 = [r(0.097) - LX, -r(0.096), 0];
const HIP_SLIDE = Math.hypot(HIP_TO[0], HIP_TO[1]);
const WING_ROOT: Vec3 = [r(0.07), r(0.14 * 0.62), CY1 - r(0.03)];
const WL = [r(0.17), r(0.2), r(0.17)];
/** Each wing segment one layer further back than the one before, its feathers in between. */
const WING_STEP = 18;
const FEATHER_Y = (i: number) => 5.3 + i * 1.62;
/** The knee's pivot behind the leg's axis, so the shin folds behind the thigh. */
const KNEE_BACK = 16;
/** Wing joints (degrees): folded down the back (Stand) and swept back (Flight). */
const WING_STAND = [-84, 172, -172];
const WING_FLIGHT = [-38, 4, 6];
/** Feathers per wing joint: [place along the segment, length (H), Flight angle, Stand angle]. */
const FEATHERS: [number, number, number, number][][] = [
  [
    [0.35, 0.12, -62, -6],
    [0.6, 0.14, -60, -5],
    [0.85, 0.155, -58, -4],
  ],
  [
    [0.1, 0.17, -64, -176],
    [0.3, 0.175, -62, -175],
    [0.5, 0.18, -60, -174],
    [0.7, 0.18, -58, -173],
    [0.9, 0.18, -56, -172],
  ],
  [
    [0.15, 0.15, -98, -8],
    [0.35, 0.165, -82, -6],
    [0.55, 0.18, -64, -4],
    [0.75, 0.19, -46, -2.5],
    [0.95, 0.2, -26, -1],
  ],
];
const FEATHER_SCALE = 2.1;
// The shield / nose: a kite of a centre panel and two flaps hinged on its long edges.
const SHIELD_T = r(0.007);
const SHIELD_L = r(0.33);
const SHIELD_W = r(0.08 * 1.3);

// ---------------------------------------------------------------- D8 hand-over mechanisms
/** Where the rifle sits under the chest in Flight (the torso's frame, y and z). */
const BELLY: [number, number] = [-(r(0.07) + r(0.012) + r(0.09)), WY1 + r(0.06)];
/** The rifle's butt sits just past the hand's end (3 mm clear), this far past the hand's middle. */
const RIFLE_DROP = 26;
/** Where the right hand holds the rifle with the arm hanging straight (pointing down). */
const HANG: [number, number] = [0, SY - UA - FA - HAND / 2 - RIFLE_DROP];
/**
 * The holster: a block that slides along the waist front and an arm that swings the rifle half a
 * turn about x from beside the right hip (hanging, where the hand lets go of it) up under the
 * chest. Half a turn takes the rifle from one place to the other about their midpoint.
 */
const HOLSTER_PIVOT: [number, number] = [(BELLY[0] + HANG[0]) / 2, (BELLY[1] + HANG[1]) / 2];
const HOLSTER_OUT = SX + ARM_OUT;
/** Where the shield sits on the head in Flight (its base, the torso's frame). */
const HOOD: Vec3 = [0, r(0.08 * 0.62), CY1 + r(0.045)];
/** The crane holds the shield at its base, on the ridge: this far out from the panel's inner face. */
const CLAMP_Y = 3.5;
/**
 * The left arm's hand-over pose: swung back so the shield's clamp point comes level (in y) with
 * the hood's, the forearm kept upright (elbow = −shoulder).
 */
const HANDOVER_SWING = (() => {
  const f = (a: number) => -EZ * Math.cos(a) + UA * Math.sin(a) + EZ - (HOOD[1] + CLAMP_Y);
  let [lo, hi] = [0, 1];
  for (let i = 0; i < 60; i++)
    [lo, hi] = f((lo + hi) / 2) > 0 ? [lo, (lo + hi) / 2] : [(lo + hi) / 2, hi];
  return lo;
})();
const HANDOVER_SWING_DEG = (HANDOVER_SWING * 180) / Math.PI;
/** The shield's clamp point (x, z) at the hand-over: on the arm, hanging tip down, face out. */
const HANDOVER: [number, number] = [
  -(SX + ARM_OUT) - (r(0.0465) + r(0.012)) - CLAMP_Y,
  SY - EZ * Math.sin(HANDOVER_SWING) - UA * Math.cos(HANDOVER_SWING) + r(0.03),
];
/** The angle about +y that turns +z toward v (x, z). */
const yAngle = ([x, z]: [number, number]) => (Math.atan2(x, z) * 180) / Math.PI;
const sub2 = (a: [number, number], b: [number, number]): [number, number] => [
  a[0] - b[0],
  a[1] - b[1],
];
/**
 * The hood crane, in the plane of the clamp point behind the head: a fixed boom from the top of
 * the back pack out over the left shoulder, and one arm swinging about the boom's end. The arm's
 * end comes to the hood (folded, all joints 0) and to the shield's clamp point at the hand-over
 * at the same reach: the pivot lies on the two points' bisector, out past the left shoulder.
 */
/** The right arm swings back this far (degrees) to let go of the rifle before the holster lifts it. */
const LET_GO = 15;
const CRANE_ROOT: [number, number] = [-15, 316];
/** The clamp holds the shield at the end of its base, on a stem this long past it (along the shield). */
const CRANE_STEM = 10;
/** The crane's wrist at the hood and at the hand-over (x, z). */
const CRANE_HOOD: [number, number] = [HOOD[0], HOOD[2] - CRANE_STEM];
const CRANE_TAKE: [number, number] = [HANDOVER[0], HANDOVER[1] + CRANE_STEM];
const CRANE_PIVOT: [number, number] = (() => {
  const [h, c] = [CRANE_HOOD, CRANE_TAKE];
  const d = sub2(c, h);
  const n = Math.hypot(d[0], d[1]);
  const t = 95;
  return [(h[0] + c[0]) / 2 + (d[1] / n) * t, (h[1] + c[1]) / 2 - (d[0] / n) * t];
})();
/**
 * The crane's joint angles (degrees: arm, wrist pitch, wrist roll) in each form. The arm turns
 * about +y (clockwise seen from behind... as the x–z view reads it, negative is anticlockwise):
 * the long way round over the top and out to the left to reach the hand-over, back out to the
 * left to lift the shield clear, then over the top to the hood. The wrist keeps the shield's
 * pitch (arm + wrist) at −180 (tip down) until it flips it outward, then at 0 (tip up).
 */
const CRANE_POSES = (() => {
  const u0 = sub2(CRANE_HOOD, CRANE_PIVOT);
  const at = (p: [number, number]) => {
    // Clockwise (positive about +y) from the hood direction, taken the long way (negative).
    const cw = (((yAngle(sub2(p, CRANE_PIVOT)) - yAngle(u0)) % 360) + 360) % 360;
    return cw - 360;
  };
  const handover = at(CRANE_TAKE);
  const lift = at([CRANE_PIVOT[0] - Math.hypot(...u0), CRANE_PIVOT[1]]);
  return {
    stand: [0, 0, 0],
    handover: [handover, -180 - handover, -90],
    lift: [lift, -180 - lift, -90],
    flip: [lift, -lift, 0],
    stow: [0, 0, 0],
  } as Record<string, [number, number, number]>;
})();
const SHIELD_HINGE = SHIELD_L * 0.55;

// ---------------------------------------------------------------- the parts
function torsoShapes(): Shape[] {
  return [
    // pelvis and waist: the dark frame
    {
      id: 'pelvis',
      color: frame,
      box: [
        [-25, -17, 178],
        [25, 17, 210],
      ],
    },
    {
      id: 'waist',
      color: frame,
      box: [
        [-23, -15, 206],
        [23, 15, 240],
      ],
    },
    // skirt: crotch, sides, back (the front plates ride on the thighs)
    {
      id: 'crotch',
      color: sub,
      plane: 'xz',
      pts: [
        [-9, 213],
        [9, 213],
        [6, 184],
        [0, 178],
        [-6, 184],
      ],
      span: [-22, -16],
    },
    ...both({
      id: 'skirt-side-r',
      color: armour,
      plane: 'yz',
      pts: [
        [-19, 213],
        [17, 213],
        [15, 186],
        [-13, 183],
      ],
      span: [31, 35],
    }),
    {
      id: 'skirt-back',
      color: armour,
      plane: 'xz',
      pts: [
        [-26, 213],
        [26, 213],
        [22, 190],
        [-22, 190],
      ],
      span: [17, 22],
    },
    // abdomen: two stepped plates
    {
      id: 'abdomen-1',
      color: sub,
      plane: 'xz',
      pts: [
        [-19, 215],
        [19, 215],
        [21, 226],
        [-21, 226],
      ],
      span: [-19, -14],
    },
    {
      id: 'abdomen-2',
      color: sub,
      plane: 'xz',
      pts: [
        [-22, 228],
        [22, 228],
        [24, 238],
        [-24, 238],
      ],
      span: [-19.5, -14],
    },
    // chest: the main block, then the pectoral plates stepped out in front
    {
      id: 'chest',
      color: armour,
      front: [
        [-35, 237],
        [35, 237],
        [45, 288],
        [45, 305],
        [38, 316],
        [-38, 316],
        [-45, 305],
        [-45, 288],
      ],
      side: [
        [-19, 237],
        [18, 237],
        [23, 300],
        [19, 316],
        [-22, 316],
        [-25, 297],
        [-21, 252],
      ],
    },
    ...both({
      id: 'pec-r',
      color: armour,
      front: [
        [5, 266],
        [36, 270],
        [41, 300],
        [36, 311],
        [8, 308],
      ],
      side: [
        [-29, 264],
        [-22, 264],
        [-22, 312],
        [-29, 312],
        [-34, 300],
        [-33, 276],
      ],
    }),
    {
      id: 'sternum',
      color: sub,
      plane: 'xz',
      pts: [
        [-4, 260],
        [4, 260],
        [5, 313],
        [-5, 313],
      ],
      span: [-31, -22],
    },
    ...both({
      id: 'chest-side-r',
      color: sub,
      plane: 'yz',
      pts: [
        [-18, 262],
        [16, 262],
        [18, 300],
        [-22, 300],
      ],
      span: [43.5, 46.5],
    }),
    ...both({
      id: 'waist-side-r',
      color: armour,
      plane: 'yz',
      pts: [
        [-13, 212],
        [13, 212],
        [11, 236],
        [-11, 236],
      ],
      span: [23, 27],
    }),
    // collar and the slope to the shoulders (trapezius)
    {
      id: 'collar',
      color: frame,
      front: [
        [-40, 315],
        [40, 315],
        [26, 323],
        [-26, 323],
      ],
      side: [
        [-23, 315],
        [23, 315],
        [17, 323],
        [-17, 323],
      ],
    },
    ...both({
      id: 'trapezius-r',
      color: armour,
      plane: 'xz',
      pts: [
        [9, CY1 + 12.6],
        [37.5, CY1 - 1.8],
        [37.5, CY1 - 16.2],
        [9, CY1 - 7.2],
      ],
      span: [-20.7, 17.1],
    }),
    // back pack between the folded wings, and their root blocks
    {
      id: 'pack',
      color: armour,
      front: [
        [-24, 252],
        [24, 252],
        [28, 298],
        [22, 312],
        [-22, 312],
        [-28, 298],
      ],
      side: [
        [19, 252],
        [26, 255],
        [27.5, 304],
        [25, 312],
        [19, 312],
      ],
    },
    ...both({
      id: 'wing-mount-r',
      color: frame,
      box: [
        [18, 24, 298],
        [32, 30, 312],
      ],
    }),
  ];
}
const headShapes = (): Shape[] => [
  {
    id: 'neck',
    color: frame,
    box: [
      [-7, -8, 314],
      [7, 8, 326],
    ],
  },
  {
    id: 'helmet',
    color: armour,
    front: [
      [-10, 323],
      [10, 323],
      [14, 336],
      [14, 350],
      [9, 359],
      [-9, 359],
      [-14, 350],
      [-14, 336],
    ],
    side: [
      [-12, 323],
      [14, 323],
      [16, 348],
      [10, 359],
      [-8, 359],
      [-16, 347],
      [-15, 333],
    ],
  },
  {
    id: 'mask',
    color: sub,
    plane: 'xz',
    pts: [
      [-7, 324],
      [7, 324],
      [9, 334],
      [-9, 334],
    ],
    span: [-16.5, -12],
  },
  {
    id: 'visor',
    color: visor,
    plane: 'xz',
    pts: [
      [-11, 336],
      [11, 336],
      [12.5, 341.5],
      [-12.5, 341.5],
    ],
    span: [-17, -13],
  },
  {
    id: 'crest',
    color: armour,
    plane: 'yz',
    pts: [
      [-9, 356],
      [3, 358],
      [-4, 374],
    ],
    span: [-1.2, 1.2],
  },
  ...both({
    id: 'cheek-r',
    color: sub,
    plane: 'yz',
    pts: [
      [-12, 326],
      [6, 326],
      [4, 338],
      [-10, 336],
    ],
    span: [13, 15.5],
  }),
];
const holsterSlideShapes = (): Shape[] => [
  {
    id: 'holster-block',
    color: frame,
    box: [
      [-6, -5, -5],
      [6, 5, 5],
    ],
  },
];
/** The holster arm in its Flight place (the torso's axes, from the pivot): up to the cradle behind the rifle. */
const holsterArmShapes = (): Shape[] => {
  // In the rifle's axes the lever runs up behind its grip (which reaches 28 mm back) to a cradle
  // on the rifle's back (17 mm behind its axis) past the grip.
  const [cy, cz] = [BELLY[0] - HOLSTER_PIVOT[0], BELLY[1] - HOLSTER_PIVOT[1]];
  return [
    {
      id: 'holster-lever',
      color: frame,
      box: [
        [-2.5, cy + 28.2, -3],
        [2.5, cy + 30.7, cz + 22],
      ],
    },
    {
      id: 'holster-cradle',
      color: sub,
      box: [
        [-6, cy + 17.3, cz + 22],
        [6, cy + 30.7, cz + 42],
      ],
    },
  ];
};
/** A bar `w` wide from a to b in the xz plane, `span` along y. */
const bar = (
  id: string,
  color: string,
  a: [number, number],
  b: [number, number],
  w: number,
  span: [number, number],
): Shape => ({
  id,
  color,
  ...groove('xz', a, b, w, span),
});
const CY = HOOD[1] + CLAMP_Y;
/** The boom (its frame at its root on the pack) and the arm (at the pivot), in torso axes. */
const craneLink1Shapes = (): Shape[] => [
  bar('crane-boom', frame, [0, 0], sub2(CRANE_PIVOT, CRANE_ROOT), 7, [4.8, 7.3]),
  { id: 'crane-root', color: sub, plane: 'xz', pts: octagon(6), span: [-2, 7.3] },
  {
    id: 'crane-hub1',
    color: sub,
    plane: 'xz',
    pts: octagon(6).map(([x, z]) => [
      x + CRANE_PIVOT[0] - CRANE_ROOT[0],
      z + CRANE_PIVOT[1] - CRANE_ROOT[1],
    ]),
    span: [4.6, 7.5],
  },
];
const craneLink2Shapes = (): Shape[] => [
  bar('crane-link2', frame, [0, 0], sub2(CRANE_HOOD, CRANE_PIVOT), 5, [2, 4.5]),
  { id: 'crane-hub2', color: sub, plane: 'xz', pts: octagon(4.5), span: [1.8, 4.6] },
];
const craneWristShapes = (): Shape[] => [
  {
    id: 'crane-wrist',
    color: frame,
    box: [
      [-3.5, 2, -3.5],
      [3.5, 4.7, 3.5],
    ],
  },
];
/** The clamp, in the shield's axes at the wrist: a stem out to the shield's base, a jaw on its ridge. */
const craneClampShapes = (): Shape[] => [
  {
    id: 'crane-stem',
    color: frame,
    box: [
      [-3, -0.5, -1],
      [3, 2, 9.8],
    ],
  },
  {
    id: 'crane-clamp',
    color: accent,
    box: [
      [-4, -0.5, 6],
      [4, 1.3, 13.5],
    ],
  },
];
/** The right arm's parts; the left ones are their mirror. Origins: shoulder slide, shoulder, elbow. */
const shoulderSlideShapes = (): Shape[] => [
  {
    id: 'slide-r',
    color: frame,
    box: [
      [-12, -8, -8],
      [6, 8, 8],
    ],
  },
];
const upperShapes = (): Shape[] => [
  {
    id: 'pauldron-r',
    color: armour,
    front: [
      [-10, -15],
      [15, -17],
      [20, 4],
      [15, 19],
      [-6, 21],
      [-12, 10],
    ],
    side: [
      [-19, -15],
      [19, -15],
      [18, 12],
      [10, 20],
      [-12, 20],
      [-20, 10],
    ],
  },
  {
    id: 'pauldron-plate-r',
    color: sub,
    plane: 'yz',
    pts: [
      [-14, -13],
      [14, -13],
      [13, 8],
      [-13, 8],
    ],
    span: [19, 22],
  },
  {
    id: 'upper-frame-r',
    color: frame,
    box: [
      [-9, -9, -58],
      [9, 9, -12],
    ],
  },
  {
    id: 'upper-armour-r',
    color: armour,
    front: [
      [-10, -50],
      [11, -50],
      [12, -20],
      [-9, -20],
    ],
    side: [
      [-11, -50],
      [10, -50],
      [11, -20],
      [-11, -20],
    ],
  },
  {
    id: 'elbow-r',
    color: frame,
    box: [
      [-8, -21, -63],
      [8, 0, -52],
    ],
  },
];
const foreShapes = (): Shape[] => [
  {
    id: 'gauntlet-r',
    color: armour,
    front: [
      [-10, -58],
      [13, -58],
      [16, -18],
      [13, -3],
      [-11, -3],
      [-12, -18],
    ],
    side: [
      [EZ - 14, -58],
      [EZ + 14, -58],
      [EZ + 16, -14],
      [EZ + 10, -2],
      [EZ - 12, -2],
      [EZ - 16, -16],
    ],
  },
  {
    id: 'gauntlet-plate-r',
    color: sub,
    plane: 'yz',
    pts: [
      [EZ - 10, -52],
      [EZ + 10, -52],
      [EZ + 12, -20],
      [EZ - 8, -20],
    ],
    span: [15, 17.5],
  },
  {
    id: 'hand-r',
    color: frame,
    box: [
      [-8.5, EZ - 6.5, -86],
      [8.5, EZ + 6.5, -58],
    ],
  },
  {
    id: 'elbow-cap-r',
    color: sub,
    plane: 'yz',
    pts: [
      [-4, -6],
      [10, -8],
      [12, 4],
      [-2, 6],
    ],
    span: [-9, 9],
  },
];
const hipShapes = (): Shape[] => [
  {
    id: 'hip-joint-r',
    color: frame,
    box: [
      [-10, -10, -10],
      [10, 10, 8],
    ],
  },
];
/**
 * The front skirt plate, hinged on its inner edge so it swings forward like a door, out of the way
 * of the hip as it slides out and of the thigh as it folds (its frame at the hinge).
 */
const SKIRT_HINGE: Vec3 = [9.5, -23, 195];
const skirtShapes = (): Shape[] => [
  {
    id: 'skirt-front-r',
    color: armour,
    plane: 'xz',
    pts: (
      [
        [9.5, 214],
        [31, 214],
        [35, 190],
        [13, 185.5],
      ] as P2[]
    ).map(([x, z]) => [x - SKIRT_HINGE[0], z - SKIRT_HINGE[2]] as P2),
    span: [-23 - SKIRT_HINGE[1], -19.1 - SKIRT_HINGE[1]],
  },
];
const thighShapes = (): Shape[] => [
  {
    id: 'thigh-frame-r',
    color: frame,
    box: [
      [-11, -12, -92],
      [11, 12, -6],
    ],
  },
  {
    id: 'thigh-armour-r',
    color: armour,
    front: [
      [-13, -88],
      [13, -88],
      [16, -30],
      [15, -9],
      [-12, -9],
      [-15, -30],
    ],
    side: [
      [-16, -88],
      [12, -88],
      [14, -20],
      [8, -7],
      [-14, -7],
      [-18, -34],
    ],
  },
  {
    id: 'thigh-plate-r',
    color: sub,
    plane: 'yz',
    pts: [
      [-12, -80],
      [8, -80],
      [9, -36],
      [-13, -40],
    ],
    span: [15, 17.5],
  },
  {
    id: 'thigh-front-r',
    color: sub,
    plane: 'xz',
    pts: [
      [-9, -84],
      [9, -84],
      [10, -40],
      [-8, -36],
    ],
    span: [-18.5, -15],
  },
];
const shinShapes = (): Shape[] => [
  {
    id: 'shin-frame-r',
    color: frame,
    box: [
      [-13, -14, -80],
      [13, 14, -4],
    ],
  },
  {
    id: 'shin-armour-r',
    color: armour,
    front: [
      [-20, -82],
      [20, -82],
      [18, -40],
      [14, -6],
      [-14, -6],
      [-18, -40],
    ],
    side: [
      [-22, -82],
      [22, -82],
      [20, -50],
      [15, -7],
      [-16, -7],
      [-19, -60],
    ],
  },
  {
    id: 'calf-r',
    color: sub,
    plane: 'xz',
    pts: [
      [-15, -70],
      [15, -70],
      [12, -22],
      [-12, -22],
    ],
    span: [19, 24],
  },
  {
    id: 'shin-front-r',
    color: sub,
    plane: 'xz',
    pts: [
      [-11, -76],
      [11, -76],
      [8, -24],
      [0, -18],
      [-8, -24],
    ],
    span: [-23.5, -19],
  },
  {
    id: 'knee-guard-r',
    color: armour,
    front: [
      [-13, -12],
      [13, -12],
      [11, 10],
      [0, 16],
      [-11, 10],
    ],
    side: [
      [-26, -12],
      [-17, -12],
      [-17, 10],
      [-22, 14],
      [-27, 4],
    ],
  },
];
const footShapes = (): Shape[] => [
  {
    id: 'foot-armour-r',
    color: armour,
    front: [
      [-18, -12.6],
      [18, -12.6],
      [16, -2],
      [10, 4],
      [-10, 4],
      [-16, -2],
    ],
    side: [
      [-34, -12.6],
      [20, -12.6],
      [20, -4],
      [10, 4],
      [-14, 4],
      [-34, -6],
    ],
  },
  {
    id: 'toe-r',
    color: sub,
    plane: 'yz',
    pts: [
      [-35, -12.6],
      [-24, -12.6],
      [-24, -3],
      [-35, -5.5],
    ],
    span: [-15, 15],
  },
  {
    id: 'heel-r',
    color: frame,
    box: [
      [-14, 18, -12.6],
      [14, 25, -3],
    ],
  },
];
const shieldShapes = (): Shape[] => [
  {
    id: 'shield-panel',
    color: armour,
    plane: 'xz',
    pts: [
      [-SHIELD_W / 2, 0],
      [SHIELD_W / 2, 0],
      [SHIELD_W / 2, SHIELD_HINGE],
      [0, SHIELD_L],
      [-SHIELD_W / 2, SHIELD_HINGE],
    ],
    span: [0, SHIELD_T],
  },
  {
    id: 'shield-ridge',
    color: sub,
    plane: 'xz',
    pts: [
      [-3.5, 4],
      [3.5, 4],
      [2, SHIELD_L - 10],
      [-2, SHIELD_L - 10],
    ],
    span: [SHIELD_T, SHIELD_T + 2],
  },
  {
    id: 'shield-band',
    color: frame,
    plane: 'xz',
    pts: [
      [-SHIELD_W / 2 + 3, 42],
      [SHIELD_W / 2 - 3, 42],
      [SHIELD_W / 2 - 3, 50],
      [-SHIELD_W / 2 + 3, 50],
    ],
    span: [SHIELD_T, SHIELD_T + 1],
  },
];
const flapShapes = (): Shape[] => [
  {
    id: 'flap-r',
    color: armour,
    plane: 'xz',
    pts: [
      [0, 0],
      [SHIELD_W, 0],
      [SHIELD_W * 0.35, SHIELD_HINGE * 0.95],
      [0, SHIELD_HINGE],
    ],
    span: [0, SHIELD_T],
  },
  {
    id: 'flap-edge-r',
    color: sub,
    plane: 'xz',
    pts: [
      [3, 3],
      [SHIELD_W - 4, 3],
      [SHIELD_W - 7, 9],
      [3, 9],
    ],
    span: [SHIELD_T, SHIELD_T + 1.2],
  },
];
const octagon = (rad: number): P2[] =>
  Array.from({ length: 8 }, (_, i) => {
    const a = ((i + 0.5) * Math.PI) / 4;
    return [Math.round(rad * Math.cos(a) * 100) / 100, Math.round(rad * Math.sin(a) * 100) / 100];
  });
/** The rifle along +z, its grip at the origin, the rail on top (−y). */
const rifleShapes = (): Shape[] => [
  {
    id: 'rifle-body',
    color: sub,
    front: [
      [-13.5, -10],
      [13.5, -10],
      [14.4, 58],
      [12, 72],
      [-12, 72],
      [-14.4, 58],
    ],
    side: [
      [-17, -4],
      [-11, -10],
      [16, -10],
      [17, 0],
      [17, 72],
      [-17, 72],
    ],
  },
  { id: 'rifle-shroud', color: armour, plane: 'xy', pts: octagon(9), span: [70, 116] },
  { id: 'rifle-muzzle', color: frame, plane: 'xy', pts: octagon(11), span: [114, 140] },
  {
    id: 'rifle-rail',
    color: armour,
    box: [
      [-5.4, -30, -6],
      [5.4, -16, 50],
    ],
  },
  {
    id: 'rifle-scope',
    color: frame,
    box: [
      [-4, -36, 10],
      [4, -29, 40],
    ],
  },
  {
    id: 'rifle-grip',
    color: frame,
    box: [
      [-6.3, 16, -7.2],
      [6.3, 28, 18],
    ],
  },
];
const sparShapes = (k: number): Shape[] => {
  const w = r(k === 2 ? 0.018 : 0.024);
  const L = WL[k]!;
  return [
    {
      id: `spar-${k}-r`,
      color: frame,
      box: [
        [0, -2.52, -w / 2],
        [L, 2.52, w / 2],
      ],
    },
    {
      id: `edge-${k}-r`,
      color: armour,
      plane: 'xz',
      pts: [
        [0, w / 2 - 1],
        [L, w / 2 - 1],
        [L - 3, w / 2 + 3],
        [2, w / 2 + 5],
      ],
      span: [-3.5, 3.5],
    },
  ];
};
/** A pointed feather from the origin along +x, in the wing's plane (x, z), 1.44 mm thick toward −y. */
const featherShapes = (length: number): Shape[] => {
  const w = r(0.055);
  return [
    {
      id: 'feather-r',
      color: armour,
      plane: 'xz',
      pts: [
        [0, -w / 2],
        [length * 0.8, -w * 0.45],
        [length, 0],
        [length * 0.8, w * 0.45],
        [0, w / 2],
      ],
      span: [-1.44, 0],
      cuts: [groove('xz', [3, 0], [length * 0.82, 0], 0.7, [-0.5, 0.5])],
    },
  ];
};
/**
 * The stand: its top this far under the soles, so they clear it as the body tips forward, and
 * narrow enough for the rifle, hanging from the right hand at the hand-over, to swing past it.
 */
const BASE_GAP = 6;
const baseShapes = (): Shape[] => [
  {
    id: 'base',
    color: '#5b6270',
    box: [
      [-46, -80, -11],
      [46, 80, -BASE_GAP],
    ],
  },
];

// ---------------------------------------------------------------- D6 detail
/** A groove `w` wide from `a` to `b` in a plane, cut `span` deep: a panel line or a slit. */
function groove(
  plane: Prism['plane'],
  [u0, v0]: P2,
  [u1, v1]: P2,
  w: number,
  span: [number, number],
): Prism {
  const len = Math.hypot(u1 - u0, v1 - v0);
  const [nu, nv] = [(-(v1 - v0) / len) * (w / 2), ((u1 - u0) / len) * (w / 2)];
  const q = (n: number) => Math.round(n * 1000) / 1000;
  return {
    plane,
    pts: [
      [q(u0 + nu), q(v0 + nv)],
      [q(u1 + nu), q(v1 + nv)],
      [q(u1 - nu), q(v1 - nv)],
      [q(u0 - nu), q(v0 - nv)],
    ],
    span,
  };
}
/** Slits across a plate: `n` grooves 1.6 mm wide, `step` apart from `at`, from `u0` to `u1`. */
const slits = (
  plane: Prism['plane'],
  u0: number,
  u1: number,
  at: number,
  step: number,
  n: number,
  span: [number, number],
) =>
  Array.from({ length: n }, (_, i) =>
    groove(plane, [u0, at + i * step], [u1, at + i * step], 1.6, span),
  );
/** A nozzle pointing down (−z) at (x, y): an octagonal can from `z0` to `z1`, its bore cut in. */
const nozzle = (id: string, x: number, y: number, rad: number, z0: number, z1: number): Shape => ({
  id,
  color: frame,
  plane: 'xy',
  pts: octagon(rad).map(([u, v]) => [u + x, v + y] as P2),
  span: [z0, z1],
  cuts: [
    {
      plane: 'xy',
      pts: octagon(rad * 0.68).map(([u, v]) => [u + x, v + y] as P2),
      span: [z0 - 1, z1 - 2],
    },
  ],
});
/** Each part's detail: cuts into its bodies (right side; the left mirrors) and added bodies. */
const DETAIL: Record<string, { cuts?: Record<string, Prism[]>; add?: Shape[] }> = {
  torso: {
    cuts: {
      'pec-r': [
        groove('xz', [8, 288], [40, 288], 0.8, [-36, -32.6]),
        groove('xz', [24, 276], [24, 300], 0.8, [-36, -32.6]),
      ],
      'chest-side-r': slits('yz', -14, 8, 268, 6, 4, [45.6, 47.5]),
      'abdomen-2': [groove('xz', [0, 228], [0, 238], 0.8, [-21, -19])],
      pack: [
        groove('xz', [10, 258], [10, 300], 0.8, [26.4, 29]),
        groove('xz', [-10, 258], [-10, 300], 0.8, [26.4, 29]),
        groove('xz', [-10, 280], [10, 280], 0.8, [26, 29]),
      ],
    },
    add: [
      nozzle('pack-nozzle-r', 12, 22, 5.5, 240, 253),
      nozzle('pack-nozzle-l', -12, 22, 5.5, 240, 253),
    ],
  },
  head: {
    add: both({
      id: 'antenna-r',
      color: armour,
      plane: 'yz',
      pts: [
        [-4, 352],
        [0, 354],
        [16, 370],
        [13, 371],
      ],
      span: [3, 4.2],
    }),
  },
  upper: { cuts: { 'pauldron-plate-r': [groove('yz', [-12, -3], [12, -3], 0.8, [21.4, 23])] } },
  skirt: {
    cuts: {
      'skirt-front-r': [
        groove(
          'xz',
          [11 - SKIRT_HINGE[0], 200 - SKIRT_HINGE[2]],
          [33 - SKIRT_HINGE[0], 203 - SKIRT_HINGE[2]],
          0.8,
          [-24 - SKIRT_HINGE[1], -22.4 - SKIRT_HINGE[1]],
        ),
      ],
    },
  },
  fore: { cuts: { 'gauntlet-plate-r': slits('yz', 10, 24, -46, 6, 3, [17.2, 19]) } },
  thigh: {
    cuts: {
      'thigh-front-r': [groove('xz', [-9, -60], [10, -60], 0.8, [-19, -17.4])],
      'thigh-plate-r': slits('yz', -8, 4, -70, 6, 3, [17.2, 19]),
    },
  },
  shin: {
    cuts: {
      'shin-front-r': [groove('xz', [0, -70], [0, -30], 0.8, [-24.5, -22.9])],
      'calf-r': slits('xz', -10, 10, -60, 7, 3, [23.2, 25]),
    },
    add: [nozzle('calf-nozzle-r', 0, 19, 4.5, -80, -70)],
  },
  shield: {
    cuts: {
      'shield-panel': [
        groove('xz', [11, 8], [11, 60], 0.8, [2, 3]),
        groove('xz', [-11, 8], [-11, 60], 0.8, [2, 3]),
        groove('xz', [-17, 70], [17, 70], 0.8, [2, 3]),
      ],
    },
  },
  rifle: {
    cuts: {
      'rifle-muzzle': [{ plane: 'xy', pts: octagon(5), span: [120, 141] }],
      'rifle-shroud': [
        ...slits('yz', -3, 3, 80, 8, 4, [7.4, 10]),
        ...slits('yz', -3, 3, 80, 8, 4, [-10, -7.4]),
      ],
    },
  },
};
/** A marking 0.3 mm proud of a face: an outline in the face's plane, `base` the face's level. */
const decal = (
  id: string,
  plane: Prism['plane'],
  pts: P2[],
  base: number,
  out: 1 | -1 = 1,
): Shape => ({
  id,
  color: accent,
  plane,
  pts,
  span: out > 0 ? [base - 0.2, base + 0.3] : [base - 0.3, base + 0.2],
});
/** The 雷 bolt, the unit's emblem, in a box `w` × `h` at (u, v). */
const bolt = (u: number, v: number, w: number, h: number): P2[] =>
  (
    [
      [0.55, 1],
      [0.15, 0.45],
      [0.45, 0.45],
      [0.3, 0],
      [0.85, 0.6],
      [0.55, 0.6],
      [0.75, 1],
    ] as P2[]
  ).map(([a, b]) => [Math.round((u + a * w) * 100) / 100, Math.round((v + b * h) * 100) / 100]);
/** Seven-segment digits (the unit number) as stroke outlines, each `w` × `h`, from (u, v). */
function digits(
  text: string,
  u: number,
  v: number,
  w: number,
  h: number,
  t: number,
  du = 1,
  dv = 1,
): P2[][] {
  const seg: Record<string, [number, number, number, number][]> = {
    a: [[0, 1, 1, 1]],
    b: [[1, 0.5, 1, 1]],
    c: [[1, 0, 1, 0.5]],
    d: [[0, 0, 1, 0]],
    e: [[0, 0, 0, 0.5]],
    f: [[0, 0.5, 0, 1]],
    g: [[0, 0.5, 1, 0.5]],
  };
  const on: Record<string, string> = { '0': 'abcdef', '1': 'bc', '7': 'abc' };
  return [...text].flatMap((ch, i) =>
    [...on[ch]!].flatMap((k) =>
      seg[k]!.map(([x0, y0, x1, y1]) => {
        const lo: P2 = [Math.min(x0, x1) * w - t / 2, Math.min(y0, y1) * h - t / 2];
        const hi: P2 = [Math.max(x0, x1) * w + t / 2, Math.max(y0, y1) * h + t / 2];
        const at = ([a, b]: P2): P2 => [
          Math.round((u + du * (a + i * (w + t * 2.5))) * 100) / 100,
          Math.round((v + dv * b) * 100) / 100,
        ];
        return [at(lo), at([hi[0], lo[1]]), at(hi), at([lo[0], hi[1]])];
      }),
    ),
  );
}
// The shield hangs tip down in Stand, so its marks are drawn with +z pointing down.
const MARK_DIGITS = digits('01', -16, 34, 3.2, 6, 1.1, 1, -1);
DETAIL.shield!.add = [
  decal('mark-bolt', 'xz', bolt(5, 92, 7, -16), SHIELD_T),
  ...MARK_DIGITS.map((pts, i) => decal(`mark-no${i}`, 'xz', pts, SHIELD_T)),
];
DETAIL.upper!.add = [decal('mark-bolt-r', 'yz', bolt(-5, -11, 9, 16), 22)];
/** The shapes with the part's D6 detail. */
function detailed(key: string, shapes: Shape[]): Shape[] {
  const d = DETAIL[key];
  if (!d) return shapes;
  const cutsOf = (id: string) =>
    d.cuts?.[id] ??
    (id.endsWith('-l') ? d.cuts?.[id.replace(/-l$/, '-r')]?.map(mirrorPrism) : undefined);
  return [
    ...shapes.map((s) =>
      cutsOf(s.id) ? { ...s, cuts: [...(s.cuts ?? []), ...cutsOf(s.id)!] } : s,
    ),
    ...(d.add ?? []),
  ];
}
/** The wing's covert plate over its feather roots, on the side away from the next segment's feathers. */
const covert = (k: number): Shape[] => {
  if (k === 0) return [];
  const w = r(k === 2 ? 0.018 : 0.024);
  const L = WL[k]!;
  return [
    {
      id: `covert-${k}-r`,
      color: sub,
      plane: 'xz',
      pts: [
        [2, w / 2 - 1],
        [L - 2, w / 2 - 1],
        [L - 10, -w / 2 - 7],
        [6, -w / 2 - 5],
      ],
      span: [-5, -3.5],
    },
  ];
};

/** 迅雷 at D6: its parts, the assembly, and the Stand and Flight forms. */
export function jinraiRobot(kernel: Kernel = fixtureKernel) {
  const sides = (shapes: Shape[]) => ({ r: shapes, l: shapes.map((s) => mirror(s)) });
  const featherLengths = [...new Set(FEATHERS.flat().map((f) => f[1]))];
  const specs: [string, string, Shape[]][] = [
    ['p-base', 'Base', baseShapes()],
    ['p-torso', 'Body', detailed('torso', torsoShapes())],
    ['p-head', 'Head', detailed('head', headShapes())],
    ['p-shield', 'Shield', detailed('shield', shieldShapes())],
    ['p-rifle', 'Rifle', detailed('rifle', rifleShapes())],
    ['p-holster-slide', 'Holster slide', holsterSlideShapes()],
    ['p-holster-arm', 'Holster arm', holsterArmShapes()],
    ['p-crane-link1', 'Hood crane link 1', craneLink1Shapes()],
    ['p-crane-link2', 'Hood crane link 2', craneLink2Shapes()],
    ['p-crane-wrist', 'Hood crane wrist', craneWristShapes()],
    ['p-crane-clamp', 'Hood crane clamp', craneClampShapes()],
  ];
  const lr: [string, string, Shape[]][] = [
    ['slide', 'Shoulder slide', shoulderSlideShapes()],
    ['upper', 'Upper arm', detailed('upper', upperShapes())],
    ['fore', 'Forearm', detailed('fore', foreShapes())],
    ['hip', 'Hip slide', hipShapes()],
    ['skirt', 'Front skirt', detailed('skirt', skirtShapes())],
    ['thigh', 'Thigh', detailed('thigh', thighShapes())],
    ['shin', 'Shin', detailed('shin', shinShapes()).map((x) => shiftY(x, -KNEE_BACK))],
    ['foot', 'Foot', footShapes()],
    ['flap', 'Shield flap', flapShapes()],
    ...[0, 1, 2].map((k): [string, string, Shape[]] => [
      `wing${k}`,
      `Wing ${['root', 'elbow', 'wrist'][k]}`,
      [...sparShapes(k), ...covert(k)],
    ]),
    ...featherLengths.map((len): [string, string, Shape[]] => [
      `feather${Math.round(len * 1000)}`,
      `Feather ${Math.round(len * FEATHER_SCALE * H)} mm`,
      featherShapes(len * FEATHER_SCALE * H),
    ]),
  ];
  for (const [id, name, shapes] of lr) {
    const { r: right, l: left } = sides(shapes);
    specs.push([`p-${id}-r`, `${name} R`, right], [`p-${id}-l`, `${name} L`, left]);
  }
  const built = specs.map(([id, name, shapes]) => ({
    id,
    name,
    ...part(`mecha-jinrai-${id}`, shapes, kernel),
  }));
  const closure = new Map(built.map((b) => [b.version.contentHash, b.version.content] as const));

  let doc = emptyCad(kernel);
  const comp = (id: string, partId: string) => fixtureComponent(id, partId);
  const lrComp = (base: string, partBase: string) =>
    (['r', 'l'] as const).map((s) => comp(`c-${base}-${s}`, `p-${partBase}-${s}`));
  doc = applyCadOperation(doc, {
    type: 'insertComponents',
    parts: built.map((b) => fixturePart(b.id, b.name, b.version, b.bounds)),
    components: [
      fixtureComponent('c-base', 'p-base', [0, 0, 0]),
      comp('c-torso', 'p-torso'),
      comp('c-head', 'p-head'),
      comp('c-shield', 'p-shield'),
      comp('c-rifle', 'p-rifle'),
      comp('c-holster-slide', 'p-holster-slide'),
      comp('c-holster-arm', 'p-holster-arm'),
      comp('c-crane-link1', 'p-crane-link1'),
      comp('c-crane-link2', 'p-crane-link2'),
      comp('c-crane-wrist', 'p-crane-wrist'),
      comp('c-crane-clamp', 'p-crane-clamp'),
      ...[
        'slide',
        'upper',
        'fore',
        'hip',
        'skirt',
        'thigh',
        'shin',
        'foot',
        'flap',
        'wing0',
        'wing1',
        'wing2',
      ].flatMap((b) => lrComp(b, b)),
      ...FEATHERS.flatMap((seg, k) =>
        seg.flatMap((f, i) => lrComp(`feather${k}${i}`, `feather${Math.round(f[1] * 1000)}`)),
      ),
    ],
  });
  const partName = new Map(built.map((b) => [b.id, b.name]));
  for (const c of doc.components) {
    const m = /^c-feather(\d)(\d)-([rl])$/.exec(c.id);
    c.name = m
      ? `Feather ${m[1]}-${m[2]} ${m[3]!.toUpperCase()}`
      : (partName.get(c.partId) ?? c.id);
    // Every component but the base is placed by its joint.
    if (c.id !== 'c-base') c.placement = null;
  }

  const rad = (d: number) => ({ literalRad: d * deg });
  const limit = (of: CadJointValueKey, min: number, max: number) => ({ of, min, max });
  const angleLimit = (a: number, b: number) =>
    limit('angle', (Math.min(a, b) - 0.5) * deg, (Math.max(a, b) + 0.5) * deg);
  const joints: CadJoint[] = [];
  const add = (j: CadJoint, name: string) => joints.push({ ...j, name });
  const revolute = (
    id: string,
    name: string,
    parent: string,
    at: Vec3,
    axis: Quaternion,
    child: string,
    value: number,
    range: [number, number],
  ) =>
    add(
      fixtureJoint(
        id,
        'revolute',
        conn([parent], at, axis),
        child,
        conn([], [0, 0, 0], axis),
        { angle: rad(value) },
        [angleLimit(...range)],
      ),
      name,
    );
  const slider = (
    id: string,
    name: string,
    parent: string,
    at: Vec3,
    axis: Quaternion,
    child: string,
    max: number,
  ) =>
    add(
      fixtureJoint(
        id,
        'slider',
        conn([parent], at, axis),
        child,
        conn([], [0, 0, 0], axis),
        { distance: { literalMm: 0 } },
        [limit('distance', 0, max)],
      ),
      name,
    );
  const fastened = (
    id: string,
    name: string,
    parent: string,
    at: Vec3,
    rotation: Quaternion,
    child: string,
  ) =>
    add(
      fixtureJoint(id, 'fastened', conn([parent], at, rotation), child, fixtureConnector()),
      name,
    );
  const follow = (id: string, from: string, ratio: number, offsetDeg = 0) => {
    const j = joints.find((x) => x.id === id)!;
    j.couplings = [
      { of: 'angle', from: { joint: from, of: 'angle' }, ratio, offset: offsetDeg * deg },
    ];
    j.values = {};
  };

  revolute('j-pitch', 'Pitch', 'c-base', [0, 0, CROTCH], AX.px, 'c-torso', 0, [0, 90]);
  // The torso's own frame is the ground under its hips: the child connector sits at the hips.
  joints[0]!.child.connector = conn([], [0, 0, CROTCH], AX.px);
  fastened('j-head', 'Head', 'c-torso', [0, 0, CY1], identityQuaternion(), 'c-head');
  joints[1]!.child.connector = conn([], [0, 0, CY1]);
  for (const s of ['r', 'l'] as const) {
    const S = s.toUpperCase();
    const sign = s === 'r' ? 1 : -1;
    // the front skirt plate swings forward about its inner edge
    revolute(
      `j-skirt-${s}`,
      `Front skirt ${S}`,
      'c-torso',
      [sign * SKIRT_HINGE[0], SKIRT_HINGE[1], SKIRT_HINGE[2]],
      s === 'r' ? AX.pz : AX.nz,
      `c-skirt-${s}`,
      0,
      [-90, 0],
    );
    // arm: slide out, swing, fold the forearm over the upper arm at the elbow's front pivot
    slider(
      `j-shoulder-slide-${s}`,
      `Shoulder slide ${S}`,
      'c-torso',
      [sign * (SX + ARM_OUT), 0, SY],
      s === 'r' ? AX.px : AX.nx,
      `c-slide-${s}`,
      SHOULDER_OUT,
    );
    revolute(
      `j-shoulder-${s}`,
      `Shoulder ${S}`,
      `c-slide-${s}`,
      [0, 0, 0],
      AX.px,
      `c-upper-${s}`,
      s === 'r' ? -10 : 0,
      [-90, 90],
    );
    revolute(
      `j-elbow-${s}`,
      `Elbow ${S}`,
      `c-upper-${s}`,
      [0, -EZ, -UA],
      AX.px,
      `c-fore-${s}`,
      s === 'r' ? -80 : 0,
      [-165, 0],
    );
    // leg: slide forward and out, thigh up to the belly, shin back onto the thigh, foot down
    const along = qmul(quat(2, (Math.atan2(HIP_TO[1], sign * HIP_TO[0]) * 180) / Math.PI), AX.px);
    slider(
      `j-hip-slide-${s}`,
      `Hip slide ${S}`,
      'c-torso',
      [sign * LX, 0, CROTCH],
      along,
      `c-hip-${s}`,
      HIP_SLIDE,
    );
    revolute(
      `j-hip-${s}`,
      `Hip ${S}`,
      `c-hip-${s}`,
      [0, 0, 0],
      AX.px,
      `c-thigh-${s}`,
      0,
      [-168, 0],
    );
    revolute(
      `j-knee-${s}`,
      `Knee ${S}`,
      `c-thigh-${s}`,
      [0, KNEE_BACK, KNEE - CROTCH],
      AX.px,
      `c-shin-${s}`,
      0,
      [0, 165],
    );
    revolute(
      `j-ankle-${s}`,
      `Ankle ${S}`,
      `c-shin-${s}`,
      [0, -KNEE_BACK, FOOT_H - KNEE],
      AX.px,
      `c-foot-${s}`,
      0,
      [-60, 30],
    );
    // wing: three joints in the wing's plane (the left one mirrored: same values)
    const wingAxis = s === 'r' ? AX.ny : AX.py;
    const [wx, wy, wz] = WING_ROOT;
    const chain = [`c-torso`, `c-wing0-${s}`, `c-wing1-${s}`];
    const at: Vec3[] = [
      [sign * wx, wy, wz],
      [sign * WL[0]!, WING_STEP, 0],
      [sign * WL[1]!, WING_STEP, 0],
    ];
    [0, 1, 2].forEach((k) =>
      revolute(
        `j-wing${k}-${s}`,
        `Wing ${['root', 'elbow', 'wrist'][k]} ${S}`,
        chain[k]!,
        at[k]!,
        wingAxis,
        `c-wing${k}-${s}`,
        WING_STAND[k]!,
        [WING_STAND[k]!, WING_FLIGHT[k]!],
      ),
    );
    FEATHERS.forEach((seg, k) =>
      seg.forEach(([t, , a, af], i) =>
        revolute(
          `j-feather${k}${i}-${s}`,
          `Feather ${k}-${i} ${S}`,
          `c-wing${k}-${s}`,
          [sign * WL[k]! * t, FEATHER_Y(i), 0],
          wingAxis,
          `c-feather${k}${i}-${s}`,
          af,
          [af, a],
        ),
      ),
    );
    // shield flaps: hinged on the panel's long edges about the panel's z
    revolute(
      `j-flap-${s}`,
      `Shield flap ${S}`,
      'c-shield',
      [(sign * SHIELD_W) / 2, 0, 0],
      AX.pz,
      `c-flap-${s}`,
      -sign * 12,
      [-sign * 12, -sign * 90],
    );
  }
  // The right wing follows the left; each feather follows its wing joint.
  for (const k of [0, 1, 2]) follow(`j-wing${k}-r`, `j-wing${k}-l`, 1);
  for (const s of ['r', 'l'] as const)
    FEATHERS.forEach((seg, k) =>
      seg.forEach(([, , a, af], i) => {
        const ratio = (a - af) / (WING_FLIGHT[k]! - WING_STAND[k]!);
        follow(`j-feather${k}${i}-${s}`, `j-wing${k}-l`, ratio, af - ratio * WING_STAND[k]!);
      }),
    );
  follow('j-flap-l', 'j-flap-r', -1);
  // Mounts: the shield on the left forearm or on the head; the rifle in the right hand or under the chest.
  fastened(
    'j-shield-arm',
    'Shield on arm',
    'c-fore-l',
    [-(r(0.075 * 0.62) + r(0.012)), EZ, r(0.03)],
    [Math.SQRT1_2, -Math.SQRT1_2, 0, 0],
    'c-shield',
  );
  fastened(
    'j-shield-head',
    'Shield on head',
    'c-crane-clamp',
    [0, -CLAMP_Y, CRANE_STEM],
    identityQuaternion(),
    'c-shield',
  );
  fastened(
    'j-rifle-hand',
    'Rifle in hand',
    'c-fore-r',
    [0, EZ, -FA - HAND / 2 - RIFLE_DROP],
    [1, 0, 0, 0],
    'c-rifle',
  );
  // The hood crane: folded behind the head (all 0); reaching round to the left forearm to hand over.
  const range = (k: number) => {
    const v = Object.values(CRANE_POSES).map((p) => p[k]!);
    return [Math.min(...v), Math.max(...v)] as [number, number];
  };
  fastened(
    'j-crane-1',
    'Hood crane boom',
    'c-torso',
    [CRANE_ROOT[0], CY, CRANE_ROOT[1]],
    identityQuaternion(),
    'c-crane-link1',
  );
  const arm = sub2(CRANE_PIVOT, CRANE_ROOT);
  const reach = sub2(CRANE_HOOD, CRANE_PIVOT);
  revolute(
    'j-crane-2',
    'Hood crane arm',
    'c-crane-link1',
    [arm[0], 0, arm[1]],
    AX.py,
    'c-crane-link2',
    0,
    range(0),
  );
  revolute(
    'j-crane-3',
    'Hood crane wrist pitch',
    'c-crane-link2',
    [reach[0], 0, reach[1]],
    AX.py,
    'c-crane-wrist',
    0,
    range(1),
  );
  revolute(
    'j-crane-4',
    'Hood crane wrist roll',
    'c-crane-wrist',
    [0, 0, 0],
    AX.pz,
    'c-crane-clamp',
    0,
    range(2),
  );
  // The holster: parked under the chest (all 0); out at the right hip and swung down to take the
  // rifle from the hanging hand.
  slider(
    'j-holster-slide',
    'Holster slide',
    'c-torso',
    [0, ...HOLSTER_PIVOT],
    AX.px,
    'c-holster-slide',
    HOLSTER_OUT,
  );
  revolute(
    'j-holster',
    'Holster',
    'c-holster-slide',
    [0, 0, 0],
    AX.px,
    'c-holster-arm',
    0,
    [0, 180],
  );
  fastened(
    'j-rifle-belly',
    'Rifle under chest',
    'c-holster-arm',
    [0, BELLY[0] - HOLSTER_PIVOT[0], BELLY[1] - HOLSTER_PIVOT[1]],
    identityQuaternion(),
    'c-rifle',
  );
  doc.joints = joints;
  doc.mounts = [
    {
      id: 'm-shield',
      name: 'Shield',
      component: 'c-shield',
      joints: ['j-shield-arm', 'j-shield-head'],
      active: 'j-shield-arm',
    },
    {
      id: 'm-rifle',
      name: 'Rifle',
      component: 'c-rifle',
      joints: ['j-rifle-hand', 'j-rifle-belly'],
      active: 'j-rifle-hand',
    },
  ];
  // The pins at the joints are intended: allowed near their joints only.
  const allow = (id: string, a: string, b: string, joint: string, radiusMm: number) => ({
    id,
    a: [a],
    b: [b],
    region: { kind: 'joint-sphere' as const, joint, radiusMm },
  });
  doc.interferenceAllowances = [
    allow('allow-head', 'c-torso', 'c-head', 'j-head', 30),
    ...(['r', 'l'] as const).flatMap((s) => [
      allow(`allow-slide-${s}`, 'c-torso', `c-slide-${s}`, `j-shoulder-slide-${s}`, 25),
      allow(`allow-slide-upper-${s}`, `c-slide-${s}`, `c-upper-${s}`, `j-shoulder-${s}`, 25),
      allow(`allow-elbow-${s}`, `c-upper-${s}`, `c-fore-${s}`, `j-elbow-${s}`, 25),
      allow(`allow-hip-slide-${s}`, 'c-torso', `c-hip-${s}`, `j-hip-slide-${s}`, 25),
      allow(`allow-skirt-${s}`, 'c-torso', `c-skirt-${s}`, `j-skirt-${s}`, 16),
      allow(`allow-hip-${s}`, `c-hip-${s}`, `c-thigh-${s}`, `j-hip-${s}`, 25),
      allow(`allow-hip-body-${s}`, 'c-torso', `c-thigh-${s}`, `j-hip-${s}`, 30),
      allow(`allow-shoulder-body-${s}`, 'c-torso', `c-upper-${s}`, `j-shoulder-${s}`, 30),
      allow(`allow-knee-${s}`, `c-thigh-${s}`, `c-shin-${s}`, `j-knee-${s}`, 30),
      allow(`allow-ankle-${s}`, `c-shin-${s}`, `c-foot-${s}`, `j-ankle-${s}`, 25),
      allow(`allow-wing0-${s}`, 'c-torso', `c-wing0-${s}`, `j-wing0-${s}`, 15),
      allow(`allow-wing1-${s}`, `c-wing0-${s}`, `c-wing1-${s}`, `j-wing1-${s}`, 15),
      allow(`allow-wing2-${s}`, `c-wing1-${s}`, `c-wing2-${s}`, `j-wing2-${s}`, 15),
      allow(`allow-flap-${s}`, 'c-shield', `c-flap-${s}`, `j-flap-${s}`, 70),
      ...FEATHERS.flatMap((seg, k) =>
        seg.map((_, i) =>
          allow(
            `allow-feather${k}${i}-${s}`,
            `c-wing${k}-${s}`,
            `c-feather${k}${i}-${s}`,
            `j-feather${k}${i}-${s}`,
            12,
          ),
        ),
      ),
    ]),
    allow('allow-shield-arm', 'c-fore-l', 'c-shield', 'j-shield-arm', 20),
    allow('allow-rifle-hand', 'c-fore-r', 'c-rifle', 'j-rifle-hand', 30),
    allow('allow-crane-1', 'c-torso', 'c-crane-link1', 'j-crane-1', 10),
    allow('allow-crane-2', 'c-crane-link1', 'c-crane-link2', 'j-crane-2', 10),
    allow('allow-crane-3', 'c-crane-link2', 'c-crane-wrist', 'j-crane-3', 8),
    allow('allow-crane-4', 'c-crane-wrist', 'c-crane-clamp', 'j-crane-4', 8),
    allow('allow-shield-clamp', 'c-crane-clamp', 'c-shield', 'j-shield-head', 10),
    allow('allow-holster', 'c-holster-slide', 'c-holster-arm', 'j-holster', 16),
    allow('allow-crane-wrist', 'c-crane-link2', 'c-crane-clamp', 'j-crane-3', 12),
    allow('allow-holster-slide', 'c-torso', 'c-holster-slide', 'j-holster-slide', 12),
    allow('allow-rifle-holster', 'c-holster-arm', 'c-rifle', 'j-rifle-belly', 40),
  ];
  settle(doc, closure);
  const stand = currentConfigurationValues(doc);
  const flightDeg: Record<string, number> = {
    'j-pitch': 90,
    'j-shoulder-r': 0,
    'j-shoulder-l': 0,
    'j-elbow-r': -165,
    'j-elbow-l': -165,
    'j-hip-r': -168,
    'j-hip-l': -168,
    'j-knee-r': 165,
    'j-knee-l': 165,
    'j-wing0-l': WING_FLIGHT[0]!,
    'j-wing1-l': WING_FLIGHT[1]!,
    'j-wing2-l': WING_FLIGHT[2]!,
    'j-flap-r': -90,
    'j-skirt-r': -90,
    'j-skirt-l': -90,
  };
  const flight = {
    ...stand,
    ...Object.fromEntries(Object.entries(flightDeg).map(([id, d]) => [id, { angle: rad(d) }])),
    'j-shoulder-slide-r': { distance: { literalMm: SHOULDER_OUT } },
    'j-shoulder-slide-l': { distance: { literalMm: SHOULDER_OUT } },
    'j-hip-slide-r': { distance: { literalMm: HIP_SLIDE } },
    'j-hip-slide-l': { distance: { literalMm: HIP_SLIDE } },
  };
  const crane = (k: keyof typeof CRANE_POSES) =>
    Object.fromEntries(CRANE_POSES[k]!.map((a, i) => [`j-crane-${i + 2}`, { angle: rad(a) }]));
  // The hand-over: the right arm hangs the rifle into the holster's cradle (out at the hip, swung
  // down); the left swings back, forearm upright, and the crane comes round to the shield's base.
  const handover = {
    ...stand,
    'j-shoulder-r': { angle: rad(0) },
    'j-elbow-r': { angle: rad(0) },
    'j-shoulder-l': { angle: rad(HANDOVER_SWING_DEG) },
    'j-elbow-l': { angle: rad(-HANDOVER_SWING_DEG) },
    'j-holster-slide': { distance: { literalMm: HOLSTER_OUT } },
    'j-holster': { angle: rad(180) },
    ...crane('handover'),
  };
  // The crane lifts the shield out to the left, tip down, and flips it tip up out there; the
  // holster swings the rifle up and slides it in under the chest.
  const lift = {
    ...handover,
    ...crane('lift'),
    'j-holster': { angle: rad(0) },
    'j-holster-slide': { distance: { literalMm: 0 } },
    'j-shoulder-r': { angle: rad(LET_GO) },
  };
  const flip = { ...lift, ...crane('flip') };
  // Handed over: the shield on the head, its flaps wrapped round; the rifle under the chest.
  const stow = { ...flip, ...crane('stow'), 'j-flap-r': { angle: rad(-90) } };
  // Taking off: the front skirt up, the hips slid out from under it, the body tipped forward.
  const takeoff = {
    ...stow,
    'j-skirt-r': { angle: rad(-90) },
    'j-skirt-l': { angle: rad(-90) },
    'j-hip-slide-r': { distance: { literalMm: HIP_SLIDE } },
    'j-hip-slide-l': { distance: { literalMm: HIP_SLIDE } },
    'j-pitch': { angle: rad(90) },
  };
  const hands = { 'm-shield': 'j-shield-arm', 'm-rifle': 'j-rifle-hand' };
  const stowed = { 'm-shield': 'j-shield-head', 'm-rifle': 'j-rifle-belly' };
  const formOf = (name: string, values: typeof stand, mounts: Record<string, string>) => ({
    id: `form-${name.toLowerCase()}`,
    name,
    values,
    mounts,
  });
  doc.configurations = [
    formOf('Stand', stand, hands),
    formOf('Handover', handover, hands),
    formOf('Lift', lift, stowed),
    formOf('Flip', flip, stowed),
    formOf('Stow', stow, stowed),
    formOf('Takeoff', takeoff, stowed),
    formOf('Flight', flight, stowed),
  ];
  assertCad(doc);
  return { closure, assembly: doc, hash: cadContentHash(doc) };
}

/** Ease in and out, as the character player eases a key (a cubic Bézier, CSS's ease-in-out). */
const EASE = Object.freeze({ type: 'bezier', x1: 0.42, y1: 0, x2: 0.58, y2: 1 } as const);
const group = (name: string, joints: string[], start: number, length: number) =>
  Object.freeze({ name, joints: Object.freeze(joints), start, length, easing: EASE });
/**
 * 迅雷's transformation, Stand → Handover → Stow → Flight: each step from one form to the next,
 * its joints moving in groups, each group easing in and out over its own window (seconds). The
 * mounts switch at a step's start going forward and at its end going back. A follower joint (the
 * right wing, the left flap) moves with its leader.
 */
export const jinraiTransform = Object.freeze({
  stages: Object.freeze([
    Object.freeze({
      from: 'Stand',
      to: 'Handover',
      seconds: 2.4,
      groups: Object.freeze([
        group('Right arm', ['j-shoulder-r', 'j-elbow-r'], 0, 0.8),
        group('Left arm', ['j-shoulder-l', 'j-elbow-l'], 0, 0.8),
        group('Holster', ['j-holster'], 0.8, 1.4),
        group('Holster slide', ['j-holster-slide'], 1.1, 0.6),
        group('Crane', ['j-crane-2', 'j-crane-3', 'j-crane-4'], 0.3, 2.1),
      ]),
    }),
    Object.freeze({
      from: 'Handover',
      to: 'Lift',
      seconds: 1.6,
      groups: Object.freeze([
        group('Crane', ['j-crane-2', 'j-crane-3'], 0, 1.6),
        group('Let go', ['j-shoulder-r'], 0, 0.4),
        group('Holster', ['j-holster'], 0.4, 1.2),
        group('Holster slide', ['j-holster-slide'], 1, 0.5),
      ]),
    }),
    Object.freeze({
      from: 'Lift',
      to: 'Flip',
      seconds: 1,
      groups: Object.freeze([group('Wrist', ['j-crane-3', 'j-crane-4'], 0, 1)]),
    }),
    Object.freeze({
      from: 'Flip',
      to: 'Stow',
      seconds: 2,
      groups: Object.freeze([
        group('Crane', ['j-crane-2', 'j-crane-3'], 0, 1.5),
        group('Hood', ['j-flap-r'], 1.5, 0.5),
      ]),
    }),
    Object.freeze({
      from: 'Stow',
      to: 'Takeoff',
      seconds: 2,
      groups: Object.freeze([
        group('Pitch', ['j-pitch'], 0, 1.2),
        group('Skirt', ['j-skirt-r', 'j-skirt-l'], 0.8, 0.4),
        group('Hip slides', ['j-hip-slide-r', 'j-hip-slide-l'], 1.2, 0.8),
      ]),
    }),
    Object.freeze({
      from: 'Takeoff',
      to: 'Flight',
      seconds: 2.4,
      groups: Object.freeze([
        group('Legs', ['j-hip-r', 'j-hip-l', 'j-knee-r', 'j-knee-l'], 0.2, 1.2),
        group(
          'Arms',
          [
            'j-shoulder-slide-r',
            'j-shoulder-slide-l',
            'j-shoulder-r',
            'j-shoulder-l',
            'j-elbow-r',
            'j-elbow-l',
          ],
          0.2,
          1.2,
        ),
        group('Wings', ['j-wing0-l', 'j-wing1-l', 'j-wing2-l'], 1, 1.4),
      ]),
    }),
  ]),
});

/** Solves the stored poses from the joints and checks the document. */
function settle(doc: CadDocument, closure: Map<string, CadDocument>) {
  doc.solvedPoses = Object.fromEntries(
    doc.components.map((c) => [
      c.id,
      c.placement
        ? {
            translationMm: c.placement.translation.map((v) => ('literalMm' in v ? v.literalMm : 0)),
            rotation: c.placement.rotation,
          }
        : identityPose(),
    ]),
  ) as CadDocument['solvedPoses'];
  doc.solvedPoses = solveJoints(
    doc,
    parameterValues(doc),
    (h) => closure.get(h),
    () => undefined,
    () => true,
  ).poses;
  assertCad(doc);
}
