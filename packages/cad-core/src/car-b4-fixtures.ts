/**
 * F63 (CR7b, docs/cad/car-design.md, CR7の分け方): one whole car for B4. The F28 skin (left half)
 * with its right half as `mirrorCopy` bodies, the doors and hood (both sides) made parts on hinge
 * joints, the F63 body in white (`f63Body`, laid out from the skin) placed at the origin, and B3's parts placed by joints that read
 * the body in white's faces: the seats on the floor pan, the steering wheel on the dash, the
 * headlamps on the radiator support, the tail lamps on the trunk floor, the wheels on the strut
 * top mounts and the rear brackets, the door mirrors on the doors. The right-hand lamps and
 * mirror are other versions: the left one's bodies `mirror`ed (no reflected placement exists).
 * Every body is given a density (and a sheet a thickness) for CR7a.
 *
 * Coordinates as F25: x forward from the tail, y across with the left side at y < 0, z up. The
 * axles are at x 955 and 3355 (F25), the wheel centres at z 300.
 */
import { composePoses, identityPose, type CadComponent, type CadSolvedPose } from './assembly';
import { fixtureComponent, fixturePart, fixtureVersion } from './assembly-fixtures';
import { f63Body, f63BodyLayout, f63Greenhouse, f63SectionScales, f63Y as Y } from './car-b4-body';
import { f28B2Car, f28Bounds, f28Hinges, outlines, type F28Outline } from './car-fixtures';
import { f25SectionPoints, f25Sections, fixtureKernel } from './fixtures';
import { invertPose, type CadConnector, type CadJoint } from './joints';
import { lampFixture, presetLook } from './lamp-fixtures';
import { bodyPartContent } from './make-part';
import {
  cadMassMaterials,
  identityQuaternion,
  mm,
  position,
  type CadAppearance,
  type CadBodyMass,
  type CadDocument,
  type CadFeature,
  type CadKernelProfile,
  type Quaternion,
  type Vec3,
} from './model';
import { applyCadOperation, cadContentHash } from './operations';
import { f60Wheel, f61Mirror, f62Steering } from './parts-fixtures';
import { f59LowHPoint, f59Ranges, f59Seat } from './seat-fixtures';
import { splineThrough, type CadSketch } from './sketch';
import type { CadFaceName, CadTopologyRef } from './topology';

type Kernel = Pick<CadKernelProfile, 'id' | 'buildHash'>;
const pose = (t: Vec3, q: Quaternion = identityQuaternion()): CadSolvedPose => ({
  translationMm: t,
  rotation: q,
});
const s = Math.SQRT1_2;
/** Quarter and half turns. */
const turn = {
  x90: [s, 0, 0, s] as Quaternion,
  xm90: [-s, 0, 0, s] as Quaternion,
  x180: [1, 0, 0, 0] as Quaternion,
  y90: [0, s, 0, s] as Quaternion,
  ym90: [0, -s, 0, s] as Quaternion,
  z90: [0, 0, s, s] as Quaternion,
  zm90: [0, 0, -s, s] as Quaternion,
  z180: [0, 0, 1, 0] as Quaternion,
  /** z along −x, x along +z: a face looking back with the part's Z laid on it. */
  facingBack: [0.5, -0.5, -0.5, 0.5] as Quaternion,
};

/** CR7g-1: across the car at its ends (F63's first and last sections' factor): the lamps
 * and what closes the ends sit by it. */
const f63EndScale = f63SectionScales[0];
const E = (y: number) => Math.round(y * f63EndScale);
/** Where the B4 parts sit (world, mm). */
export const f63Layout = {
  axles: { rear: 955, front: 3355, z: 300, track: Y(700) },
  /** The seats (F59's low version, CR7d) on the floor. */
  seat: { x: 1650, y: Y(370) },
  steering: [2550, Y(-370), 820] as Vec3,
  /** CR7g-2: the lamps' faces flush with the end plates' (front 4,215, rear −12). */
  headlamp: [4185, E(560), 700] as Vec3,
  tail: [8, E(530), 820] as Vec3,
  /** On the door's front upper corner, in the door's (world) coordinates at 0°. */
  mirror: [2500, Y(850), 880] as Vec3,
  /** The doors' hinge axis (z up), ahead of and outside the door's front edge. */
  doorHinge: [2610, Y(-850), 580] as Vec3,
};

/** CR7d: the left (driver's) seat's H-point in the car (world, mm), at its rearmost slide. */
export const f63DriverHPoint: Vec3 = [
  f63Layout.seat.x + f59LowHPoint[0],
  -f63Layout.seat.y + f59LowHPoint[1],
  f63BodyLayout.floor.z + f59LowHPoint[2],
];

/**
 * The body in white's faces the parts are joined to: each one's name and the frame the kernel gives it (the
 * face's centroid, its outward normal as z, x the part's Z laid on the face or X on a face
 * normal to Z). The kernel test checks these frames against the evaluation.
 */
