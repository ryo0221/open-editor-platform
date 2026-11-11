/**
 * MR1 fixture (docs/cad/mecha-design.md, MR1): a small arm and a pair of wings on R2b-1 plates,
 * all on origin connectors so no kernel frame is needed. The shoulder is spherical, the elbow
 * revolute with a limit, the wrist universal; the right wing's angle follows the left wing's
 * mirrored (`ratio −1`), and its own limit is the left one's mirror.
 */
import { composePoses, identityPose } from './assembly';
import { currentConfigurationValues } from './configurations';
import { fixtureComponent, fixturePart, fixtureVersion, r2bParts } from './assembly-fixtures';
import { f02Plate, fixtureKernel } from './fixtures';
import { parameterValues } from './graph';
import { fixtureConnector, fixtureJoint } from './joints-fixtures';
import {
  invertPose,
  posesForJointValues,
  solveJoints,
  type CadConnector,
  type CadJoint,
  type CadJointValueKey,
} from './joints';
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

const deg = Math.PI / 180;
const at = (componentPath: string[], x: number, y = 0, z = 0): CadConnector => ({
  ...fixtureConnector(componentPath),
  offset: { translation: position(x, y, z), rotation: [0, 0, 0, 1] },
});

export function mr1ArmWings(kernel: Pick<CadKernelProfile, 'id' | 'buildHash'> = fixtureKernel) {
  const parts = r2bParts(kernel);
  const { plate, closure } = parts;
  const doc: CadDocument = structuredClone(f02Plate());
  doc.kernelProfile = { ...doc.kernelProfile, ...kernel };
  doc.parts = [fixturePart('part-plate', 'Plate', plate)];
  const free = (id: string) => ({ ...fixtureComponent(id, 'part-plate'), placement: null });
  doc.components = ['c-upper', 'c-fore', 'c-hand', 'c-wing-l', 'c-wing-r'].map(free);
  doc.joints = [
    fixtureJoint(
      'j-shoulder',
      'spherical',
      at([], 0, 0, 200),
      'c-upper',
      fixtureConnector(),
      {
        angle: { literalRad: 30 * deg },
        angle2: { literalRad: -20 * deg },
        angle3: { literalRad: 10 * deg },
      },
      [{ of: 'angle2', min: -90 * deg, max: 90 * deg }],
    ),
    fixtureJoint(
      'j-elbow',
      'revolute',
      at(['c-upper'], 80),
      'c-fore',
      fixtureConnector(),
      { angle: { literalRad: 45 * deg } },
      [{ of: 'angle', min: 0, max: 150 * deg }],
    ),
    fixtureJoint('j-wrist', 'universal', at(['c-fore'], 80), 'c-hand', fixtureConnector(), {
      angle: { literalRad: 15 * deg },
      angle2: { literalRad: -25 * deg },
    }),
    fixtureJoint(
      'j-wing-l',
      'revolute',
      at([], 0, 100, 300),
      'c-wing-l',
      fixtureConnector(),
      { angle: { literalRad: 40 * deg } },
      [{ of: 'angle', min: -90 * deg, max: 90 * deg }],
    ),
    {
      ...fixtureJoint(
        'j-wing-r',
        'revolute',
        at([], 0, -100, 300),
        'c-wing-r',
        fixtureConnector(),
        {},
        [{ of: 'angle', min: -90 * deg, max: 90 * deg }],
      ),
      couplings: [{ of: 'angle', from: { joint: 'j-wing-l', of: 'angle' }, ratio: -1, offset: 0 }],
    },
  ];
  doc.solvedPoses = Object.fromEntries(doc.components.map((c) => [c.id, identityPose()]));
  const solved = solveJoints(
    doc,
    parameterValues(doc),
    (h) => closure.get(h),
    () => undefined,
    () => true,
  );
  doc.solvedPoses = solved.poses;
  assertCad(doc);
  return { ...parts, assembly: doc, hash: cadContentHash(doc) };
}

/**
 * MR7 fixture: `mr1ArmWings` with a tool (one plate) held 20 mm out of the hand by
 * `j-tool-hand`, and a second candidate `j-tool-back` that would fasten it on the back, 60 mm
 * behind and 150 mm up from this document's origin. The mount `m-tool` has the hand in effect.
 */
export function mr7ToolMount(kernel: Pick<CadKernelProfile, 'id' | 'buildHash'> = fixtureKernel) {
  const base = mr1ArmWings(kernel);
  const doc = structuredClone(base.assembly);
  doc.components.push({ ...fixtureComponent('c-tool', 'part-plate'), placement: null });
  doc.solvedPoses['c-tool'] = identityPose();
  doc.joints.push(
    fixtureJoint('j-tool-hand', 'fastened', at(['c-hand'], 20), 'c-tool', fixtureConnector()),
  );
  doc.joints.push(
    fixtureJoint('j-tool-back', 'fastened', at([], 0, 60, 150), 'c-tool', fixtureConnector()),
  );
  doc.mounts = [
    {
      id: 'm-tool',
      name: 'Tool',
      component: 'c-tool',
      joints: ['j-tool-hand', 'j-tool-back'],
      active: 'j-tool-hand',
    },
  ];
  doc.solvedPoses = solveJoints(
    doc,
    parameterValues(doc),
    (h) => base.closure.get(h),
    () => undefined,
    () => true,
  ).poses;
  assertCad(doc);
  return { ...base, assembly: doc, hash: cadContentHash(doc) };
}

/**
 * MR2 fixture: `mr1ArmWings` with two forms, "Stand" (its own values) and "Flight" (the arm
 * folded back along the body, the wings spread to 80°). The document stands in "Stand".
 */
export function mr2ArmWingsForms(
  kernel: Pick<CadKernelProfile, 'id' | 'buildHash'> = fixtureKernel,
) {
  const base = mr1ArmWings(kernel);
  const doc = structuredClone(base.assembly);
  const rad = (d: number) => ({ literalRad: d * deg });
  doc.configurations = [
    { id: 'form-stand', name: 'Stand', values: currentConfigurationValues(doc) },
    {
      id: 'form-flight',
      name: 'Flight',
      values: {
        'j-shoulder': { angle: rad(0), angle2: rad(-80), angle3: rad(0) },
        'j-elbow': { angle: rad(0) },
        'j-wrist': { angle: rad(0), angle2: rad(0) },
        'j-wing-l': { angle: rad(80) },
      },
    },
  ];
  assertCad(doc);
  return { ...base, assembly: doc, hash: cadContentHash(doc) };
}

/** An axis-aligned box as `[min, max]` corners (mm), in a part's own coordinates. */
type MechaBox = [[number, number, number], [number, number, number]];
type MechaPoint = [number, number];
/**
 * One body of a kit part: an axis-aligned box, or a prism of a convex outline drawn on the
 * part's xy, xz or yz plane (the outline's (u, v) are (x, y), (x, z) or (y, z)) and spanning
 * `span` along the remaining axis.
 */
