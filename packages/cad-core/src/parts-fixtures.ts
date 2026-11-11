/**
 * F60–F62 (CR6g, docs/cad/car-design.md, CR6の分け方): a road wheel with its tyre, a door mirror
 * and a steering wheel, each its own CAD document (placing them on the car is CR7).
 *
 * - F60 wheel (`f60Wheel`): axis along y through the origin. The rim is its section (a 15 in
 *   barrel with two flanges) revolved, joined to a hub disc; five spokes (a circular pattern,
 *   union) and five lug holes (a circular pattern, cut). The tyre (195/50 R15) is its section
 *   revolved, its tread cut by 60 slots across it (a circular pattern, cut). Aluminium and rubber.
 * - F61 door mirror (`f61Mirror`): a housing lofted through three closed-spline sections from a
 *   flat mounting face at x = 0 out to its head at x = 160 (smooth loft, black plastic), a chrome
 *   glass in front of the head and a flat mounting plate.
 * - F62 steering wheel (`f62Steering`): axis along z. A 28 mm rim revolved at radius 185 mm
 *   (leather), a hub, and three spokes lofted from a round section at the hub to a flat one at the
 *   rim (left, bottom and right: a circular pattern, union).
 */
import { fixtureKernel } from './fixtures';
import { presetLook } from './lamp-fixtures';
import {
  emptyCad,
  identityQuaternion,
  mm,
  position,
  type CadAppearance,
  type CadDocument,
  type CadFeature,
  type CadKernelProfile,
  type CadPatternLayout,
  type Quaternion,
} from './model';
import { applyCadOperation, type CadNewBody } from './operations';
import type { CadSketch } from './sketch';

type Kernel = Pick<CadKernelProfile, 'id' | 'buildHash'>;
const point = (id: string) => ({ type: 'point' as const, id });
const newBody = (id: string, name: string, source: string, look: CadAppearance): CadNewBody => ({
  id,
  name,
  sourceFeatureId: source,
  placementFeatureId: `${id}-placement`,
  appearance: look,
});
/** z along y (a quarter turn about x): a cylinder standing on the wheel's axis. */
const zAlongY: Quaternion = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
/** u along −z, v along y, normal along +x. */
const YZ: Quaternion = [0, Math.SQRT1_2, 0, Math.SQRT1_2];

/** A closed polygon (lines, corners in order) on a sketch plane, as one region. */
function polygon(
  id: string,
  name: string,
  plane: CadSketch['plane'],
  corners: [number, number][],
): CadSketch {
  const solved: Record<string, [number, number]> = {};
  const entities: CadSketch['entities'] = [];
  corners.forEach((c, k) => {
    solved[`${id}-p${k}`] = c;
    entities.push(point(`${id}-p${k}`));
  });
  corners.forEach((_, k) =>
    entities.push({
      type: 'line',
      id: `${id}-l${k}`,
      start: `${id}-p${k}`,
      end: `${id}-p${(k + 1) % corners.length}`,
    }),
  );
  return { id, name, plane, entities, constraints: [], solved };
}
const polygonRegion = (s: CadSketch) => ({
  sketchId: s.id,
  region: {
    outer: s.entities.filter((e) => e.type === 'line').map((e) => e.id),
    holes: [],
  },
});
/** A closed cubic spline through 8 poles round an ellipse of half-widths a (u) and b (v). */
function ellipse(
  id: string,
  name: string,
  plane: CadSketch['plane'],
  a: number,
  b: number,
  centre: [number, number] = [0, 0],
): CadSketch {
  const solved: Record<string, [number, number]> = {};
  const poles = Array.from({ length: 8 }, (_, k) => {
    const t = (2 * Math.PI * k) / 8;
    // Poles outside the curve so the spline passes near the ellipse (a cubic's poles lie wider).
    solved[`${id}-q${k}`] = [
      centre[0] + 1.08 * a * Math.cos(t),
      centre[1] + 1.08 * b * Math.sin(t),
    ];
    return `${id}-q${k}`;
  });
  return {
    id,
    name,
    plane,
    entities: [
      ...poles.map(point),
      { type: 'spline', id: `${id}-s`, poles, degree: 3, closed: true },
    ],
    constraints: [],
    solved,
  };
}
const region = (s: CadSketch) => ({ sketchId: s.id, region: { outer: [`${s.id}-s`], holes: [] } });

