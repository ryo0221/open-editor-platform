/**
 * GV3b (docs/cad/gulliver-world.md): Lilliput's machines in CAD, at true size (Gulliver's mm).
 *
 * - The emperor's greatest engine (第1篇第1章): "a frame of wood raised three inches from the
 *   ground, about seven feet long, and four wide, moving upon twenty-two wheels". An assembly of
 *   the frame and one wheel version placed 22 times (a component pattern: 11 along, 2 across).
 *   The wheels' size and the 11 axles are the author's.
 * - A man of war of Blefuscu (第1篇第5章): the fleet was "about fifty men of war"; Lilliput's
 *   largest are "nine feet long" (第1篇第1章). A ship of 6 ft (創作) with three masts, sails and a
 *   hole at the prow for Gulliver's hook. The fleet is an assembly of that one version placed 50
 *   times (10 along, 5 across), as Gulliver drew "fifty of the enemy's largest men of war".
 *
 * Every function takes the kernel profile of the build that will evaluate it (a test passes the
 * Playground's), since the content hashes include it.
 */
import {
  applyCadOperation,
  cadContentHash,
  emptyCad,
  fixtureComponent,
  fixturePart,
  fixtureVersion,
  identityQuaternion,
  mm,
  parameterValues,
  position,
  solveJoints,
  type CadAppearance,
  type CadDocument,
  type CadFeature,
  type CadFixtureVersion,
  type CadKernelProfile,
  type CadNewBody,
  type CadSketch,
  type Quaternion,
} from '@editor-platform/cad-core';

type Kernel = Pick<CadKernelProfile, 'id' | 'buildHash'>;
const inch = 25.4;
const foot = 304.8;

const timber: CadAppearance = { color: '#8a6238', opacity: 1, roughness: 0.8, metalness: 0 };
const darkTimber: CadAppearance = { color: '#5c3d22', opacity: 1, roughness: 0.8, metalness: 0 };
const iron: CadAppearance = { color: '#4a4d52', opacity: 1, roughness: 0.5, metalness: 0.8 };
const canvas: CadAppearance = { color: '#efe6cf', opacity: 1, roughness: 0.9, metalness: 0 };

const newBody = (id: string, name: string, source: string, look: CadAppearance): CadNewBody => ({
  id,
  name,
  sourceFeatureId: source,
  placementFeatureId: `${id}-placement`,
  appearance: look,
});
/** z along y (a quarter turn about x). */
const zAlongY: Quaternion = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
/** u along −z, v along y, normal along +x: a section across a hull running along x. */
const YZ: Quaternion = [0, Math.SQRT1_2, 0, Math.SQRT1_2];

function polygon(id: string, plane: CadSketch['plane'], corners: [number, number][]): CadSketch {
  const solved: Record<string, [number, number]> = {};
  const entities: CadSketch['entities'] = [];
  corners.forEach((c, k) => {
    solved[`${id}-p${k}`] = c;
    entities.push({ type: 'point', id: `${id}-p${k}` });
  });
  corners.forEach((_, k) =>
    entities.push({
      type: 'line',
      id: `${id}-l${k}`,
      start: `${id}-p${k}`,
      end: `${id}-p${(k + 1) % corners.length}`,
    }),
  );
  return { id, name: id, plane, entities, constraints: [], solved };
}
const region = (s: CadSketch) => ({
  sketchId: s.id,
  region: { outer: s.entities.filter((e) => e.type === 'line').map((e) => e.id), holes: [] },
});
function box(id: string, size: [number, number, number], at: [number, number, number]): CadFeature {
  return {
    id,
    name: id,
    type: 'box',
    inputFeatureIds: [],
    args: {
      size: [mm(size[0]), mm(size[1]), mm(size[2])],
      origin: position(...at),
      orientation: identityQuaternion(),
    },
  };
}
function cylinder(
  id: string,
  radius: number,
  height: number,
  at: [number, number, number],
  orientation: Quaternion = identityQuaternion(),
): CadFeature {
  return {
    id,
    name: id,
    type: 'cylinder',
    inputFeatureIds: [],
    args: { radius: mm(radius), height: mm(height), origin: position(...at), orientation },
  };
}
const union = (id: string, inputs: [string, ...string[]]): CadFeature => ({
  id,
  name: id,
  type: 'boolean',
  inputFeatureIds: inputs,
  args: { mode: 'union' },
});