type MechaShape = { id: string; color: string; opacity?: number } & (
  | { box: MechaBox }
  | { plane: 'xy' | 'xz' | 'yz'; pts: MechaPoint[]; span: [number, number] }
);
/** The plane's orientation: local x, y map to the outline's u, v and local z to the prism's axis. */
const planes = {
  xy: {
    orientation: [0, 0, 0, 1] as Quaternion,
    place: (u: number, v: number, w: number) => [u, v, w],
  },
  // Local z → −y: the prism is drawn from the span's far end back to its near one.
  xz: {
    orientation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] as Quaternion,
    place: (u: number, v: number, w: number) => [u, w, v],
  },
  yz: {
    orientation: [0.5, 0.5, 0.5, 0.5] as Quaternion,
    place: (u: number, v: number, w: number) => [w, u, v],
  },
} as const;
/** Counter-clockwise in (u, v), as a profile's outline is wound. */
function ccw(pts: MechaPoint[]): MechaPoint[] {
  let area = 0;
  pts.forEach(([u, v], i) => {
    const [u2, v2] = pts[(i + 1) % pts.length]!;
    area += u * v2 - u2 * v;
  });
  return area < 0 ? [...pts].reverse() : pts;
}
/** `shape` mirrored across x = 0 (a body of the robot's other side). */
function mirrorX(shape: MechaShape, id: string): MechaShape {
  if ('box' in shape) {
    const [lo, hi] = shape.box;
    return {
      ...shape,
      id,
      box: [
        [-hi[0], lo[1], lo[2]],
        [-lo[0], hi[1], hi[2]],
      ],
    };
  }
  if (shape.plane === 'yz') return { ...shape, id, span: [-shape.span[1], -shape.span[0]] };
  return { ...shape, id, pts: shape.pts.map(([u, v]) => [-u, v] as MechaPoint) };
}
/**
 * A part version made of boxes and prisms, one body each (a body list of several separate
 * solids is how (c) is shown). `opacity` below 1 lets what lies inside be seen.
 */