export const f63Faces = {
  floor: { body: 'floor', name: ['side:e:s0'], frame: pose([2140, 0, 230]) },
  dash: { body: 'dash', name: ['side:e:s1'], frame: pose([3010, 0, 660], turn.facingBack) },
  radiator: {
    body: 'radiator',
    name: ['side:e:s0'],
    frame: pose([3820, 0, 550], turn.facingBack),
  },
  trunk: { body: 'trunk', name: ['side:e:s0'], frame: pose([740, 0, 330]) },
  strutLeft: { body: 'strut-mount', name: ['-z'], frame: pose([3355, Y(-650), 660], turn.x180) },
  strutRight: {
    body: 'strut-mount-r',
    name: ['mirror:strut-mount-r-copy', '-z'],
    frame: pose([3355, Y(650), 660], turn.x180),
  },
  rearLeft: { body: 'rear-mount', name: ['-z'], frame: pose([955, Y(-505), 265], turn.x180) },
  rearRight: {
    body: 'rear-mount-r',
    name: ['mirror:rear-mount-r-copy', '-z'],
    frame: pose([955, Y(505), 265], turn.x180),
  },
} satisfies Record<string, { body: string; name: CadFaceName; frame: CadSolvedPose }>;
export type F63Face = keyof typeof f63Faces;

/** The body in white's result feature a face is made on (its final placement). */
export const f63FaceRef = (biw: CadDocument, face: F63Face): CadTopologyRef => {
  const f = f63Faces[face];
  const body = biw.bodies.find((b) => b.id === f.body)!;
  return {
    kind: 'face',
    featureId: body.resultFeatureId,
    name: [f.name],
    hint: { centroid: f.frame.translationMm, size: 100 },
  };
};

/** CR7a densities: by the look's preset, else steel (sheets 0.8 mm). */
const massOfLook: Record<string, keyof typeof cadMassMaterials> = {
  'plastic-matte': 'polypropylene',
  chrome: 'aluminium',
  'lamp-white': 'glass',
  'lamp-lens': 'pmma',
  'lamp-red': 'pmma',
  aluminium: 'aluminium',
  rubber: 'rubber',
  leather: 'pu-foam',
  fabric: 'pu-foam',
  steel: 'steel',
};
/** Every active body of `doc` given a density (a sheet also a thickness). */
export function weighed(doc: CadDocument, sheetMm = 0.8, override: Record<string, string> = {}) {
  let out = doc;
  for (const b of doc.bodies) {
    if (b.state !== 'active' || b.mass) continue;
    const material = (override[b.id] ??
      massOfLook[b.appearance.material ?? ''] ??
      'steel') as keyof typeof cadMassMaterials;
    const mass: CadBodyMass = {
      densityKgM3: cadMassMaterials[material]!,
      material,
      ...(b.kind === 'sheet' ? { thicknessMm: material === 'aluminium' ? 0.5 : sheetMm } : {}),
    };
    out = applyCadOperation(out, { type: 'setBodyMass', bodyId: b.id, mass });
  }
  return out;
}

/** A part's right-hand version: each of its bodies reflected in y = 0 (in its own coordinates). */
export function mirroredPart(doc: CadDocument): CadDocument {
  let out = doc;
  for (const b of doc.bodies) {
    if (b.state !== 'active') continue;
    out = applyCadOperation(out, {
      type: 'detailBody',
      bodyId: b.id,
      placementFeatureId: `${b.id}-mirror-placement`,
      feature: {
        id: `${b.id}-mirror`,
        name: `${b.name} mirrored`,
        type: 'mirror',
        inputFeatureIds: [b.resultFeatureId],
        args: { plane: { origin: position(0, 0, 0), normal: [0, 1, 0] }, union: false },
      } as Extract<CadFeature, { type: 'mirror' }>,
    });
  }
  return out;
}

/**
 * A connector whose frame (after its offset) is `at`, on a reference whose own frame is `base`
 * (both in the coordinates the reference is read in).
 */
const connector = (
  componentPath: string[],
  ref: CadConnector['ref'],
  base: CadSolvedPose,
  at: CadSolvedPose,
): CadConnector => {
  const offset = composePoses(invertPose(base), at);
  return {
    componentPath,
    ref,
    flip: false,
    offset: {
      translation: position(...offset.translationMm),
      rotation: offset.rotation,
    },
  };
};

/**
 * F63: the car's assembly and the closure of its versions. `kernel` pins every version to one
 * build (a kernel test or the Playground passes the real one).
 */
/** CR7e: the glass's thickness (mm), for its mass. */
export const f63GlassMm = 4;
/** CR7e: the left side's glass bodies (front and rear window), each mirrored to the right. */
export const f63GlassBodies = ['glass-front-body', 'glass-rear-body'] as const;
const f63GlassNames = ['Front side glass', 'Rear side glass'];
const f63GlassMass: CadBodyMass = {
  densityKgM3: cadMassMaterials.glass!,
  material: 'glass',
  thicknessMm: f63GlassMm,
};

/**
 * CR7e: the outer panels painted (gloss paint) and the side windows glazed: the glass is the
 * pieces the window trim cuts from the skin (the same sketch, kept inside), so it lies flush in
 * the openings, 4 mm float glass for its mass.
 */