function box(
  id: string,
  name: string,
  size: [number, number, number],
  at: [number, number, number],
): CadFeature {
  return {
    id,
    name,
    type: 'box',
    inputFeatureIds: [],
    args: {
      size: [mm(size[0]), mm(size[1]), mm(size[2])],
      origin: position(...at),
      orientation: identityQuaternion(),
    },
  };
}
const turn = (id: string, name: string, section: ReturnType<typeof polygonRegion>): CadFeature => ({
  id,
  name,
  type: 'revolve',
  inputFeatureIds: [],
  args: {
    ...section,
    axisOrigin: [mm(0), mm(0)],
    axisDirection: [0, 1],
    angle: { literalRad: 2 * Math.PI },
  },
});
const around = (
  axis: [number, number, number],
  count: number,
  stepDeg: number,
): CadPatternLayout => ({
  type: 'circular',
  axisOrigin: position(0, 0, 0),
  axisDirection: axis,
  count: { literal: count },
  angle: { literalRad: (stepDeg * Math.PI) / 180 },
});

/** F60's sizes (mm). */
export const f60Sizes = {
  /** The rim's section (radius, y): barrel 180–188, flanges to 200, 178 wide. */
  rim: [
    [180, -89],
    [200, -89],
    [200, -82],
    [188, -76],
    [188, 76],
    [200, 82],
    [200, 89],
    [180, 89],
  ] as [number, number][],
  hub: { radius: 75, width: 20, y: 30 },
  spoke: { size: [125, 15, 30] as [number, number, number], from: 60, count: 5 },
  lug: { radius: 7, pitch: 50, count: 5 },
  /** The tyre's section (radius, y): bead at 190, tread at 288, 195 wide. */
  tyre: [
    [190, -97.5],
    [250, -97.5],
    [275, -90],
    [288, -70],
    [288, 70],
    [275, 90],
    [250, 97.5],
    [190, 97.5],
  ] as [number, number][],
  tread: { slots: 60, width: 6, depth: 8, across: 150 },
};

export function f60Wheel(kernel: Kernel = fixtureKernel): CadDocument {
  const s = f60Sizes;
  const xy = { origin: position(0, 0, 0), orientation: identityQuaternion() };
  const rim = polygon('rim-section', 'Rim section', xy, s.rim);
  const tyre = polygon('tyre-section', 'Tyre section', xy, s.tyre);
  const [sx, sy, sz] = s.spoke.size;
  let doc = applyCadOperation(emptyCad(kernel), {
    type: 'insertFeatures',
    parameters: [],
    sketches: [rim, tyre],
    features: [
      turn('rim-turn', 'Rim', polygonRegion(rim)),
      {
        id: 'hub',
        name: 'Hub',
        type: 'cylinder',
        inputFeatureIds: [],
        args: {
          radius: mm(s.hub.radius),
          height: mm(s.hub.width),
          origin: position(0, s.hub.y, 0),
          orientation: zAlongY,
        },
      },
      {
        id: 'rim-hub',
        name: 'Wheel',
        type: 'boolean',
        inputFeatureIds: ['rim-turn', 'hub'],
        args: { mode: 'union' },
      },
      box('spoke', 'Spoke', [sx, sy, sz], [s.spoke.from, s.hub.y, -sz / 2]),
      {
        id: 'lug',
        name: 'Lug hole',
        type: 'cylinder',
        inputFeatureIds: [],
        args: {
          radius: mm(s.lug.radius),
          height: mm(s.hub.width + 2),
          origin: position(s.lug.pitch, s.hub.y - 1, 0),
          orientation: zAlongY,
        },
      },
      turn('tyre-turn', 'Tyre', polygonRegion(tyre)),
      box(
        'slot',
        'Tread slot',
        [s.tread.depth + 10, s.tread.across, s.tread.width],
        [288 - s.tread.depth, -s.tread.across / 2, -s.tread.width / 2],
      ),
    ],
    bodies: [
      newBody('wheel', 'Wheel', 'rim-hub', presetLook('aluminium')),
      newBody('spoke-body', 'Spoke', 'spoke', presetLook('aluminium')),
      newBody('lug-body', 'Lug hole', 'lug', presetLook('aluminium')),
      newBody('tyre', 'Tyre', 'tyre-turn', presetLook('rubber')),
      newBody('slot-body', 'Tread slot', 'slot', presetLook('rubber')),
    ],
  });
  const pattern = (
    target: string,
    tool: string,
    mode: 'union' | 'cut',
    id: string,
    layout: CadPatternLayout,
  ) => {
    doc = applyCadOperation(doc, {
      type: 'patternBodies',
      targetId: target,
      toolId: tool,
      mode,
      patternFeatureId: id,
      placementFeatureId: `${id}-placement`,
      layout,
    });
  };
  pattern(
    'wheel',
    'spoke-body',
    'union',
    'spokes',
    around([0, 1, 0], s.spoke.count, 360 / s.spoke.count),
  );
  pattern('wheel', 'lug-body', 'cut', 'lugs', around([0, 1, 0], s.lug.count, 360 / s.lug.count));
  pattern(
    'tyre',
    'slot-body',
    'cut',
    'tread',
    around([0, 1, 0], s.tread.slots, 360 / s.tread.slots),
  );
  return doc;
}