/** The engine's sizes (mm). */
export const engineSizes = {
  /** 本文: seven feet long, four wide, raised three inches. */
  length: 7 * foot,
  width: 4 * foot,
  clearance: 3 * inch,
  wheels: 22,
  /** 創作: 11 axles, wheels 4 in across and 3/4 in wide, a deck 1 in thick. */
  axles: 11,
  wheelRadius: 2 * inch,
  wheelWidth: 0.75 * inch,
  deck: 1 * inch,
} as const;

/** The engine's wheel: axis along y through the origin, a rim and a boss (revolved). */
export function engineWheel(kernel: Kernel): CadDocument {
  const r = engineSizes.wheelRadius,
    w = engineSizes.wheelWidth / 2;
  const xy = { origin: position(0, 0, 0), orientation: identityQuaternion() };
  const section = polygon('wheel-section', xy, [
    [0, -w - 3],
    [10, -w - 3],
    [10, -3],
    [r - 6, -3],
    [r - 6, -w],
    [r, -w],
    [r, w],
    [r - 6, w],
    [r - 6, 3],
    [10, 3],
    [10, w + 3],
    [0, w + 3],
  ]);
  return applyCadOperation(emptyCad(kernel), {
    type: 'insertFeatures',
    parameters: [],
    sketches: [section],
    features: [
      {
        id: 'wheel-turn',
        name: 'Wheel',
        type: 'revolve',
        inputFeatureIds: [],
        args: {
          ...region(section),
          axisOrigin: [mm(0), mm(0)],
          axisDirection: [0, 1],
          angle: { literalRad: 2 * Math.PI },
        },
      },
    ],
    bodies: [newBody('wheel', 'Wheel', 'wheel-turn', darkTimber)],
  });
}

/**
 * The engine's frame: the deck from (0, −w/2) to (length, w/2) with its underside 3 in up, side
 * rails, and 11 axles across at the wheels' height (axles stick out to carry the wheels).
 */
export function engineFrame(kernel: Kernel): CadDocument {
  const s = engineSizes;
  const pitch = s.length / s.axles;
  const axleLength = s.width + 2 * (s.wheelWidth + 12);
  const features: CadFeature[] = [
    box('deck', [s.length, s.width, s.deck], [0, -s.width / 2, s.clearance]),
    box(
      'rail-l',
      [s.length, 1.5 * inch, 2 * inch],
      [0, s.width / 2 - 1.5 * inch, s.clearance + s.deck],
    ),
    box('rail-r', [s.length, 1.5 * inch, 2 * inch], [0, -s.width / 2, s.clearance + s.deck]),
  ];
  const axles: string[] = [];
  for (let k = 0; k < s.axles; k++) {
    const x = (k + 0.5) * pitch;
    features.push(
      cylinder(`axle-${k}`, 6, axleLength, [x, -axleLength / 2, s.wheelRadius], zAlongY),
      box(
        `bearer-${k}`,
        [24, s.width - 40, s.clearance - s.wheelRadius + 1],
        [x - 12, -s.width / 2 + 20, s.wheelRadius],
      ),
    );
    axles.push(`axle-${k}`, `bearer-${k}`);
  }
  features.push(union('frame', ['deck', 'rail-l', 'rail-r', ...axles]));
  return applyCadOperation(emptyCad(kernel), {
    type: 'insertFeatures',
    parameters: [],
    sketches: [],
    features,
    bodies: [newBody('frame-body', 'Frame', 'frame', timber)],
  });
}

const placed = (doc: CadDocument, lookup: Map<string, CadDocument>) => {
  doc.solvedPoses = solveJoints(
    doc,
    parameterValues(doc),
    (h) => lookup.get(h),
    () => undefined,
    () => true,
  ).poses;
  return doc;
};

/**
 * The greatest engine as an assembly: the frame, and one wheel seeded at the first axle's left
 * end and patterned 11 along x and 2 across y (22 wheels). Returns the versions it places too.
 */
