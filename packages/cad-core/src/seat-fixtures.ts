/**
 * F59 (CR6f, docs/cad/car-design.md, CR6の分け方): a car seat as an R2b assembly. x forward, y
 * across, z up from the floor; the seat stands at its rearmost slide and its back upright.
 *
 * - Rails (this document's own bodies, fixed): two 600 × 30 × 25 mm steel bars.
 * - Seat frame (part, a slider on the rails, 0–240 mm forward): two 3 mm side plates and a cross
 *   tube (a 12 mm circle swept along a line), one solid.
 * - Seat pan (part, fastened to the frame): a tray shelled 2.5 mm with its top open.
 * - Cushion (part, fastened to the frame): urethane in the pan, two stitch grooves on top, leather.
 * - Back (part, a revolute on the frame about a hinge across the seat, −10° to +40° reclined):
 *   urethane with two stitch grooves on its front, fabric.
 * - Back shell (part, fastened to the back): a tray shelled 2.5 mm, open toward the back's foam.
 */
import { cadContentHash, applyCadOperation, type CadNewBody } from './operations';
import { faceRef, fixtureKernel } from './fixtures';
import type { CadJoint } from './joints';
import { presetLook } from './lamp-fixtures';
import { bodyPartContent } from './make-part';
import {
  emptyCad,
  identityQuaternion,
  mm,
  position,
  type CadAppearance,
  type CadDocument,
  type CadFeature,
  type CadKernelProfile,
  type Quaternion,
} from './model';
import type { CadSketch } from './sketch';

type Box = { at: [number, number, number]; size: [number, number, number] };
/** The seat's boxes (mm): their minimum corners and sizes. */
export const f59Boxes = {
  railLeft: { at: [-150, -215, 0], size: [600, 30, 25] },
  railRight: { at: [-150, 185, 0], size: [600, 30, 25] },
  plateLeft: { at: [0, -203, 25], size: [450, 3, 80] },
  plateRight: { at: [0, 200, 25], size: [450, 3, 80] },
  pan: { at: [10, -190, 105], size: [440, 380, 50] },
  cushion: { at: [12.5, -187.5, 107.5], size: [435, 375, 120] },
  back: { at: [-90, -200, 160], size: [100, 400, 560] },
  backShell: { at: [-130, -200, 160], size: [40, 400, 560] },
} satisfies Record<string, Box>;
/** The slide (forward, mm) and recline (rad, positive leans the back rearward) ranges. */
export const f59Ranges = {
  slide: [0, 240] as [number, number],
  recline: [(-10 * Math.PI) / 180, (40 * Math.PI) / 180] as [number, number],
};
/** The back's hinge: across the seat (along y), behind the cushion. */
export const f59Hinge: [number, number, number] = [-40, 0, 180];

/**
 * CR7d: F59's low version for F63 (a bucket seat, the cushion's top 100 mm lower): side plates
 * 30 mm tall instead of 80, the pan and back 50 mm lower, the cushion 70 mm thick instead of 120.
 * F59 itself is unchanged (B3's seat sample).
 */
export const f59LowBoxes = {
  ...f59Boxes,
  plateLeft: { at: [0, -203, 25], size: [450, 3, 30] },
  plateRight: { at: [0, 200, 25], size: [450, 3, 30] },
  pan: { at: [10, -190, 55], size: [440, 380, 50] },
  cushion: { at: [12.5, -187.5, 57.5], size: [435, 375, 70] },
  back: { at: [-90, -200, 110], size: [100, 400, 560] },
  backShell: { at: [-130, -200, 110], size: [40, 400, 560] },
} satisfies Record<string, Box>;
export const f59LowHinge: [number, number, number] = [-40, 0, 130];
/**
 * CR7d: the low seat's H-point, in the cushion's (and the frame's) coordinates: where an
 * occupant's hip joint sits, 122.5 mm above the cushion's top (z 127.5) and 120 mm in front of
 * the back (x 10).
 */