export function f63Finish(doc: CadDocument): CadDocument {
  const paint = presetLook('paint-gloss');
  for (const bodyId of ['skin-body', 'door-body', 'hood-body', 'hatch-body'])
    doc = applyCadOperation(doc, { type: 'setAppearance', bodyId, appearance: paint });
  const windows = doc.features.find((f) => f.id === 'windows') as Extract<
    CadFeature,
    { type: 'trim' }
  >;
  // One trim per window (kept inside, a trim leaves one piece): the front and the rear glass.
  const tool = windows.args.tool as { sketchId: string; elements: string[] };
  const chains = [tool.elements, ...(windows.args.chains ?? [])];
  const glass = presetLook('glass');
  doc = applyCadOperation(doc, {
    type: 'insertFeatures',
    parameters: [],
    sketches: [],
    features: chains.map((elements, k) => ({
      ...windows,
      id: f63GlassBodies[k]!.replace('-body', ''),
      name: f63GlassNames[k]!,
      args: { tool: { sketchId: tool.sketchId, elements }, keep: 'inside' as const },
    })),
    bodies: chains.map((_, k) => ({
      id: f63GlassBodies[k]!,
      name: f63GlassNames[k]!,
      sourceFeatureId: f63GlassBodies[k]!.replace('-body', ''),
      placementFeatureId: f63GlassBodies[k]!.replace('-body', '-placement'),
      appearance: glass,
    })),
  });
  for (const bodyId of f63GlassBodies)
    doc = applyCadOperation(doc, { type: 'setBodyMass', bodyId, mass: f63GlassMass });
  return doc;
}

/**
 * The ends' plates (CR7e-2b): the skin is a loft open at its first and last sections, so the car
 * showed its inner panels from the front and the back. Each end is closed by a 10 mm plate cut
 * to that section (both halves) with openings for the lamps, then a bumper below it; the grille
 * sits on the front plate. The rear plate stands 2 mm off the skin so it never touches the tail
 * lamps behind its openings.
 */
export const f63Ends = {
  plateMm: 10,
  front: { x: 4205, lamps: { y: [E(430), E(690)], z: [625, 775] } },
  rear: { x: -2, lamps: { y: [E(375), E(685)], z: [760, 880] } },
  grille: { y: E(320), z: [430, 600], depthMm: 8 },
  bumper: { z: [230, 390], front: [4215, 4290], rear: [-80, -12], halfWidth: E(680) },
};
/** The plates, grille and bumpers (own bodies across the whole width), by body ID. */
export const f63EndBodies = [
  'fascia-front-body',
  'fascia-rear-body',
  'grille-body',
  'bumper-front-body',
  'bumper-rear-body',
] as const;

function endPlateSketch(
  id: string,
  name: string,
  end: 'front' | 'rear',
): { sketch: CadSketch; region: { outer: string[]; holes: string[][] } } {
  const end0 = end === 'front' ? f25Sections.at(-1)! : f25Sections[0]!;
  const row = { ...end0, w: end0.w * f63EndScale };
  const e = f63Ends[end];
  const left = splineThrough(f25SectionPoints(row, row.top, f63Greenhouse), 3, false);
  const solved: Record<string, [number, number]> = {};
  left.forEach((p, i) => {
    solved[`l${i}`] = p;
    if (i) solved[`r${i}`] = [-p[0], p[1]];
  });
  const n = left.length - 1;
  const entities: CadSketch['entities'] = Object.keys(solved).map((p) => ({
    type: 'point' as const,
    id: p,
  }));
  entities.push(
    { type: 'spline', id: 'side-l', poles: left.map((_, i) => `l${i}`), degree: 3 },
    { type: 'line', id: 'bottom', start: `l${n}`, end: `r${n}` },
    {
      type: 'spline',
      id: 'side-r',
      poles: [...left.map((_, i) => (i ? `r${i}` : 'l0'))].reverse(),
      degree: 3,
    },
  );
  // The lamps' openings, one each side (u → y, v → z).
  const holes = [-1, 1].map((side, k) => {
    const [y0, y1] = e.lamps.y.map((y) => side * y).sort((a, b) => a - b) as [number, number];
    const [z0, z1] = e.lamps.z;
    const corners = (
      [
        [y0, z0],
        [y1, z0],
        [y1, z1],
        [y0, z1],
      ] as [number, number][]
    ).map((c, j) => {
      solved[`h${k}p${j}`] = c;
      entities.push({ type: 'point', id: `h${k}p${j}` });
      return `h${k}p${j}`;
    });
    return corners.map((start, j) => {
      entities.push({ type: 'line', id: `h${k}s${j}`, start, end: corners[(j + 1) % 4]! });
      return `h${k}s${j}`;
    });
  });
  return {
    sketch: {
      id,
      name,
      // YZ: u → y, v → z, the normal along +x.
      plane: { origin: position(e.x, 0, 0), orientation: [0.5, 0.5, 0.5, 0.5] },
      entities,
      constraints: [],
      solved,
    },
    region: { outer: ['side-l', 'bottom', 'side-r'], holes },
  };
}