export function engineAssembly(kernel: Kernel) {
  const s = engineSizes;
  const frame = fixtureVersion('gv-engine-frame', 'v1', engineFrame(kernel));
  const wheel = fixtureVersion('gv-engine-wheel', 'v1', engineWheel(kernel));
  const pitch = s.length / s.axles;
  const across = s.width + s.wheelWidth + 12;
  const doc = emptyCad(kernel);
  doc.parts = [
    fixturePart('part-frame', 'Frame', frame, [
      [0, -s.width / 2 - 40, 0],
      [s.length, s.width / 2 + 40, s.clearance + s.deck + 2 * inch],
    ]),
    fixturePart('part-wheel', 'Wheel', wheel, [
      [-s.wheelRadius, -12, -s.wheelRadius],
      [s.wheelRadius, 12, s.wheelRadius],
    ]),
  ];
  // Component patterns run one way only: a wheel at each end of the first axle, each repeated
  // along the 11 axles.
  doc.components = [
    fixtureComponent('c-frame', 'part-frame'),
    fixtureComponent('c-wheel-r', 'part-wheel', [pitch / 2, -across / 2, s.wheelRadius]),
    fixtureComponent('c-wheel-l', 'part-wheel', [pitch / 2, across / 2, s.wheelRadius]),
  ];
  doc.componentPatterns = (['r', 'l'] as const).map((side) => ({
    id: `wheels-${side}`,
    name: `11 wheels ${side === 'r' ? 'right' : 'left'}`,
    seedComponentId: `c-wheel-${side}`,
    layout: {
      type: 'linear' as const,
      direction: [1, 0, 0] as [number, number, number],
      count: { literal: s.axles },
      spacing: mm(pitch),
    },
  }));
  const closure = new Map<string, CadDocument>([
    [frame.contentHash, frame.content],
    [wheel.contentHash, wheel.content],
  ]);
  return { assembly: placed(doc, closure), versions: [frame, wheel], closure };
}

/** The man of war's sizes (mm). */
export const shipSizes = {
  /** 創作 (Lilliput's largest are nine feet): 6 ft long, 18 in across, 14 in deep. */
  length: 6 * foot,
  beam: 18 * inch,
  depth: 14 * inch,
  /** Below the waterline (創作). */
  draught: 8 * inch,
  masts: [
    { x: 0.27, height: 4.2 * foot },
    { x: 0.52, height: 5 * foot },
    { x: 0.76, height: 3.8 * foot },
  ],
} as const;

/**
 * A man of war, bow at +x (x from 0 at the stern to `length`), keel at z = 0, the waterline at
 * `draught`. The hull is lofted through five sections (narrow at the stern, full amidships, a
 * point at the bow); masts, yards and square sails; a bowsprit; and a hole through the prow where
 * Gulliver fastened his hook.
 */