export const f59LowHPoint: [number, number, number] = [130, 0, 250];

/** The seat's dimensions: F59's, or its low version's. */
const variants = {
  standard: { boxes: f59Boxes, hinge: f59Hinge, tubeZ: 65, artifact: 'seat' },
  low: { boxes: f59LowBoxes, hinge: f59LowHinge, tubeZ: 40, artifact: 'seat-low' },
};
export type F59Variant = keyof typeof variants;

const XZ: Quaternion = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
/** z along +x (a quarter turn about y): a slider moves the seat forward. */
const zForward: Quaternion = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
/** z along −y (a quarter turn about x): a positive angle leans the back's top rearward. */
const zAcross: Quaternion = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
/** u along −z, v along y, normal along +x: a sketch in front of the back. */
const YZ: Quaternion = [0, Math.SQRT1_2, 0, Math.SQRT1_2];

const steel = presetLook('steel');
const black: CadAppearance = { ...presetLook('plastic-matte'), color: '#1d1f22' };

function box(id: string, name: string, b: Box): CadFeature {
  return {
    id,
    name,
    type: 'box',
    inputFeatureIds: [],
    args: {
      size: [mm(b.size[0]), mm(b.size[1]), mm(b.size[2])],
      origin: position(...b.at),
      orientation: identityQuaternion(),
    },
  };
}
const newBody = (id: string, name: string, source: string, look: CadAppearance): CadNewBody => ({
  id,
  name,
  sourceFeatureId: source,
  placementFeatureId: `${id}-placement`,
  appearance: look,
});
const point = (id: string) => ({ type: 'point' as const, id });
/** Lines (each its own chain) on a sketch plane. */
function lines(
  id: string,
  name: string,
  plane: CadSketch['plane'],
  segments: [[number, number], [number, number]][],
): CadSketch {
  const solved: Record<string, [number, number]> = {};
  const entities: CadSketch['entities'] = [];
  segments.forEach(([a, b], k) => {
    solved[`${id}-a${k}`] = a;
    solved[`${id}-b${k}`] = b;
    entities.push(point(`${id}-a${k}`), point(`${id}-b${k}`), {
      type: 'line',
      id: `${id}-l${k}`,
      start: `${id}-a${k}`,
      end: `${id}-b${k}`,
    });
  });
  return { id, name, plane, entities, constraints: [], solved };
}