/** CR7e-2b: the ends closed (`f63Ends`): the plates in the body's paint, the rest dark plastic. */
export function f63CloseEnds(doc: CadDocument): CadDocument {
  const front = endPlateSketch('front-plate-line', 'Front plate line', 'front');
  const rear = endPlateSketch('rear-plate-line', 'Rear plate line', 'rear');
  const E = f63Ends;
  const plate = (id: string, name: string, line: typeof front, direction: 1 | -1): CadFeature => ({
    id,
    name,
    type: 'extrude',
    inputFeatureIds: [],
    args: {
      sketchId: line.sketch.id,
      region: line.region,
      distance: mm(E.plateMm),
      direction,
    },
  });
  const box = (id: string, name: string, lo: Vec3, hi: Vec3): CadFeature => ({
    id,
    name,
    type: 'box',
    inputFeatureIds: [],
    args: {
      size: [mm(hi[0] - lo[0]), mm(hi[1] - lo[1]), mm(hi[2] - lo[2])],
      origin: position(...lo),
      orientation: identityQuaternion(),
    },
  });
  const B = E.bumper;
  const frontFace = E.front.x + E.plateMm;
  const features: CadFeature[] = [
    plate('fascia-front', 'Front plate', front, 1),
    // The rear plate lies behind its sketch (towards −x).
    plate('fascia-rear', 'Rear plate', rear, -1),
    box(
      'grille',
      'Grille',
      [frontFace, -E.grille.y, E.grille.z[0]],
      [frontFace + E.grille.depthMm, E.grille.y, E.grille.z[1]],
    ),
    box(
      'bumper-front',
      'Front bumper',
      [B.front[0], -B.halfWidth, B.z[0]],
      [B.front[1], B.halfWidth, B.z[1]],
    ),
    box(
      'bumper-rear',
      'Rear bumper',
      [B.rear[0], -B.halfWidth, B.z[0]],
      [B.rear[1], B.halfWidth, B.z[1]],
    ),
  ];
  const paint = presetLook('paint-gloss');
  const skin = doc.bodies.find((b) => b.id === 'skin-body');
  const dark: CadAppearance = { ...presetLook('plastic-matte'), color: '#1d1f22' };
  const looks: Record<string, CadAppearance> = {
    'fascia-front': { ...paint, color: skin?.appearance.color ?? paint.color },
    'fascia-rear': { ...paint, color: skin?.appearance.color ?? paint.color },
    grille: dark,
    'bumper-front': dark,
    'bumper-rear': dark,
  };
  doc = applyCadOperation(doc, {
    type: 'insertFeatures',
    parameters: [],
    sketches: [front.sketch, rear.sketch],
    features,
    bodies: features.map((f) => ({
      id: `${f.id}-body`,
      name: f.name,
      sourceFeatureId: f.id,
      placementFeatureId: `${f.id}-placement`,
      appearance: looks[f.id]!,
    })),
  });
  // Painted plastic, not the panels' steel.
  for (const bodyId of f63EndBodies)
    doc = applyCadOperation(doc, {
      type: 'setBodyMass',
      bodyId,
      mass: { densityKgM3: cadMassMaterials.polypropylene!, material: 'polypropylene' },
    });
  return doc;
}

/**
 * CR7g-2 (docs/cad/car-design.md, CR7gの分け方): F63's details, world mm. The front side window
 * follows the A-pillar so its top stays below the roof's side (F28's ran onto the windscreen);
 * the windscreen and rear window are cut from above (x/y, past the centreline) inside the roof's
 * side; the door handle stands out of the door's flat band; the exhaust and number plates sit
 * under and on the bumpers.
 */
export const f63Details = {
  sideWindows: [
    [1400, 1950, 960, 1200],
    [
      [2050, 960],
      [2560, 960],
      [2560, 1050],
      [2050, 1180],
    ],
  ] as F28Outline[],
  screens: [
    [
      [2150, -400],
      [2950, -430],
      [2950, 150],
      [2150, 150],
    ],
    [
      [620, -380],
      [1250, -400],
      [1250, 150],
      [620, 150],
    ],
  ] as F28Outline[],
  /** On the door's rear, out of its band at y ≈ −989 (in 9 mm, out 11 mm). */
  handle: { x: [1500, 1640], y: [-1000, -980], z: [760, 785] },
  exhaust: { x: [-70, 190], y: E(-430), z: 150, radius: 28, wallMm: 3 },
  /** 520 × 110 mm plates on the bumpers' faces. */
  plate: { halfWidth: 260, z: [255, 365], thickMm: 6 },
};
/** CR7g-2: the windscreen and rear window glass (left halves, each mirrored to the right). */
export const f63ScreenBodies = ['glass-screen-body', 'glass-back-body'] as const;
const f63ScreenNames = ['Windscreen', 'Rear window'];
/** CR7g-2: the exhaust and the number plates, by body ID. */
export const f63FittingBodies = ['exhaust-body', 'plate-front-body', 'plate-rear-body'] as const;

/**
 * CR7g-2: the windscreen and rear window cut from the skin from above and glazed as the side
 * windows are; the inner panel opened behind every window so the glass is seen through.
 */