export function manOfWar(kernel: Kernel): CadDocument {
  const s = shipSizes;
  const stations: { x: number; half: number; floor: number; top: number }[] = [
    { x: 0, half: 0.55, floor: 0.35, top: 1.18 },
    { x: 0.2, half: 0.92, floor: 0.1, top: 1.05 },
    { x: 0.5, half: 1, floor: 0, top: 1 },
    { x: 0.8, half: 0.8, floor: 0.08, top: 1.04 },
    { x: 0.97, half: 0.12, floor: 0.3, top: 1.12 },
  ];
  // On a YZ plane u runs along −z and v along y: a section's corner (y, z) is (−z, y).
  const sections = stations.map((st, k) => {
    const b = (s.beam / 2) * st.half,
      d = s.depth;
    const z0 = d * st.floor,
      z1 = d * st.top;
    const corners: [number, number][] = [
      [-z0, -b * 0.35],
      [-z0, b * 0.35],
      [-(z0 + (z1 - z0) * 0.45), b],
      [-z1, b * 0.92],
      [-z1, -b * 0.92],
      [-(z0 + (z1 - z0) * 0.45), -b],
    ];
    return polygon(
      `hull-${k}`,
      { origin: position(st.x * s.length, 0, 0), orientation: YZ },
      corners,
    );
  });
  const features: CadFeature[] = [
    {
      id: 'hull-loft',
      name: 'Hull',
      type: 'loft',
      inputFeatureIds: [],
      args: { sections: sections.map(region), ruled: false },
    },
  ];
  const rig: string[] = [];
  const sails: string[] = [];
  s.masts.forEach((m, k) => {
    const x = m.x * s.length;
    features.push(cylinder(`mast-${k}`, 6, m.height, [x, 0, s.depth * 0.5]));
    rig.push(`mast-${k}`);
    // Two yards and two square sails on each mast.
    for (const [j, at, width] of [
      [0, 0.45, 0.85],
      [1, 0.78, 0.6],
    ] as const) {
      const z = s.depth + m.height * at;
      const wide = s.beam * 1.6 * width;
      features.push(
        cylinder(`yard-${k}-${j}`, 3, wide, [x + 8, -wide / 2, z], zAlongY),
        box(
          `sail-${k}-${j}`,
          [3, wide * 0.92, m.height * 0.28],
          [x + 12, (-wide * 0.92) / 2, z - m.height * 0.28],
        ),
      );
      rig.push(`yard-${k}-${j}`);
      sails.push(`sail-${k}-${j}`);
    }
  });
  features.push(
    {
      id: 'bowsprit',
      name: 'Bowsprit',
      type: 'cylinder',
      inputFeatureIds: [],
      args: {
        radius: mm(4),
        height: mm(1.6 * foot),
        origin: position(0.9 * s.length, 0, s.depth * 1.05),
        // z along +x tilted 20° up: a quarter turn about y, then 20° back.
        orientation: [0, Math.sin((70 * Math.PI) / 360), 0, Math.cos((70 * Math.PI) / 360)],
      },
    },
    union('rigging', ['bowsprit', ...rig]),
    union('sails', [sails[0]!, ...sails.slice(1)]),
    // The hole at the prow (第1篇第5章: "I fastened a hook to the hole at the prow of each").
    cylinder('prow-hole', 5, s.beam, [0.9 * s.length, -s.beam / 2, s.depth * 0.8], zAlongY),
  );
  let doc = applyCadOperation(emptyCad(kernel), {
    type: 'insertFeatures',
    parameters: [],
    sketches: sections,
    features,
    bodies: [
      newBody('hull', 'Hull', 'hull-loft', darkTimber),
      newBody('rig', 'Masts and yards', 'rigging', timber),
      newBody('sail-body', 'Sails', 'sails', canvas),
      newBody('hole-tool', 'Prow hole', 'prow-hole', iron),
    ],
  });
  doc = applyCadOperation(doc, {
    type: 'booleanBodies',
    targetId: 'hull',
    toolIds: ['hole-tool'],
    mode: 'cut',
    booleanFeatureId: 'hull-cut',
    placementFeatureId: 'hull-cut-placement',
  });
  return doc;
}

/** The fleet: one man of war placed 50 times, 10 along and 5 across, bows to +x. */
export function blefuscuFleet(kernel: Kernel) {
  const s = shipSizes;
  const ship = fixtureVersion('gv-man-of-war', 'v1', manOfWar(kernel));
  const doc = emptyCad(kernel);
  doc.parts = [
    fixturePart('part-ship', 'Man of war', ship, [
      [0, -s.beam, 0],
      [s.length + 2 * foot, s.beam, s.depth + 5 * foot],
    ]),
  ];
  // Five ranks 4 ft apart, each one ship repeated 10 times astern.
  doc.components = Array.from({ length: 5 }, (_, r) =>
    fixtureComponent(`c-ship-${r}`, 'part-ship', [0, (r - 2) * 4 * foot, 0]),
  );
  doc.componentPatterns = doc.components.map((c, r) => ({
    id: `rank-${r}`,
    name: `Rank ${r + 1}`,
    seedComponentId: c.id,
    layout: {
      type: 'linear' as const,
      direction: [-1, 0, 0] as [number, number, number],
      count: { literal: 10 },
      spacing: mm(s.length + 3 * foot),
    },
  }));
  const closure = new Map<string, CadDocument>([[ship.contentHash, ship.content]]);
  return { assembly: placed(doc, closure), versions: [ship], closure };
}

export type { CadFixtureVersion };
export const versionHash = cadContentHash;