/** The seat before any part is made: all its bodies in this document. */
export function f59SeatBodies(
  kernel: Pick<CadKernelProfile, 'id' | 'buildHash'> = fixtureKernel,
  variant: F59Variant = 'standard',
): CadDocument {
  const { boxes: B, tubeZ } = variants[variant];
  // The back's stitches run from 40 mm above its bottom to 40 mm below its top.
  const [back0, back1] = [B.back.at[2] + 40, B.back.at[2] + B.back.size[2] - 40];
  const tubeY = B.plateLeft.at[1];
  const sketches: CadSketch[] = [
    // The cross tube: a 12 mm circle on the left plate's face, swept across along y.
    {
      id: 'tube-section',
      name: 'Tube section',
      plane: { origin: position(0, tubeY, 0), orientation: XZ },
      entities: [point('tc'), { type: 'circle', id: 'tube-circle', center: 'tc' }],
      constraints: [],
      solved: { tc: [40, tubeZ], 'tube-circle': [12, 0] },
    },
    lines(
      'tube-path',
      'Tube path',
      { origin: position(0, 0, tubeZ), orientation: identityQuaternion() },
      [
        [
          [40, tubeY],
          [40, -tubeY],
        ],
      ],
    ),
    lines(
      'cushion-stitch',
      'Cushion stitch',
      { origin: position(0, 0, 400), orientation: identityQuaternion() },
      [
        [
          [40, -80],
          [420, -80],
        ],
        [
          [40, 80],
          [420, 80],
        ],
      ],
    ),
    lines('back-stitch', 'Back stitch', { origin: position(200, 0, 0), orientation: YZ }, [
      [
        [-back0, -80],
        [-back1, -80],
      ],
      [
        [-back0, 80],
        [-back1, 80],
      ],
    ]),
  ];
  let doc = applyCadOperation(emptyCad(kernel), {
    type: 'insertFeatures',
    parameters: [],
    sketches,
    features: [
      box('rail-left', 'Left rail', B.railLeft),
      box('rail-right', 'Right rail', B.railRight),
      box('plate-left', 'Left side plate', B.plateLeft),
      box('plate-right', 'Right side plate', B.plateRight),
      {
        id: 'cross-tube',
        name: 'Cross tube',
        type: 'sweep',
        inputFeatureIds: [],
        args: {
          profile: { sketchId: 'tube-section', region: { outer: ['tube-circle'], holes: [] } },
          path: { sketchId: 'tube-path', elements: ['tube-path-l0'] },
          orientation: 'fixed',
        },
      },
      {
        id: 'frame',
        name: 'Seat frame',
        type: 'boolean',
        inputFeatureIds: ['plate-left', 'plate-right', 'cross-tube'],
        args: { mode: 'union' },
      },
      box('pan-box', 'Seat pan', B.pan),
      box('cushion-box', 'Cushion', B.cushion),
      box('back-box', 'Back', B.back),
      box('back-shell-box', 'Back shell', B.backShell),
    ],
    bodies: [
      newBody('rail-left-body', 'Left rail', 'rail-left', steel),
      newBody('rail-right-body', 'Right rail', 'rail-right', steel),
      newBody('frame-body', 'Seat frame', 'frame', steel),
      newBody('pan', 'Seat pan', 'pan-box', black),
      newBody('cushion', 'Cushion', 'cushion-box', presetLook('leather')),
      newBody('back', 'Back', 'back-box', presetLook('fabric')),
      newBody('back-shell', 'Back shell', 'back-shell-box', black),
    ],
  });
  const shell = (bodyId: string, b: Box, open: '+z' | '+x') => {
    const on = `${bodyId}-placement`;
    const [x, y, z] = b.at;
    const [dx, dy, dz] = b.size;
    const face =
      open === '+z'
        ? faceRef(on, ['+z'], [x + dx / 2, y + dy / 2, z + dz], dx * dy)
        : faceRef(on, ['+x'], [x + dx, y + dy / 2, z + dz / 2], dy * dz);
    doc = applyCadOperation(doc, {
      type: 'detailBody',
      bodyId,
      placementFeatureId: `${bodyId}-wall-placement`,
      feature: {
        id: `${bodyId}-wall`,
        name: `${doc.bodies.find((x) => x.id === bodyId)!.name} wall`,
        type: 'shell',
        inputFeatureIds: [on],
        args: { openFaces: [face], thickness: mm(2.5), side: 'inside' },
      },
    });
  };
  shell('pan', B.pan, '+z');
  shell('back-shell', B.backShell, '+x');
  // The stitch grooves (CR6d), one per line.
  const groove = (bodyId: string, sketchId: string, k: number) => {
    const source = doc.bodies.find((x) => x.id === bodyId)!.resultFeatureId;
    doc = applyCadOperation(doc, {
      type: 'detailBody',
      bodyId,
      placementFeatureId: `${bodyId}-stitch-${k}-placement`,
      feature: {
        id: `${bodyId}-stitch-${k}`,
        name: `Stitch ${k + 1}`,
        type: 'groove',
        inputFeatureIds: [source],
        args: { tool: { sketchId, elements: [`${sketchId}-l${k}`] }, radius: mm(4) },
      },
    });
  };
  for (const k of [0, 1]) groove('cushion', 'cushion-stitch', k);
  for (const k of [0, 1]) groove('back', 'back-stitch', k);
  return doc;
}

/** Bounds of a box (rounded out by 1 mm), for a part drawn before it evaluates. */
const boundsOf = (b: Box): [[number, number, number], [number, number, number]] => [
  b.at.map((v) => v - 1) as [number, number, number],
  b.at.map((v, i) => v + b.size[i]! + 1) as [number, number, number],
];