export function f63Glaze(doc: CadDocument): CadDocument {
  const screens = outlines('screen-line', 'Screen line', identityQuaternion(), f63Details.screens);
  doc = applyCadOperation(doc, {
    type: 'insertFeatures',
    parameters: [],
    sketches: [screens.sketch],
    features: [],
    bodies: [],
  });
  const resultOf = (bodyId: string) => doc.bodies.find((b) => b.id === bodyId)!.resultFeatureId;
  const source = resultOf('skin-body');
  const tool = { sketchId: screens.sketch.id, elements: screens.chains[0]! };
  doc = applyCadOperation(doc, {
    type: 'detailBody',
    bodyId: 'skin-body',
    placementFeatureId: 'screens-placement',
    feature: {
      id: 'screens',
      name: 'Screens',
      type: 'trim',
      inputFeatureIds: [source],
      args: { tool, keep: 'outside', chains: screens.chains.slice(1) },
    } as Extract<CadFeature, { type: 'trim' }>,
  });
  const glass = presetLook('glass');
  doc = applyCadOperation(doc, {
    type: 'insertFeatures',
    parameters: [],
    sketches: [],
    features: screens.chains.map((elements, k) => ({
      id: f63ScreenBodies[k]!.replace('-body', ''),
      name: f63ScreenNames[k]!,
      type: 'trim' as const,
      inputFeatureIds: [source] as [string],
      args: { tool: { sketchId: screens.sketch.id, elements }, keep: 'inside' as const },
    })),
    bodies: screens.chains.map((_, k) => ({
      id: f63ScreenBodies[k]!,
      name: f63ScreenNames[k]!,
      sourceFeatureId: f63ScreenBodies[k]!.replace('-body', ''),
      placementFeatureId: f63ScreenBodies[k]!.replace('-body', '-placement'),
      appearance: glass,
    })),
  });
  for (const bodyId of f63ScreenBodies)
    doc = applyCadOperation(doc, { type: 'setBodyMass', bodyId, mass: f63GlassMass });
  // The inner panel opened behind the side windows and the screens.
  const windows = doc.features.find((f) => f.id === 'windows') as Extract<
    CadFeature,
    { type: 'trim' }
  >;
  for (const [id, args] of [
    ['inner-windows', { ...windows.args, keep: 'outside' as const }],
    ['inner-screens', { tool, keep: 'outside' as const, chains: screens.chains.slice(1) }],
  ] as const)
    doc = applyCadOperation(doc, {
      type: 'detailBody',
      bodyId: 'inner-body',
      placementFeatureId: `${id}-placement`,
      feature: {
        id,
        name: id === 'inner-windows' ? 'Inner side windows' : 'Inner screens',
        type: 'trim',
        inputFeatureIds: [resultOf('inner-body')],
        args,
      } as Extract<CadFeature, { type: 'trim' }>,
    });
  return doc;
}

/** CR7g-2: the door's version with its handle (a dark plastic body of its own). */
export function f63DoorWithHandle(content: CadDocument): CadDocument {
  const h = f63Details.handle;
  return applyCadOperation(content, {
    type: 'insertFeatures',
    parameters: [],
    sketches: [],
    features: [
      {
        id: 'handle',
        name: 'Door handle',
        type: 'box',
        inputFeatureIds: [],
        args: {
          size: [mm(h.x[1] - h.x[0]), mm(h.y[1] - h.y[0]), mm(h.z[1] - h.z[0])],
          origin: position(h.x[0], h.y[0], h.z[0]),
          orientation: identityQuaternion(),
        },
      },
    ],
    bodies: [
      {
        id: 'handle-body',
        name: 'Door handle',
        sourceFeatureId: 'handle',
        placementFeatureId: 'handle-placement',
        appearance: presetLook('chrome'),
      },
    ],
  });
}

/** CR7g-2: the exhaust's tail pipe and the front and rear number plates. */
export function f63Fittings(doc: CadDocument): CadDocument {
  const x = f63Details.exhaust;
  const along: Quaternion = [0, s, 0, s]; // z along +x
  const pipe = (id: string, name: string, radius: number, x0: number, x1: number): CadFeature => ({
    id,
    name,
    type: 'cylinder',
    inputFeatureIds: [],
    args: {
      radius: mm(radius),
      height: mm(x1 - x0),
      origin: position(x0, x.y, x.z),
      orientation: along,
    },
  });
  const P = f63Details.plate;
  const B = f63Ends.bumper;
  const plate = (id: string, name: string, x0: number): CadFeature => ({
    id,
    name,
    type: 'box',
    inputFeatureIds: [],
    args: {
      size: [mm(P.thickMm), mm(2 * P.halfWidth), mm(P.z[1] - P.z[0])],
      origin: position(x0, -P.halfWidth, P.z[0]),
      orientation: identityQuaternion(),
    },
  });
  doc = applyCadOperation(doc, {
    type: 'insertFeatures',
    parameters: [],
    sketches: [],
    features: [
      pipe('exhaust-outer', 'Tail pipe', x.radius, x.x[0], x.x[1]),
      pipe('exhaust-bore', 'Tail pipe bore', x.radius - x.wallMm, x.x[0] - 5, x.x[1] + 5),
      {
        id: 'exhaust',
        name: 'Exhaust',
        type: 'boolean',
        inputFeatureIds: ['exhaust-outer', 'exhaust-bore'],
        args: { mode: 'cut' },
      } as CadFeature,
      plate('plate-front', 'Front number plate', B.front[1]),
      plate('plate-rear', 'Rear number plate', B.rear[0] - P.thickMm),
    ],
    bodies: [
      {
        id: 'exhaust-body',
        name: 'Exhaust',
        sourceFeatureId: 'exhaust',
        placementFeatureId: 'exhaust-placement',
        appearance: presetLook('chrome'),
      },
      ...(['front', 'rear'] as const).map((end) => ({
        id: `plate-${end}-body`,
        name: `${end === 'front' ? 'Front' : 'Rear'} number plate`,
        sourceFeatureId: `plate-${end}`,
        placementFeatureId: `plate-${end}-placement`,
        appearance: { ...presetLook('plastic-matte'), color: '#f4f4ef' },
      })),
    ],
  });
  for (const bodyId of ['plate-front-body', 'plate-rear-body'])
    doc = applyCadOperation(doc, {
      type: 'setBodyMass',
      bodyId,
      mass: { densityKgM3: cadMassMaterials.aluminium!, material: 'aluminium' },
    });
  return doc;
}