/** F61's sections: x of each, and the half-widths across (y) and up (z). */
export const f61Sections = [
  { x: 0, y: 40, z: 30 },
  { x: 80, y: 70, z: 55 },
  { x: 150, y: 110, z: 70 },
];

export function f61Mirror(kernel: Kernel = fixtureKernel): CadDocument {
  // On YZ planes u runs along −z and v along y: a = the half-height, b = the half-width.
  const sections = f61Sections.map((s, k) =>
    ellipse(
      `housing-${k}`,
      `Housing section ${k + 1}`,
      { origin: position(s.x, 0, 0), orientation: YZ },
      s.z,
      s.y,
    ),
  );
  const head = f61Sections[2]!;
  const glass = ellipse(
    'glass-outline',
    'Glass outline',
    { origin: position(head.x, 0, 0), orientation: YZ },
    head.z - 6,
    head.y - 6,
  );
  return applyCadOperation(emptyCad(kernel), {
    type: 'insertFeatures',
    parameters: [],
    sketches: [...sections, glass],
    features: [
      {
        id: 'housing-loft',
        name: 'Housing',
        type: 'loft',
        inputFeatureIds: [],
        args: { sections: sections.map(region), ruled: false },
      },
      {
        id: 'glass',
        name: 'Glass',
        type: 'extrude',
        inputFeatureIds: [],
        args: { ...region(glass), distance: mm(4), direction: 1 },
      },
      box('mount', 'Mount plate', [6, 100, 80], [-6, -50, -40]),
    ],
    bodies: [
      newBody('housing', 'Housing', 'housing-loft', {
        ...presetLook('plastic-matte'),
        color: '#1d1f22',
      }),
      newBody('glass-body', 'Glass', 'glass', presetLook('chrome')),
      newBody('mount-body', 'Mount plate', 'mount', presetLook('plastic-matte')),
    ],
  });
}

/** F62's sizes (mm). */
export const f62Sizes = { rim: { radius: 185, tube: 14 }, hub: { radius: 40, height: 50 } };

export function f62Steering(kernel: Kernel = fixtureKernel): CadDocument {
  const { rim, hub } = f62Sizes;
  // The rim's tube: a circle on XZ (u = x, v = z) at x = 185, revolved about the z axis.
  const tube: CadSketch = {
    id: 'rim-tube',
    name: 'Rim tube',
    plane: { origin: position(0, 0, 0), orientation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] },
    entities: [point('rc'), { type: 'circle', id: 'rim-circle', center: 'rc' }],
    constraints: [],
    solved: { rc: [rim.radius, 0], 'rim-circle': [rim.tube, 0] },
  };
  // One spoke along −x: round at the hub (x = −30), flat at the rim (x = −175).
  const yzAt = (x: number) => ({ origin: position(x, 0, 0), orientation: YZ });
  const root = ellipse('spoke-root', 'Spoke root', yzAt(-30), 14, 14);
  const tip = ellipse('spoke-tip', 'Spoke tip', yzAt(-175), 8, 26);
  let doc = applyCadOperation(emptyCad(kernel), {
    type: 'insertFeatures',
    parameters: [],
    sketches: [tube, root, tip],
    features: [
      {
        id: 'rim-turn',
        name: 'Rim',
        type: 'revolve',
        inputFeatureIds: [],
        args: {
          sketchId: 'rim-tube',
          region: { outer: ['rim-circle'], holes: [] },
          axisOrigin: [mm(0), mm(0)],
          axisDirection: [0, 1],
          angle: { literalRad: 2 * Math.PI },
        },
      },
      {
        id: 'hub',
        name: 'Hub',
        type: 'cylinder',
        inputFeatureIds: [],
        args: {
          radius: mm(hub.radius),
          height: mm(hub.height),
          origin: position(0, 0, -hub.height / 2),
          orientation: identityQuaternion(),
        },
      },
      {
        id: 'spoke',
        name: 'Spoke',
        type: 'loft',
        inputFeatureIds: [],
        args: { sections: [region(root), region(tip)], ruled: false },
      },
    ],
    bodies: [
      newBody('rim', 'Rim', 'rim-turn', presetLook('leather')),
      newBody('hub-body', 'Hub', 'hub', { ...presetLook('plastic-matte'), color: '#1d1f22' }),
      newBody('spoke-body', 'Spoke', 'spoke', { ...presetLook('plastic-matte'), color: '#1d1f22' }),
    ],
  });
  // Left (−x), bottom (−y) and right (+x): the spoke turned 90° twice about the z axis.
  doc = applyCadOperation(doc, {
    type: 'patternBodies',
    targetId: 'hub-body',
    toolId: 'spoke-body',
    mode: 'union',
    patternFeatureId: 'spokes',
    placementFeatureId: 'spokes-placement',
    layout: around([0, 0, 1], 3, 90),
  });
  return doc;
}