/**
 * F59: the seat's moving bodies made parts (versions `seat-<name>` v1, placed where they were
 * made) and joined: the frame slides on the rails, the pan and cushion are fastened to the
 * frame, the back turns on the frame's hinge and the back shell is fastened to the back.
 */
export function f59Seat(
  kernel: Pick<CadKernelProfile, 'id' | 'buildHash'> = fixtureKernel,
  variant: F59Variant = 'standard',
) {
  let doc = f59SeatBodies(kernel, variant);
  const closure = new Map<string, CadDocument>();
  const { boxes: B, hinge, artifact } = variants[variant];
  const parts = [
    {
      body: 'frame-body',
      name: 'frame',
      bounds: boundsOf({ at: [0, -203, 25], size: [450, 406, B.plateLeft.size[2]] }),
    },
    { body: 'pan', name: 'pan', bounds: boundsOf(B.pan) },
    { body: 'cushion', name: 'cushion', bounds: boundsOf(B.cushion) },
    { body: 'back', name: 'back', bounds: boundsOf(B.back) },
    { body: 'back-shell', name: 'back-shell', bounds: boundsOf(B.backShell) },
  ];
  for (const p of parts) {
    const content = bodyPartContent(doc, p.body);
    const hash = cadContentHash(content);
    closure.set(hash, content);
    const body = doc.bodies.find((b) => b.id === p.body)!;
    doc = applyCadOperation(doc, {
      type: 'makePart',
      bodyId: body.id,
      part: {
        id: `part-${p.name}`,
        name: body.name,
        source: {
          kind: 'version',
          artifactId: `${artifact}-${p.name}`,
          versionId: 'v1',
          contentHash: hash,
        },
        hint: { boundsMm: p.bounds },
      },
      component: {
        id: `c-${p.name}`,
        name: `${body.name} 1`,
        partId: `part-${p.name}`,
        placement: { translation: position(0, 0, 0), rotation: identityQuaternion() },
        bom: 'include',
      },
    });
  }
  const at = (path: string[], translation: [number, number, number], rotation: Quaternion) => ({
    componentPath: path,
    ref: { origin: true as const },
    flip: false,
    offset: { translation: position(...translation), rotation },
  });
  const joint = (
    id: string,
    name: string,
    type: CadJoint['type'],
    parentPath: string[],
    child: string,
    frame: [[number, number, number], Quaternion],
    values: CadJoint['values'] = {},
    limits: CadJoint['limits'] = [],
  ): CadJoint => ({
    id,
    name,
    type,
    parent: at(parentPath, ...frame),
    child: { componentId: child, connector: at([], ...frame) },
    values,
    limits,
  });
  const fixed: [[number, number, number], Quaternion] = [[0, 0, 0], identityQuaternion()];
  const joints: CadJoint[] = [
    joint(
      'j-slide',
      'Seat slide',
      'slider',
      [],
      'c-frame',
      [[0, 0, 0], zForward],
      {
        distance: mm(0),
      },
      [{ of: 'distance', min: f59Ranges.slide[0], max: f59Ranges.slide[1] }],
    ),
    joint('j-pan', 'Pan on frame', 'fastened', ['c-frame'], 'c-pan', fixed),
    joint('j-cushion', 'Cushion on frame', 'fastened', ['c-frame'], 'c-cushion', fixed),
    joint(
      'j-recline',
      'Recline',
      'revolute',
      ['c-frame'],
      'c-back',
      [hinge, zAcross],
      {
        angle: { literalRad: 0 },
      },
      [{ of: 'angle', min: f59Ranges.recline[0], max: f59Ranges.recline[1] }],
    ),
    joint('j-back-shell', 'Back shell on back', 'fastened', ['c-back'], 'c-back-shell', fixed),
  ];
  for (const j of joints) doc = applyCadOperation(doc, { type: 'insertJoint', joint: j });
  return { assembly: doc, closure };
}