export function f63Car(kernel: Kernel = fixtureKernel) {
  const profile = (doc: CadDocument): CadDocument => ({
    ...doc,
    kernelProfile: { ...doc.kernelProfile, ...kernel },
  });
  const closure = new Map<string, CadDocument>();
  const version = (artifactId: string, content: CadDocument) => {
    const v = fixtureVersion(artifactId, 'v1', profile(content));
    closure.set(v.contentHash, v.content);
    return v;
  };

  // Doors and hood, both sides, made parts on their hinges: the left ones made from the F28 bodies
  // (0.7 mm steel), the right ones those parts' versions reflected in y = 0.
  // Widened (CR7g-1), its flares meet the skin G1: at this width the G2 fills miss their
  // tolerance (fill-g2-unreached). CR7g-2: F63's own side windows.
  let doc = f28B2Car({
    widthScale: f63SectionScales,
    greenhouse: f63Greenhouse,
    flareContinuity: 'G1',
    windows: f63Details.sideWindows,
  });
  // The inner panel is F25's skin offset before its arches were cut, so the wheels ran into it:
  // offset from the skin with its arches instead (CR7 fit-up).
  doc = applyCadOperation(doc, {
    type: 'updateFeature',
    featureId: 'inner',
    args: { source: { featureId: 'front-arch' }, distance: mm(20), side: 'back' },
  });
  doc = f63Glaze(f63Finish(doc));
  doc = weighed(profile(doc), 0.7);
  const deg = Math.PI / 180;
  const hingePose = (h: (typeof f28Hinges)['door']): CadSolvedPose =>
    pose(
      h.translation.map((l) => ('literalMm' in l ? l.literalMm : 0)) as Vec3,
      h.rotation as Quaternion,
    );
  const flipY = (p: CadSolvedPose): CadSolvedPose =>
    pose([p.translationMm[0], -p.translationMm[1], p.translationMm[2]], p.rotation);
  // A turn about z reflects into the opposite turn (the right door swings out towards +y); the
  // hood's hinge lies across the car, so its turn keeps its sense.
  // The doors turn about an axis ahead of and outside their front edge (CR7 fit-up): F28's
  // hinge (in the door, y −810) swings the door's front corner into the wing.
  const doorHinge = pose(f63Layout.doorHinge);
  const hinges = {
    door: { at: doorHinge, min: 0, max: 70 * deg },
    'door-r': { at: flipY(doorHinge), min: -70 * deg, max: 0 },
    hood: { at: hingePose(f28Hinges.hood), min: 0, max: 60 * deg },
    'hood-r': { at: flipY(hingePose(f28Hinges.hood)), min: 0, max: 60 * deg },
  };
  const mirrorBounds = (b: [Vec3, Vec3]): [Vec3, Vec3] => [
    [b[0][0], -b[1][1], b[0][2]],
    [b[1][0], -b[0][1], b[1][2]],
  ];
  const joints: CadJoint[] = [];
  const parts: { id: string; name: string; v: ReturnType<typeof version>; bounds: [Vec3, Vec3] }[] =
    [];
  const components: CadComponent[] = [];
  const hinge = (key: keyof typeof hinges, name: string) => {
    const h = hinges[key];
    joints.push({
      id: `j-${key}`,
      name: `${name} hinge`,
      type: 'revolute',
      parent: connector([], { origin: true }, identityPose(), h.at),
      child: {
        componentId: `c-${key}`,
        connector: connector([], { origin: true }, identityPose(), h.at),
      },
      values: { angle: { literalRad: 0 } },
      limits: [{ of: 'angle', min: h.min, max: h.max }],
    });
  };
  for (const [key, name] of [
    ['door', 'Door'],
    ['hood', 'Hood'],
  ] as const) {
    // CR7g-2: the door's version carries its handle.
    const made = bodyPartContent(doc, `${key}-body`);
    const content = key === 'door' ? weighed(f63DoorWithHandle(made), 0.7) : made;
    const hash = cadContentHash(content);
    closure.set(hash, content);
    doc = applyCadOperation(doc, {
      type: 'makePart',
      bodyId: `${key}-body`,
      part: {
        id: `part-${key}`,
        name: `${name} L`,
        source: { kind: 'version', artifactId: `b4-${key}`, versionId: 'v1', contentHash: hash },
        hint: { boundsMm: f28Bounds[key] },
      },
      component: {
        id: `c-${key}`,
        name: `${name} L`,
        partId: `part-${key}`,
        placement: { translation: position(0, 0, 0), rotation: identityQuaternion() },
        bom: 'include',
      },
    });
    hinge(key, `${name} L`);
    const right = version(`b4-${key}-r`, mirroredPart(content));
    parts.push({
      id: `part-${key}-r`,
      name: `${name} R`,
      v: right,
      bounds: mirrorBounds(f28Bounds[key]),
    });
    components.push({ ...fixtureComponent(`c-${key}-r`, `part-${key}-r`), name: `${name} R` });
    hinge(`${key}-r`, `${name} R`);
  }

  // The skin's right half: the left one's bodies reflected in y = 0.
  const mirrorOf = ['skin-body', 'inner-body', 'hatch-body', ...f63GlassBodies, ...f63ScreenBodies];
  const own = (id: string) => doc.bodies.find((b) => b.id === id)!;
  doc = applyCadOperation(doc, {
    type: 'insertFeatures',
    parameters: [],
    sketches: [],
    features: mirrorOf.map((id) => ({
      id: `${id}-r-copy`,
      name: `${own(id).name} R`,
      type: 'mirrorCopy',
      inputFeatureIds: [],
      args: {
        source: { featureId: own(id).resultFeatureId },
        plane: { origin: position(0, 0, 0), normal: [0, 1, 0] },
      },
    })),
    bodies: mirrorOf.map((id) => ({
      id: `${id}-r`,
      name: `${own(id).name} R`,
      sourceFeatureId: `${id}-r-copy`,
      placementFeatureId: `${id}-r-placement`,
      appearance: own(id).appearance,
    })),
  });
  // The right glass as the left: 4 mm glass, not the panels' steel.
  for (const id of [...f63GlassBodies, ...f63ScreenBodies])
    doc = applyCadOperation(doc, { type: 'setBodyMass', bodyId: `${id}-r`, mass: f63GlassMass });
  doc = f63Fittings(f63CloseEnds(doc));
  doc = weighed(doc, 0.7);

  // The versions placed.
  const biwDoc = weighed(f63Body());
  const biw = version('b4-biw', biwDoc);
  const headL = version('b4-headlamp-l', weighed(lampFixture('headlamp')));
  const headR = version('b4-headlamp-r', weighed(mirroredPart(lampFixture('headlamp'))));
  const tailL = version('b4-tail-l', weighed(lampFixture('tail')));
  const tailR = version('b4-tail-r', weighed(mirroredPart(lampFixture('tail'))));
  const wheel = version('b4-wheel', weighed(f60Wheel(kernel)));
  const mirrorL = version('b4-mirror-l', weighed(f61Mirror(kernel)));
  const mirrorR = version('b4-mirror-r', weighed(mirroredPart(f61Mirror(kernel))));
  const steering = version(
    'b4-steering',
    weighed(f62Steering(kernel), 0.8, { rim: 'polypropylene' }),
  );
  const seatParts = f59Seat(kernel, 'low');
  const seatClosure = new Map<string, string>();
  for (const [hash, content] of seatParts.closure) {
    const w = profile(weighed(content));
    const h = cadContentHash(w);
    closure.set(h, w);
    seatClosure.set(hash, h);
  }
  const seatDoc = weighed(seatParts.assembly);
  seatDoc.parts = seatDoc.parts.map((p) => ({
    ...p,
    source: { ...p.source, contentHash: seatClosure.get(p.source.contentHash)! },
  }));
  const seat = version('b4-seat', seatDoc);

  const box = (lo: Vec3, hi: Vec3): [Vec3, Vec3] => [lo, hi];
  parts.push(
    {
      id: 'part-biw',
      name: 'Body in white',
      v: biw,
      bounds: box([250, Y(-740), 170], [3830, Y(740), 900]),
    },
    {
      id: 'part-headlamp-l',
      name: 'Headlamp L',
      v: headL,
      bounds: box([-140, -110, -60], [30, 110, 60]),
    },
    {
      id: 'part-headlamp-r',
      name: 'Headlamp R',
      v: headR,
      bounds: box([-140, -110, -60], [30, 110, 60]),
    },
    {
      id: 'part-tail-l',
      name: 'Tail lamp L',
      v: tailL,
      bounds: box([-90, -150, -50], [20, 150, 50]),
    },
    {
      id: 'part-tail-r',
      name: 'Tail lamp R',
      v: tailR,
      bounds: box([-90, -150, -50], [20, 150, 50]),
    },
    {
      id: 'part-wheel',
      name: 'Wheel and tyre',
      v: wheel,
      bounds: box([-290, -100, -290], [290, 100, 290]),
    },
    {
      id: 'part-mirror-l',
      name: 'Door mirror L',
      v: mirrorL,
      bounds: box([0, -110, -70], [160, 110, 70]),
    },
    {
      id: 'part-mirror-r',
      name: 'Door mirror R',
      v: mirrorR,
      bounds: box([0, -110, -70], [160, 110, 70]),
    },
    {
      id: 'part-steering',
      name: 'Steering wheel',
      v: steering,
      bounds: box([-200, -200, -60], [200, 200, 60]),
    },
    { id: 'part-seat', name: 'Seat', v: seat, bounds: box([-80, -250, 0], [600, 250, 1100]) },
  );

  /**
   * A component whose part stands at `at`, joined to a face of the body in white (`face`) or
   * another component's origin (`on`): the parent connector's frame is `axis` (the face's own
   * frame when absent), the child's the same place in the part's coordinates.
   */
  const place = (
    id: string,
    name: string,
    partId: string,
    at: CadSolvedPose,
    parent: { face: F63Face } | { on: string; base: CadSolvedPose },
    joint: Pick<CadJoint, 'type' | 'values' | 'limits'> & { axis?: CadSolvedPose } = {
      type: 'fastened',
      values: {},
      limits: [],
    },
  ) => {
    components.push({
      ...fixtureComponent(id, partId, at.translationMm, at.rotation),
      name,
    });
    const base = 'face' in parent ? f63Faces[parent.face].frame : parent.base;
    const axis = joint.axis ?? base;
    joints.push({
      id: `j-${id.replace(/^c-/, '')}`,
      name: `${name} mount`,
      type: joint.type,
      parent:
        'face' in parent
          ? connector(['c-biw'], f63FaceRef(biwDoc, parent.face), base, axis)
          : connector([parent.on], { origin: true }, parent.base, axis),
      child: {
        componentId: id,
        // The same frame in the part's own coordinates.
        connector: connector(
          [],
          { origin: true },
          identityPose(),
          composePoses(invertPose(at), axis),
        ),
      },
      values: joint.values,
      limits: joint.limits,
    });
  };
  components.push({ ...fixtureComponent('c-biw', 'part-biw'), name: 'Body in white' });
  const L = f63Layout;
  for (const [side, sy] of [
    ['l', -1],
    ['r', 1],
  ] as const) {
    const up = side === 'l' ? 'L' : 'R';
    // CR7g-4 (E14): the seat slides on the floor (0–240 mm forward, F59's travel) from its mount,
    // since the seat's own slide is inside its version and is not edited from the car. 0 keeps
    // it at its rearmost slide (the H-point of CR7d).
    const seatAt: Vec3 = [L.seat.x, sy * L.seat.y, f63BodyLayout.floor.z];
    place(
      `c-seat-${side}`,
      `Seat ${up}`,
      'part-seat',
      pose(seatAt),
      { face: 'floor' },
      {
        type: 'slider',
        // z along +x: a positive distance moves the seat forward.
        axis: pose(seatAt, turn.y90),
        values: { distance: mm(0) },
        limits: [{ of: 'distance', min: f59Ranges.slide[0], max: f59Ranges.slide[1] }],
      },
    );
    place(
      `c-headlamp-${side}`,
      `Headlamp ${up}`,
      `part-headlamp-${side}`,
      pose([L.headlamp[0], sy * L.headlamp[1], L.headlamp[2]]),
      { face: 'radiator' },
    );
    // The tail lamps face back: the lamp turned about z.
    place(
      `c-tail-${side}`,
      `Tail lamp ${up}`,
      `part-tail-${side}`,
      pose([L.tail[0], sy * L.tail[1], L.tail[2]], turn.z180),
      { face: 'trunk' },
    );
    // The mirrors stand out from the doors (their x along −y on the left), on the door's origin.
    place(
      `c-mirror-${side}`,
      `Door mirror ${up}`,
      `part-mirror-${side}`,
      pose([L.mirror[0], sy * L.mirror[1], L.mirror[2]], side === 'l' ? turn.zm90 : turn.z90),
      { on: side === 'l' ? 'c-door' : 'c-door-r', base: identityPose() },
    );
    // Wheels: the hub turned about the axle (y), the right ones turned about z to face out. The
    // front ones steer about z and spin about the turned x (a universal joint).
    const A = L.axles;
    for (const [end, x] of [
      ['rear', A.rear],
      ['front', A.front],
    ] as const) {
      const centre: Vec3 = [x, sy * A.track, A.z];
      const at = pose(centre, side === 'l' ? identityQuaternion() : turn.z180);
      const face: F63Face =
        end === 'front'
          ? side === 'l'
            ? 'strutLeft'
            : 'strutRight'
          : side === 'l'
            ? 'rearLeft'
            : 'rearRight';
      const id = `c-wheel-${end}-${side}`;
      const name = `Wheel ${end} ${up}`;
      if (end === 'rear')
        place(
          id,
          name,
          'part-wheel',
          at,
          { face },
          {
            type: 'revolute',
            // z along the axle (+y).
            axis: pose(centre, turn.xm90),
            values: { angle: { literalRad: 0 } },
            limits: [],
          },
        );
      else
        place(
          id,
          name,
          'part-wheel',
          at,
          { face },
          {
            type: 'universal',
            // z up (the steering axis), x along the axle (+y).
            axis: pose(centre, turn.z90),
            values: { angle: { literalRad: 0 }, angle2: { literalRad: 0 } },
            limits: [{ of: 'angle', min: -35 * deg, max: 35 * deg }],
          },
        );
    }
  }
  // The steering wheel turns about its column (z towards the driver, −x).
  place(
    'c-steering',
    'Steering wheel',
    'part-steering',
    pose(L.steering, turn.ym90),
    { face: 'dash' },
    {
      type: 'revolute',
      axis: pose(L.steering, turn.ym90),
      values: { angle: { literalRad: 0 } },
      limits: [{ of: 'angle', min: -270 * deg, max: 270 * deg }],
    },
  );

  doc = applyCadOperation(doc, {
    type: 'insertComponents',
    parts: parts.map((p) => fixturePart(p.id, p.name, p.v, p.bounds)),
    components,
  });
  for (const joint of joints) doc = applyCadOperation(doc, { type: 'insertJoint', joint });
  return { assembly: doc, closure };
}