function kitPart(
  artifactId: string,
  shapes: MechaShape[],
  kernel: Pick<CadKernelProfile, 'id' | 'buildHash'>,
) {
  let doc = emptyCad(kernel);
  const corners: number[][] = [];
  doc = applyCadOperation(doc, {
    type: 'insertFeatures',
    profiles: shapes.flatMap((s) => {
      if ('box' in s) return [];
      const plane = planes[s.plane];
      const [near, far] = s.span;
      const origin = s.plane === 'xz' ? plane.place(0, 0, far) : plane.place(0, 0, near);
      return [
        {
          id: `${s.id}-profile`,
          name: s.id,
          plane: {
            origin: position(...(origin as [number, number, number])),
            orientation: plane.orientation,
          },
          shape: {
            type: 'polyline' as const,
            vertices: ccw(s.pts).map(([u, v], i) => ({ id: `${s.id}-v${i}`, u: mm(u), v: mm(v) })),
          },
        },
      ];
    }),
    features: shapes.map((s) => {
      if ('box' in s) {
        const [lo, hi] = s.box;
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
      }
      for (const [u, v] of s.pts)
        for (const w of s.span) corners.push(planes[s.plane].place(u, v, w));
      return {
        id: `${s.id}-extrude`,
        name: s.id,
        type: 'extrude' as const,
        inputFeatureIds: [] as [],
        args: {
          profileId: `${s.id}-profile`,
          distance: mm(s.span[1] - s.span[0]),
          direction: 1 as const,
        },
      };
    }),
    bodies: shapes.map(({ id, color, opacity, ...s }) => ({
      id,
      name: id,
      sourceFeatureId: 'box' in s ? `${id}-box` : `${id}-extrude`,
      placementFeatureId: `${id}-placement`,
      appearance: { color, opacity: opacity ?? 1 },
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
/** A part version of boxes only (the interference cases). */
const boxPart = (
  artifactId: string,
  boxes: { id: string; box: MechaBox; color: string; opacity?: number }[],
  kernel: Pick<CadKernelProfile, 'id' | 'buildHash'>,
) => kitPart(artifactId, boxes, kernel);
const quat = (axis: 0 | 1 | 2, d: number): Quaternion => {
  const q: Quaternion = [0, 0, 0, Math.cos((d * deg) / 2)];
  q[axis] = Math.sin((d * deg) / 2);
  return q;
};
const rotZ = (d: number): Quaternion => quat(2, d);
/** A hinge across the robot (about +x): a revolute turns about its connectors' z. */
const acrossX = quat(1, 90);
const connectorAt = (
  componentPath: string[],
  [x, y, z]: [number, number, number],
  rotation: Quaternion = [0, 0, 0, 1],
): CadConnector => ({
  ...fixtureConnector(componentPath),
  offset: { translation: position(x, y, z), rotation },
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

const white = '#eef1f5';
const blue = '#2b5fd9';
const red = '#d63a3a';
const yellow = '#f2c230';
const frame = '#4a505c';
const dark = '#2e333c';
const sensor = '#3ee07a';
/** A pointed feather from `base` at `angle` (degrees, in the outline's plane). */
function feather([bu, bv]: MechaPoint, angle: number, length: number, width: number): MechaPoint[] {
  const [du, dv] = [Math.cos(angle * deg), Math.sin(angle * deg)];
  const [nu, nv] = [-dv, du];
  const at = (along: number, side: number): MechaPoint => [
    Math.round((bu + du * along + nu * side) * 100) / 100,
    Math.round((bv + dv * along + nv * side) * 100) / 100,
  ];
  return [
    at(0, -width / 2),
    at(length * 0.8, -width / 2),
    at(length, 0),
    at(length * 0.8, width / 2),
    at(0, width / 2),
  ];
}
const octagon = (r: number): MechaPoint[] =>
  Array.from({ length: 8 }, (_, i) => {
    const a = ((i + 0.5) * Math.PI) / 4;
    return [Math.round(r * Math.cos(a) * 100) / 100, Math.round(r * Math.sin(a) * 100) / 100];
  });

/**
 * M1 sample (docs/cad/mecha-design.md, M1): TR-01, an original winged robot of angled armour
 * plates (convex prisms) on a display stand. Its body turns on the stand's post at the hips
 * (`j-pitch`), so the robot can stand upright or lie level to fly. A universal neck; two arms,
 * each a spherical shoulder, a revolute elbow (0–150°) and a universal wrist, with a shield on
 * the left forearm (on its own hinge about the forearm) and a rifle in the right hand; two legs
 * of revolute hips, knees and ankles, each with a tail fin folded down its calf; and two wings
 * of fanned feathers hinged on the back pack, the right one following the left mirrored. The parts at each joint are pinned a little into each other, allowed only in a
 * sphere around their joint. Forms: "Stand" (upright, rifle forward, wings half open; the
 * document stands in it) and "Flight" (level as an aircraft: arms reaching forward leaning
 * in, the shield turned under them as the nose, wings spread, tail fins up, feet pointed). Bending an elbow far folds the forearm into the upper arm away from the elbow, and
 * turning a shoulder half round swings the arm into the body: both are reported.
 */
/** M1 sample (MR3): TR-01 as M1 accepted it, standing and flying by its joints only. */
export function m1Robot(kernel: Pick<CadKernelProfile, 'id' | 'buildHash'> = fixtureKernel) {
  return buildRobot(kernel, false);
}
/**
 * M2 sample (MR6, docs/cad/mecha-design.md): TR-01 transforming for real. The head slides down
 * into a bay in the chest on its own neck (`j-head-slide`), and a tip slides out along each
 * wing's spar (`j-wing-ext-l`, the right following); the chest is open above its middle for the
 * head, and the pack stands 2 mm further back.
 */
export function tr01Robot(kernel: Pick<CadKernelProfile, 'id' | 'buildHash'> = fixtureKernel) {
  return buildRobot(kernel, true);
}
/** The M2 body: no neck of its own, the chest split round the head bay above z = 130. */
function bayBody(shapes: MechaShape[]): MechaShape[] {
  return shapes.flatMap((s): MechaShape[] => {
    if (s.id === 'neck') return [];
    if (s.id === 'pack' && 'box' in s)
      return [
        {
          ...s,
          box: [
            [s.box[0][0], 32, s.box[0][2]],
            [s.box[1][0], 64, s.box[1][2]],
          ],
        },
      ];
    if (s.id !== 'chest' || !('plane' in s)) return [s];
    return [
      { ...s, id: 'chest-r', span: [27, 68] },
      { ...s, id: 'chest-l', span: [-68, -27] },
      {
        ...s,
        id: 'chest-mid',
        span: [-27, 27],
        pts: [
          [-40, 88],
          [32, 88],
          [34.3, 130],
          [-46.6, 130],
        ],
      },
    ];
  });
}
function buildRobot(kernel: Pick<CadKernelProfile, 'id' | 'buildHash'>, m2: boolean) {
  // Flight: the shoulders reach forward leaning in (−105°), the shield turns under the arms as
  // the nose, and the tail fins swing up. The shield plate sits 35 mm off its forearm's axis, so
  // turned under, it lies near the middle.
  const [SH2, SHIELD, FIN, SDY] = [-105, 90, 90, -35];
  // M2: a taller post lets the toes clear the base as the body pitches over.
  const POST = m2 ? 344 : 314;
  // MR7d: the knees fold back (their pivot 32 mm behind the leg's axis), the feet point back.
  const KP = 32;
  const [ANK, KNF] = [-45, 165];
  // MR7d: the right wrist's turn before the arm rises (degrees): the rifle's body rolls clear of
  // the forearm, which it would cut through turning straight to Stow's wrist.
  const READY_WRIST = { angle: -15, angle2: -90 };
  // MR7d: the hand-off pose (degrees), from the Stand values: where the right hand puts the rifle
  // on the back and the left forearm the shield at the nose.
  const STOW: Record<string, Record<string, number>> = {
    'j-head-slide': { distance: -56 },
    'j-wing-l': { angle: 85 },
    'j-shoulder-r': { angle: -52.093, angle2: -89.449, angle3: -91.052 },
    'j-elbow-r': { angle: 93.53 },
    'j-wrist-r': { angle: 92.988, angle2: -253.279 },
    'j-shoulder-l': { angle: 67.651, angle2: -6.15, angle3: 90 },
    'j-elbow-l': { angle: 83.851 },
    'j-shield': { angle: 112.349 },
  };
  // MR7d: from the hand-off, the rifle slides down the back, and the shield across to the middle
  // of the nose and in against the chest (mm).
  const [RIFLE_DOWN, SHIELD_IN, SHIELD_BACK] = [190, 121.3, 50];
  // MR7d: Flight's arms, folded along the sides (degrees).
  const FLIGHT_ARMS: Record<string, Record<string, number>> = {
    'j-shoulder-r': { angle: -90, angle2: 90, angle3: -90 },
    'j-shoulder-l': { angle: 90, angle2: 90, angle3: 90 },
    'j-elbow-r': { angle: 0 },
    'j-elbow-l': { angle: 0 },
  };
  const FIN_LIMIT: [number, number] = [0, 90];
  // The robot faces −y; its body's origin is the pivot on the stand, between the hips.
  const sides = (s: MechaShape): MechaShape[] => [s, mirrorX(s, s.id.replace(/-r$/, '-l'))];
  const body = kitPart(
    m2 ? 'mecha-body-bay' : 'mecha-body',
    (m2 ? bayBody : (x: MechaShape[]) => x)([
      {
        id: 'pelvis',
        box: [
          [-42, -26, -6],
          [42, 26, 38],
        ],
        color: white,
      },
      {
        id: 'crotch',
        plane: 'xz',
        pts: [
          [-10, -12],
          [10, -12],
          [14, 30],
          [-14, 30],
        ],
        span: [-32, -26],
        color: red,
      },
      ...sides({
        id: 'skirt-front-r',
        plane: 'xz',
        pts: [
          [16, 34],
          [44, 34],
          [48, -20],
          [20, -34],
        ],
        span: [-35, -29],
        color: white,
      }),
      ...sides({
        id: 'skirt-r',
        plane: 'yz',
        pts: [
          [-28, -24],
          [26, -24],
          [30, 40],
          [-32, 40],
        ],
        span: [64, 70],
        color: white,
      }),
      {
        id: 'abdomen',
        box: [
          [-28, -22, 36],
          [28, 22, 94],
        ],
        color: frame,
      },
      {
        id: 'chest',
        plane: 'yz',
        pts: [
          [-40, 88],
          [32, 88],
          [38, 196],
          [-14, 200],
          [-50, 152],
        ],
        span: [-68, 68],
        color: blue,
      },
      ...sides({
        id: 'chest-side-r',
        plane: 'xz',
        pts: [
          [66, 98],
          [92, 128],
          [88, 180],
          [66, 192],
        ],
        span: [-36, 28],
        color: blue,
      }),
      ...sides({
        id: 'vent-r',
        box: [
          [16, -54, 132],
          [56, -44, 164],
        ],
        color: yellow,
      }),
      {
        id: 'cockpit',
        box: [
          [-12, -50, 100],
          [12, -40, 128],
        ],
        color: red,
      },
      {
        id: 'neck',
        box: [
          [-14, -14, 186],
          [14, 14, 206],
        ],
        color: frame,
      },
      {
        id: 'pack',
        box: [
          [-48, 30, 96],
          [48, 62, 184],
        ],
        color: frame,
      },
      ...sides({
        id: 'nozzle-r',
        box: [
          [18, 34, 70],
          [40, 58, 96],
        ],
        color: '#8a919c',
      }),
    ]),
    kernel,
  );
  const head = kitPart(
    'mecha-head',
    [
      {
        id: 'face',
        box: [
          [-16, -23, 0],
          [16, 14, 34],
        ],
        color: '#c9ced6',
      },
      {
        id: 'helmet',
        plane: 'yz',
        pts: [
          [5, 2],
          [25, 5],
          [30, 34],
          [14, 55],
          [-14, 53],
          [-30, 28],
        ],
        span: [-22, 22],
        color: white,
      },
      {
        id: 'eyes',
        box: [
          [-14, -24.5, 17],
          [14, -22.5, 24],
        ],
        color: sensor,
      },
      {
        id: 'crest',
        plane: 'yz',
        pts: [
          [-22, 46],
          [-9, 50],
          [-34, 92],
          [-41, 90],
        ],
        span: [-2.5, 2.5],
        color: yellow,
      },
      ...sides({
        id: 'fin-r',
        plane: 'yz',
        pts: [
          [-4, 32],
          [12, 34],
          [34, 70],
          [27, 72],
        ],
        span: [21, 24],
        color: blue,
      }),
      {
        id: 'brow',
        box: [
          [-10, -27, 26],
          [10, -20, 34],
        ],
        color: red,
      },
      {
        id: 'chin',
        box: [
          [-7, -26, -2],
          [7, -17, 7],
        ],
        color: red,
      },
    ],
    kernel,
  );
  // Arm parts run along +x from their joint; +z points out from the body on either side.
  const upper = kitPart(
    'mecha-upper-arm',
    [
      {
        id: 'pauldron',
        plane: 'xz',
        pts: [
          [-36, -2],
          [20, -6],
          [50, 16],
          [44, 46],
          [-6, 52],
          [-36, 34],
        ],
        span: [-32, 32],
        color: white,
      },
      {
        id: 'pauldron-edge',
        plane: 'xz',
        pts: [
          [44, 46],
          [50, 16],
          [56, 18],
          [50, 50],
        ],
        span: [-33, 33],
        color: blue,
      },
      {
        id: 'arm',
        box: [
          [0, -14, -14],
          [108, 14, 14],
        ],
        color: frame,
      },
      {
        id: 'bicep',
        box: [
          [52, -17, -12],
          [92, 17, 18],
        ],
        color: white,
      },
    ],
    kernel,
  );
  const foreShapes: MechaShape[] = [
    {
      id: 'fore',
      plane: 'xz',
      pts: [
        [-8, -17],
        [92, -19],
        [92, 22],
        [-8, 18],
      ],
      span: [-18, 18],
      color: white,
    },
    {
      id: 'cuff',
      box: [
        [72, -20, -21],
        [92, 20, 24],
      ],
      color: red,
    },
  ];
  const fore = kitPart('mecha-forearm', foreShapes, kernel);
  // The shield turns about the left forearm's axis on its own hinge, its mount clear of the forearm.
  const shift = (pts: MechaPoint[]): MechaPoint[] => pts.map(([u, v]) => [u, v + SDY]);
  // M2: the shield stands 10 mm further out, its mount clear of the forearm's corners, so it
  // can turn round the forearm.
  const lift = m2 ? 10 : 0;
  const shield = kitPart(
    m2 ? 'mecha-shield-collar' : 'mecha-shield',
    [
      {
        id: 'mount',
        box: [
          [10, -10, m2 ? 29 : 21],
          [60, 10, 25 + lift - (m2 ? 1 : 0)],
        ],
        color: frame,
      },
      {
        id: 'shield',
        plane: 'xy',
        pts: shift([
          [-36, -44],
          [96, -44],
          [170, 0],
          [96, 44],
          [-36, 44],
        ]),
        span: [24 + lift, 30 + lift],
        color: red,
      },
      {
        id: 'shield-face',
        plane: 'xy',
        pts: shift([
          [-28, -36],
          [92, -36],
          [154, 0],
          [92, 36],
          [-28, 36],
        ]),
        span: [30 + lift, 34 + lift],
        color: white,
      },
      {
        id: 'shield-mark',
        plane: 'xy',
        pts: shift([
          [10, 0],
          [40, -14],
          [70, 0],
          [40, 14],
        ]),
        span: [34 + lift, 36 + lift],
        color: yellow,
      },
    ],
    kernel,
  );
  const handShapes: MechaShape[] = [
    {
      id: 'hand',
      box: [
        [-4, -11, -12],
        [30, 11, 12],
      ],
      color: frame,
    },
  ];
  const hand = kitPart('mecha-hand', handShapes, kernel);
  // With the right elbow bent forward, the hand's +y points down: the rifle hangs under the fist.
  // MR7: the rifle on its own (M2), held by the hand or stored on the back.
  const rifleShapes: MechaShape[] = [
    {
      id: 'grip',
      box: [
        [6, 10, -6],
        [20, 22, 6],
      ],
      color: dark,
    },
    {
      id: 'rifle',
      plane: 'xy',
      pts: [
        [-6, 20],
        [118, 20],
        [124, 30],
        [118, 42],
        [-6, 42],
      ],
      span: [-8, 8],
      color: dark,
    },
    {
      id: 'scope',
      box: [
        [36, 12, -5],
        [84, 20, 5],
      ],
      color: '#8a919c',
    },
    {
      id: 'magazine',
      box: [
        [52, 42, -6],
        [70, 66, 6],
      ],
      color: frame,
    },
    {
      id: 'barrel',
      box: [
        [120, 26, -4],
        [250, 34, 4],
      ],
      color: '#8a919c',
    },
    {
      id: 'muzzle',
      box: [
        [236, 24, -6],
        [256, 36, 6],
      ],
      color: red,
    },
  ];
  const handRifle = kitPart('mecha-hand-rifle', [...handShapes, ...rifleShapes], kernel);
  const rifle = kitPart('mecha-rifle', rifleShapes, kernel);
  // Leg parts hang down −z from their joint.
  const thigh = kitPart(
    'mecha-thigh',
    [
      {
        id: 'hip',
        box: [
          [-14, -14, -12],
          [14, 14, 12],
        ],
        color: frame,
      },
      {
        id: 'thigh-frame',
        box: [
          [-14, -16, -132],
          [14, 16, -8],
        ],
        color: frame,
      },
      {
        id: 'thigh',
        plane: 'yz',
        pts: [
          [-24, -16],
          [-22, -124],
          [20, -128],
          [22, -16],
        ],
        span: [-22, 22],
        color: white,
      },
    ],
    kernel,
  );
  const shin = kitPart(
    'mecha-shin',
    [
      {
        id: 'shin-frame',
        box: [
          [-14, -14, -140],
          [14, 14, 0],
        ],
        color: frame,
      },
      {
        id: 'shin',
        plane: 'yz',
        pts: [
          [-28, -4],
          [-24, -120],
          [-20, -134],
          [26, -136],
          [30, -60],
          [26, -2],
        ],
        span: [-24, 24],
        color: white,
      },
      {
        id: 'shin-flare',
        plane: 'xz',
        pts: [
          [-25, -70],
          [25, -70],
          [30, -132],
          [-30, -132],
        ],
        span: [-22, 22],
        color: white,
      },
      {
        id: 'knee',
        plane: 'yz',
        pts: [
          [-38, 14],
          [-40, -24],
          [-20, -44],
          [-8, 16],
        ],
        span: [-22, 22],
        color: blue,
      },
      {
        id: 'calf',
        box: [
          [-18, 22, -112],
          [18, 36, -30],
        ],
        color: blue,
      },
    ],
    kernel,
  );
  const foot = kitPart(
    'mecha-foot',
    [
      {
        id: 'ankle',
        box: [
          [-12, -12, -16],
          [12, 12, 8],
        ],
        color: frame,
      },
      {
        id: 'foot',
        plane: 'yz',
        pts: [
          [-64, -40],
          [40, -40],
          [34, -14],
          [-6, -4],
          [-50, -22],
        ],
        span: [-28, 28],
        color: white,
      },
      {
        id: 'toe',
        box: [
          [-26, -68, -40],
          [26, -46, -26],
        ],
        color: red,
      },
      {
        id: 'heel',
        box: [
          [-20, 26, -40],
          [20, 44, -22],
        ],
        color: blue,
      },
    ],
    kernel,
  );
  // A wing runs along +x from its hinge, its feathers fanned toward +y; it turns in its own plane.
  const wing = kitPart(
    'mecha-wing',
    [
      {
        id: 'root',
        box: [
          [-10, -14, -8],
          [50, 14, 8],
        ],
        color: frame,
      },
      {
        id: 'spar',
        plane: 'xy',
        pts: [
          [10, -12],
          [240, -8],
          [250, 2],
          [10, 10],
        ],
        span: [-7, 7],
        color: blue,
      },
      ...[10, 28, 46, 64, 82].map(
        (angle, i): MechaShape => ({
          id: `feather-${i + 1}`,
          plane: 'xy',
          pts: feather([44 + i * 14, 8 + i * 4], angle, [262, 240, 214, 184, 150][i]!, 34),
          span: [-4 + i * 0.6, -1 + i * 0.6],
          color: i % 2 ? '#cfd5de' : white,
        }),
      ),
    ],
    kernel,
  );
  const stand = kitPart(
    m2 ? 'mecha-stand-tall' : 'mecha-stand',
    [
      { id: 'base', plane: 'xy', pts: octagon(170), span: [0, 10], color: dark },
      { id: 'post', plane: 'xy', pts: octagon(9), span: [10, POST], color: '#8a919c' },
    ],
    kernel,
  );
  // A tail fin folds flat down the back of a calf and swings out to stand behind the leg.
  const fin = kitPart(
    'mecha-fin',
    [
      {
        id: 'fin',
        plane: 'yz',
        pts: [
          [0, 4],
          [14, 4],
          [10, -50],
          [2, -84],
        ],
        span: [-3, 3],
        color: red,
      },
    ],
    kernel,
  );
  // M2: the neck the head slides down on, and a tip that slides out along a wing's spar (on top
  // of it, 0.5 mm clear), reaching past the spar's end when out.
  const neck = kitPart(
    'mecha-neck',
    [
      {
        id: 'neck',
        box: [
          [-12, -12, 0],
          [12, 12, 20],
        ],
        color: frame,
      },
    ],
    kernel,
  );
  const wingTip = kitPart(
    'mecha-wing-tip',
    [
      {
        id: 'tip',
        plane: 'xy',
        pts: [
          [0, -7],
          [128, -5],
          [140, 0],
          [0, 5],
        ],
        span: [0, 3.5],
        color: yellow,
      },
    ],
    kernel,
  );
  const versions = [
    body,
    head,
    upper,
    fore,
    shield,
    hand,
    ...(m2 ? [] : [handRifle]),
    thigh,
    shin,
    foot,
    fin,
    wing,
    stand,
    ...(m2 ? [neck, wingTip, rifle] : []),
  ];
  const closure = new Map(versions.map((v) => [v.version.contentHash, v.version.content] as const));
  let doc = emptyCad(kernel);
  const part = (id: string, name: string, v: (typeof versions)[number]) =>
    fixturePart(id, name, v.version, v.bounds);
  const free = (id: string, partId: string) => fixtureComponent(id, partId);
  doc = applyCadOperation(doc, {
    type: 'insertComponents',
    parts: [
      part('p-body', 'Body', body),
      part('p-head', 'Head', head),
      part('p-upper', 'Upper arm', upper),
      part('p-fore', 'Forearm', fore),
      part('p-shield', 'Shield', shield),
      part('p-fin', 'Tail fin', fin),
      part('p-hand', 'Hand', hand),
      ...(m2 ? [] : [part('p-hand-rifle', 'Hand with rifle', handRifle)]),
      part('p-thigh', 'Thigh', thigh),
      part('p-shin', 'Shin', shin),
      part('p-foot', 'Foot', foot),
      part('p-wing', 'Wing', wing),
      part('p-stand', 'Stand', stand),
      ...(m2
        ? [
            part('p-neck', 'Neck', neck),
            part('p-wing-tip', 'Wing tip', wingTip),
            part('p-rifle', 'Rifle', rifle),
          ]
        : []),
    ],
    components: [
      fixtureComponent('c-stand', 'p-stand', [0, 0, 0]),
      free('c-torso', 'p-body'),
      free('c-head', 'p-head'),
      free('c-upper-r', 'p-upper'),
      free('c-fore-r', 'p-fore'),
      free('c-hand-r', m2 ? 'p-hand' : 'p-hand-rifle'),
      free('c-upper-l', 'p-upper'),
      free('c-fore-l', 'p-fore'),
      free('c-shield', 'p-shield'),
      free('c-hand-l', 'p-hand'),
      ...['r', 'l'].flatMap((s) => [
        free(`c-thigh-${s}`, 'p-thigh'),
        free(`c-shin-${s}`, 'p-shin'),
        free(`c-foot-${s}`, 'p-foot'),
        free(`c-fin-${s}`, 'p-fin'),
      ]),
      free('c-wing-l', 'p-wing'),
      free('c-wing-r', 'p-wing'),
      ...(m2
        ? [
            free('c-neck', 'p-neck'),
            free('c-wing-tip-l', 'p-wing-tip'),
            free('c-wing-tip-r', 'p-wing-tip'),
            free('c-rifle', 'p-rifle'),
          ]
        : []),
    ],
  });
  const names: Record<string, string> = {
    'c-stand': 'Stand',
    'c-torso': 'Body',
    'c-head': 'Head',
    'c-shield': 'Shield',
    'c-wing-l': 'Wing L',
    'c-wing-r': 'Wing R',
    'c-neck': 'Neck',
    'c-wing-tip-l': 'Wing tip L',
    'c-wing-tip-r': 'Wing tip R',
    'c-rifle': 'Rifle',
  };
  for (const c of doc.components) {
    const m = /^c-(upper|fore|hand|thigh|shin|foot|fin)-([rl])$/.exec(c.id);
    c.name =
      names[c.id] ??
      (m
        ? `${{ upper: 'Upper arm', fore: 'Forearm', hand: 'Hand', thigh: 'Thigh', shin: 'Shin', foot: 'Foot', fin: 'Tail fin' }[m[1]!]} ${m[2]!.toUpperCase()}`
        : c.id);
    // Every component but the stand is placed by its joint.
    if (c.id !== 'c-stand') c.placement = null;
  }
  const limit = (of: CadJointValueKey, min: number, max: number) => ({
    of,
    min: min * deg,
    max: max * deg,
  });
  const angle = (d = 0) => ({ angle: { literalRad: d * deg } });
  const hinge = (
    id: string,
    name: string,
    parent: string,
    at: [number, number, number],
    child: string,
    value: number,
    [min, max]: [number, number],
  ) => ({
    ...fixtureJoint(
      id,
      'revolute',
      connectorAt([parent], at, acrossX),
      child,
      connectorAt([], [0, 0, 0], acrossX),
      angle(value),
      [limit('angle', min, max)],
    ),
    name,
  });
  const arm = (s: 'r' | 'l') => {
    const sign = s === 'r' ? 1 : -1;
    // The left arm's frames are turned half round about z: its +x points out to the left.
    const out = s === 'r' ? undefined : rotZ(180);
    // The right elbow's frames are turned half round about x, so both elbows bend forward.
    const elbow: Quaternion = s === 'r' ? quat(0, 180) : [0, 0, 0, 1];
    return [
      {
        ...fixtureJoint(
          `j-shoulder-${s}`,
          'spherical',
          connectorAt(['c-torso'], [114 * sign, 0, 168], out),
          `c-upper-${s}`,
          fixtureConnector(),
          // M2: the same hanging pose written (∓90°, 90°, ∓90°), so that turning angle 2 alone
          // swings the arm forward and up about the body's x (its pauldron staying out).
          m2
            ? {
                angle: { literalRad: -90 * sign * deg },
                angle2: { literalRad: 90 * deg },
                angle3: { literalRad: -90 * sign * deg },
              }
            : {
                angle: { literalRad: 0 },
                angle2: { literalRad: 90 * deg },
                angle3: { literalRad: 0 },
              },
          [limit('angle2', -120, 120)],
        ),
        name: `Shoulder ${s.toUpperCase()}`,
      },
      {
        ...fixtureJoint(
          `j-elbow-${s}`,
          'revolute',
          connectorAt([`c-upper-${s}`], [112, 0, 0], elbow),
          `c-fore-${s}`,
          connectorAt([], [0, 0, 0], elbow),
          angle(s === 'r' ? 90 : 40),
          [limit('angle', 0, 150)],
        ),
        name: `Elbow ${s.toUpperCase()}`,
      },
      {
        ...fixtureJoint(
          `j-wrist-${s}`,
          'universal',
          connectorAt([`c-fore-${s}`], [96, 0, 0]),
          `c-hand-${s}`,
          fixtureConnector(),
          { angle: { literalRad: 0 }, angle2: { literalRad: 0 } },
        ),
        name: `Wrist ${s.toUpperCase()}`,
      },
    ];
  };
  const leg = (s: 'r' | 'l') => {
    const S = s.toUpperCase();
    const x = s === 'r' ? 40 : -40;
    return [
      hinge(`j-hip-${s}`, `Hip ${S}`, 'c-torso', [x, 0, 10], `c-thigh-${s}`, 0, [-90, 60]),
      ...(m2
        ? [
            {
              ...hinge(
                `j-knee-${s}`,
                `Knee ${S}`,
                `c-thigh-${s}`,
                [0, KP, -132],
                `c-shin-${s}`,
                0,
                [0, 170],
              ),
              child: {
                componentId: `c-shin-${s}`,
                connector: connectorAt([], [0, KP, 0], acrossX),
              },
            },
          ]
        : [
            hinge(
              `j-knee-${s}`,
              `Knee ${S}`,
              `c-thigh-${s}`,
              [0, 0, -132],
              `c-shin-${s}`,
              0,
              [-140, 0],
            ),
          ]),
      hinge(`j-ankle-${s}`, `Ankle ${S}`, `c-shin-${s}`, [0, 0, -140], `c-foot-${s}`, 0, [-45, 60]),
      {
        ...hinge(
          `j-fin-${s}`,
          `Tail fin ${S}`,
          `c-shin-${s}`,
          [0, 38, -36],
          `c-fin-${s}`,
          0,
          FIN_LIMIT,
        ),
        // The right fin follows the left one.
        ...(s === 'r'
          ? {
              values: {},
              couplings: [
                {
                  of: 'angle' as const,
                  from: { joint: 'j-fin-l', of: 'angle' as const },
                  ratio: 1,
                  offset: 0,
                },
              ],
            }
          : {}),
      },
    ];
  };
  doc.joints = [
    // The body turns on the stand's post about +x: 90° lays it level, face down, to fly.
    hinge('j-pitch', 'Pitch', 'c-stand', [0, 0, POST], 'c-torso', 0, [0, 90]),
    // M2: the neck slides down into the chest's bay (along the body's z), carrying the head.
    ...(m2
      ? [
          {
            ...fixtureJoint(
              'j-head-slide',
              'slider',
              connectorAt(['c-torso'], [0, 0, 186]),
              'c-neck',
              fixtureConnector(),
              { distance: { literalMm: 0 } },
              [{ of: 'distance' as const, min: -56, max: 0 }],
            ),
            name: 'Head slide',
          },
        ]
      : []),
    {
      ...fixtureJoint(
        'j-neck',
        'universal',
        m2 ? connectorAt(['c-neck'], [0, 0, 20]) : connectorAt(['c-torso'], [0, 0, 206]),
        'c-head',
        fixtureConnector(),
        { angle: { literalRad: 0 }, angle2: { literalRad: 0 } },
        [limit('angle', -90, 90), limit('angle2', -70, 30)],
      ),
      name: 'Neck',
    },
    ...arm('r'),
    ...arm('l'),
    hinge('j-shield', 'Shield', 'c-fore-l', [0, 0, 0], 'c-shield', 0, [-180, 180]),
    // MR7: the rifle is its own part, held in the right hand (one of its two mounts).
    ...(m2
      ? [
          {
            ...fixtureJoint(
              'j-rifle-hand',
              'fastened',
              connectorAt(['c-hand-r'], [0, 0, 0]),
              'c-rifle',
              fixtureConnector(),
            ),
            name: 'Rifle in hand',
          },
        ]
      : []),
    ...leg('r'),
    ...leg('l'),
    // The wings are hinged behind the pack about the robot's front-to-back axis: at 0° they
    // stand straight up, at 90° they reach out level to the sides, feathers trailing down (to
    // the tail, flying). The right wing's frame is the left one's mirror, so it follows the left
    // angle as it is.
    {
      ...fixtureJoint(
        'j-wing-l',
        'revolute',
        connectorAt(['c-torso'], [-32, 72, 176], [0.5, -0.5, 0.5, 0.5]),
        'c-wing-l',
        fixtureConnector(),
        angle(25),
        [limit('angle', 0, 90)],
      ),
      name: 'Wing L',
    },
    {
      ...fixtureJoint(
        'j-wing-r',
        'revolute',
        connectorAt(['c-torso'], [32, 72, 176], [-0.5, -0.5, -0.5, 0.5]),
        'c-wing-r',
        fixtureConnector(),
        {},
        [limit('angle', 0, 90)],
      ),
      name: 'Wing R',
      couplings: [{ of: 'angle', from: { joint: 'j-wing-l', of: 'angle' }, ratio: 1, offset: 0 }],
    },
    // M2: each tip slides along its spar (the wing's +x), the right one following the left.
    ...(m2
      ? (['l', 'r'] as const).map((s) => ({
          ...fixtureJoint(
            `j-wing-ext-${s}`,
            'slider',
            connectorAt([`c-wing-${s}`], [110, 0, 7.5], acrossX),
            `c-wing-tip-${s}`,
            connectorAt([], [0, 0, 0], acrossX),
            s === 'l' ? { distance: { literalMm: 0 } } : {},
            [{ of: 'distance' as const, min: 0, max: 120 }],
          ),
          name: `Wing tip ${s.toUpperCase()}`,
          ...(s === 'r'
            ? {
                couplings: [
                  {
                    of: 'distance' as const,
                    from: { joint: 'j-wing-ext-l', of: 'distance' as const },
                    ratio: 1,
                    offset: 0,
                  },
                ],
              }
            : {}),
        }))
      : []),
  ];
  // The pins at the joints are intended: allowed near their joints only.
  const allow = (id: string, a: string, b: string, joint: string, radiusMm: number) => ({
    id,
    a: [a],
    b: [b],
    region: { kind: 'joint-sphere' as const, joint, radiusMm },
  });
  doc.interferenceAllowances = [
    allow('allow-pitch', 'c-stand', 'c-torso', 'j-pitch', 40),
    m2
      ? allow('allow-neck', 'c-neck', 'c-head', 'j-neck', 25)
      : allow('allow-neck', 'c-torso', 'c-head', 'j-neck', 25),
    allow('allow-fin-r', 'c-shin-r', 'c-fin-r', 'j-fin-r', 20),
    allow('allow-fin-l', 'c-shin-l', 'c-fin-l', 'j-fin-l', 20),
    // MR7: the rifle's grip sits in the fist.
    ...(m2
      ? [
          allow('allow-rifle-hand', 'c-hand-r', 'c-rifle', 'j-rifle-hand', 30),
          // MR7d: a wrist bent right over presses the grip into the forearm's cuff.
          allow('allow-rifle-wrist', 'c-fore-r', 'c-rifle', 'j-wrist-r', 30),
        ]
      : []),
    ...(['r', 'l'] as const).flatMap((s) => [
      allow(`allow-elbow-${s}`, `c-upper-${s}`, `c-fore-${s}`, 'j-elbow-' + s, 30),
      // MR7d: a wrist bent right over (holding the rifle up) folds its plates.
      allow(`allow-wrist-${s}`, `c-fore-${s}`, `c-hand-${s}`, 'j-wrist-' + s, m2 ? 45 : 25),
      // MR7d: an arm swung in across the chest presses its shoulder ball into the body.
      ...(m2
        ? [allow(`allow-shoulder-${s}`, 'c-torso', `c-upper-${s}`, 'j-shoulder-' + s, 40)]
        : []),
      allow(`allow-hip-${s}`, 'c-torso', `c-thigh-${s}`, 'j-hip-' + s, 40),
      allow(`allow-knee-${s}`, `c-thigh-${s}`, `c-shin-${s}`, 'j-knee-' + s, m2 ? 70 : 36),
      allow(`allow-ankle-${s}`, `c-shin-${s}`, `c-foot-${s}`, 'j-ankle-' + s, 35),
    ]),
  ];
  settle(doc, closure);
  const rad = (d: number) => ({ literalRad: d * deg });
  // MR7: the hand-off pose "Stow": the right hand brings the rifle to its place on the back and
  // the left forearm the shield to the nose. Each second candidate is fastened to the body where
  // that pose puts the part, so switching there moves nothing.
  if (m2) {
    const stow = new Map(
      Object.entries(STOW).map(([id, v]) => [
        id,
        Object.fromEntries(Object.entries(v).map(([k, d]) => [k, k === 'distance' ? d : d * deg])),
      ]),
    );
    const solved = solveJoints(
      doc,
      parameterValues(doc),
      (h) => closure.get(h),
      () => undefined,
      () => true,
    );
    const poses = posesForJointValues(doc, solved, stow, parameterValues(doc));
    // A slider on the body along `along` (its connector's z), at distance 0 where Stow puts the
    // part: its child connector is the body's connector frame seen from the part.
    const slide = (
      id: string,
      name: string,
      child: string,
      along: Quaternion,
      type: 'slider' | 'planar',
      limits: CadJoint['limits'],
    ) => {
      const rel = composePoses(invertPose(poses['c-torso']!), poses[child]!);
      const frame = { translationMm: rel.translationMm, rotation: along };
      const own = composePoses(invertPose(rel), frame);
      const [x, y, z] = rel.translationMm as [number, number, number];
      const [u, v, w] = own.translationMm as [number, number, number];
      return {
        ...fixtureJoint(
          id,
          type,
          connectorAt(['c-torso'], [x, y, z], along),
          child,
          connectorAt([], [u, v, w], own.rotation as Quaternion),
          type === 'slider'
            ? { distance: { literalMm: 0 } }
            : { u: { literalMm: 0 }, v: { literalMm: 0 }, angle: { literalRad: 0 } },
          limits,
        ),
        name,
      };
    };
    doc.joints.push(
      // Down the back: the slider's z is the body's −z.
      slide('j-rifle-back', 'Rifle on back', 'c-rifle', quat(0, 180), 'slider', [
        { of: 'distance', min: 0, max: RIFLE_DOWN },
      ]),
      // Across the chest in the body's x–y plane (u along x, v along y), not turning.
      slide('j-shield-nose', 'Shield at nose', 'c-shield', [0, 0, 0, 1], 'planar', [
        { of: 'u', min: 0, max: SHIELD_IN },
        { of: 'v', min: 0, max: SHIELD_BACK },
        { of: 'angle', min: 0, max: 0 },
      ]),
    );
    doc.mounts = [
      {
        id: 'm-rifle',
        name: 'Rifle',
        component: 'c-rifle',
        joints: ['j-rifle-hand', 'j-rifle-back'],
        active: 'j-rifle-hand',
      },
      {
        id: 'm-shield',
        name: 'Shield',
        component: 'c-shield',
        joints: ['j-shield', 'j-shield-nose'],
        active: 'j-shield',
      },
    ];
    // The fist lets go of the grip where the back takes the rifle.
    doc.interferenceAllowances!.push(
      allow('allow-rifle-release', 'c-hand-r', 'c-rifle', 'j-rifle-back', 30),
    );
    settle(doc, closure);
  }
  const standValues = currentConfigurationValues(doc);
  const withDeg = (over: Record<string, Record<string, number>>) =>
    Object.fromEntries(
      Object.entries(over).map(([id, v]) => [
        id,
        Object.fromEntries(
          Object.entries(v).map(([k, d]) => [k, k === 'distance' ? { literalMm: d } : rad(d)]),
        ),
      ]),
    );
  const held = { 'm-rifle': 'j-rifle-hand', 'm-shield': 'j-shield' };
  const stowed = { 'm-rifle': 'j-rifle-back', 'm-shield': 'j-shield-nose' };
  const stowValues = { ...standValues, ...withDeg(STOW) };
  // MR7d: the parts let go of: the rifle down the back, the shield across to the nose's middle.
  const releaseValues = {
    ...stowValues,
    'j-rifle-back': { distance: { literalMm: RIFLE_DOWN } },
    'j-shield-nose': {
      u: { literalMm: SHIELD_IN },
      v: { literalMm: 0 },
      angle: { literalRad: 0 },
    },
  };
  const flight = {
    // MR7d: from the release, so only what Flight changes moves after it.
    ...(m2 ? releaseValues : standValues),
    'j-pitch': { angle: rad(90) },
    // M2: the head down in its bay, level; the wing tips out.
    'j-neck': { angle: rad(0), angle2: rad(m2 ? 0 : -20) },
    ...(m2
      ? {
          'j-head-slide': { distance: { literalMm: -56 } },
          'j-wing-ext-l': { distance: { literalMm: 120 } },
        }
      : {}),
    // M1: the arms reach forward. MR7d: they fold along the sides, the parts stowed.
    ...(m2
      ? withDeg(FLIGHT_ARMS)
      : Object.fromEntries(
          (['r', 'l'] as const).map((side) => [
            `j-shoulder-${side}`,
            { angle: rad(0), angle2: rad(SH2), angle3: rad(180) },
          ]),
        )),
    ...(m2 ? {} : { 'j-shield': { angle: rad(SHIELD) } }),
    'j-fin-l': { angle: rad(m2 ? 0 : FIN) },
    ...(m2 ? {} : { 'j-elbow-r': { angle: rad(0) }, 'j-elbow-l': { angle: rad(0) } }),
    'j-ankle-r': { angle: rad(m2 ? ANK : 30) },
    'j-ankle-l': { angle: rad(m2 ? ANK : 30) },
    ...(m2
      ? {
          'j-knee-r': { angle: rad(KNF) },
          'j-knee-l': { angle: rad(KNF) },
          // MR7d: the shield in against the chest once the arm is out from behind it.
          'j-shield-nose': {
            u: { literalMm: SHIELD_IN },
            v: { literalMm: SHIELD_BACK },
            angle: { literalRad: 0 },
          },
        }
      : {}),
    'j-wing-l': { angle: rad(85) },
  };
  doc.configurations = m2
    ? [
        { id: 'form-stand', name: 'Stand', values: standValues, mounts: held },
        // MR7d: the right wrist turned first, so the rifle clears the forearm as the arm rises.
        {
          id: 'form-ready',
          name: 'Ready',
          values: { ...standValues, ...withDeg({ 'j-wrist-r': READY_WRIST }) },
          mounts: held,
        },
        // MR7d: the hand-off pose, the parts still held.
        { id: 'form-stow', name: 'Stow', values: stowValues, mounts: held },
        { id: 'form-release', name: 'Release', values: releaseValues, mounts: stowed },
        { id: 'form-flight', name: 'Flight', values: flight, mounts: stowed },
      ]
    : [
        { id: 'form-stand', name: 'Stand', values: standValues },
        { id: 'form-flight', name: 'Flight', values: flight },
      ];
  assertCad(doc);
  return { versions, closure, assembly: doc, hash: cadContentHash(doc) };
}

/**
 * M1 interference cases (docs/cad/mecha-design.md, MR3 (c)–(e)) on a see-through torso:
 * (c) a back pack whose part has two separate solids, the small one left inside the torso;
 * (d) an arm pinned 10 mm into the torso at its shoulder, allowed in a 30 mm sphere there, turned
 * so it also cuts into the torso away from the shoulder; (e) a slender rod hinged at the top of
 * the torso, allowed in a 10 mm sphere there, running 100 mm down inside it.
 */
export function m1InterferenceCases(
  kernel: Pick<CadKernelProfile, 'id' | 'buildHash'> = fixtureKernel,
) {
  const torso = boxPart(
    'mecha-torso-clear',
    [
      {
        id: 'torso',
        box: [
          [-60, -40, 0],
          [60, 40, 160],
        ],
        color: '#9fb4cc',
        opacity: 0.35,
      },
    ],
    kernel,
  );
  const pack = boxPart(
    'mecha-pack',
    [
      {
        id: 'pack',
        box: [
          [-25, -30, 0],
          [25, 0, 60],
        ],
        color: '#2f6fd6',
      },
      {
        id: 'stray',
        box: [
          [-8, 20, 10],
          [8, 36, 26],
        ],
        color: '#c23b3b',
      },
    ],
    kernel,
  );
  const arm = boxPart(
    'mecha-arm-pinned',
    [
      {
        id: 'arm',
        box: [
          [-10, -15, -15],
          [100, 15, 15],
        ],
        color: '#2f6fd6',
      },
    ],
    kernel,
  );
  const rod = boxPart(
    'mecha-rod',
    [
      {
        id: 'rod',
        box: [
          [-2, -2, -105],
          [2, 2, -5],
        ],
        color: '#c23b3b',
      },
    ],
    kernel,
  );
  const versions = [torso, pack, arm, rod];
  const closure = new Map(versions.map((v) => [v.version.contentHash, v.version.content] as const));
  const part = (id: string, name: string, v: (typeof versions)[number]) =>
    fixturePart(id, name, v.version, v.bounds);
  let doc = emptyCad(kernel);
  doc = applyCadOperation(doc, {
    type: 'insertComponents',
    parts: [
      part('p-torso', 'Torso', torso),
      part('p-pack', 'Pack', pack),
      part('p-arm', 'Arm', arm),
      part('p-rod', 'Rod', rod),
    ],
    components: [
      { ...fixtureComponent('c-torso', 'p-torso'), name: 'Torso' },
      { ...fixtureComponent('c-pack', 'p-pack', [0, -40, 60]), name: 'Pack (c)' },
      { ...fixtureComponent('c-arm', 'p-arm'), name: 'Arm (d)' },
      { ...fixtureComponent('c-rod', 'p-rod'), name: 'Rod (e)' },
    ],
  });
  for (const c of doc.components) if (c.id === 'c-arm' || c.id === 'c-rod') c.placement = null;
  doc.joints = [
    {
      ...fixtureJoint(
        'j-shoulder',
        'revolute',
        connectorAt(['c-torso'], [60, 0, 120]),
        'c-arm',
        fixtureConnector(),
        { angle: { literalRad: 160 * deg } },
      ),
      name: 'Shoulder',
    },
    {
      ...fixtureJoint(
        'j-rod',
        'revolute',
        connectorAt(['c-torso'], [0, 0, 160]),
        'c-rod',
        fixtureConnector(),
        { angle: { literalRad: 0 } },
      ),
      name: 'Rod hinge',
    },
  ];
  doc.interferenceAllowances = [
    {
      id: 'allow-shoulder',
      a: ['c-torso'],
      b: ['c-arm'],
      region: { kind: 'joint-sphere', joint: 'j-shoulder', radiusMm: 30 },
    },
    {
      id: 'allow-rod',
      a: ['c-torso'],
      b: ['c-rod'],
      region: { kind: 'joint-sphere', joint: 'j-rod', radiusMm: 10 },
    },
  ];
  settle(doc, closure);
  assertCad(doc);
  return { versions, closure, assembly: doc, hash: cadContentHash(doc) };
}

/**
 * MR6: how TR-01 transforms from Stand to Flight (the reverse plays it backwards): groups of
 * joints, each moving from its start for its length (seconds), linearly. The character's
 * transform panel makes the same keys from these groups. MR7d: in four steps through the forms
 * Ready, Stow and Release; the rifle and shield switch to their places on the body at the start
 * of Stow → Release (at its end going back), where both places hold them where the hands do.
 */
export const tr01Transform = Object.freeze({
  stages: [
    {
      from: 'Stand',
      to: 'Ready',
      seconds: 0.6,
      groups: [{ name: 'Wrist', joints: ['j-wrist-r'], start: 0, length: 0.6 }],
    },
    {
      from: 'Ready',
      to: 'Stow',
      seconds: 1.6,
      groups: [
        { name: 'Head', joints: ['j-head-slide'], start: 0, length: 0.6 },
        { name: 'Wings', joints: ['j-wing-l'], start: 0, length: 0.8 },
        {
          name: 'Arms',
          joints: [
            'j-shoulder-r',
            'j-shoulder-l',
            'j-elbow-r',
            'j-elbow-l',
            'j-wrist-r',
            'j-shield',
          ],
          start: 0.6,
          length: 1,
        },
      ],
    },
    {
      from: 'Stow',
      to: 'Release',
      seconds: 0.6,
      groups: [{ name: 'Stow', joints: ['j-rifle-back', 'j-shield-nose'], start: 0, length: 0.6 }],
    },
    {
      from: 'Release',
      to: 'Flight',
      seconds: 2.2,
      groups: [
        {
          name: 'Legs',
          joints: ['j-knee-r', 'j-knee-l', 'j-ankle-r', 'j-ankle-l', 'j-fin-l'],
          start: 0,
          length: 0.8,
        },
        {
          name: 'Arms',
          joints: ['j-shoulder-r', 'j-shoulder-l', 'j-elbow-r', 'j-elbow-l'],
          start: 0,
          length: 0.8,
        },
        { name: 'Shield', joints: ['j-shield-nose'], start: 0.8, length: 0.4 },
        { name: 'Pitch', joints: ['j-pitch'], start: 1, length: 1.2 },
        { name: 'Wing tips', joints: ['j-wing-ext-l'], start: 1.4, length: 0.8 },
      ],
    },
  ],
});
