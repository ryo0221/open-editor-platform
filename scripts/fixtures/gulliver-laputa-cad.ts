/**
 * GV5a (docs/cad/gulliver-world.md): the flying island of Laputa in CAD, at true size, from the
 * English text (Project Gutenberg #829, Part III chapter 3).
 *
 * - F116 the island: "exactly circular, its diameter 7837 yards ... three hundred yards thick. The
 *   bottom, or under surface ... is one even regular plate of adamant, shooting up to the height
 *   of about two hundred yards. Above it lie the several minerals in their usual order, and over
 *   all is a coat of rich mould, ten or twelve feet deep. The declivity of the upper surface, from
 *   the circumference to the centre ..."; "four large basins, each of about half a mile in
 *   circuit, and two hundred yards distant from the centre"; "At the centre of the island there
 *   is a chasm about fifty yards in diameter, whence the astronomers descend into a large dome
 *   ... situated at the depth of a hundred yards beneath the upper surface of the adamant". Its
 *   sides are "encompassed with several gradations of galleries, and stairs, at certain
 *   intervals, to descend from one to the other" (第3篇第1章).
 * - F117 the island with its loadstone: "in shape resembling a weaver's shuttle ... in length six
 *   yards, and in the thickest part at least three yards over ... sustained by a very strong axle
 *   of adamant passing through its middle, upon which it plays ... hooped round with a hollow
 *   cylinder of adamant, four feet deep, as many thick, and twelve yards in diameter, placed
 *   horizontally, and supported by eight adamantine feet, each six yards high. In the middle of
 *   the concave side, there is a groove twelve inches deep, in which the extremities of the axle
 *   are lodged, and turned round as there is occasion." (The Gutenberg text drops "deep, as many
 *   thick, and twelve" from this sentence: "four feet yards in diameter".) An assembly: the island,
 *   the hoop on its feet, the axle turning in the groove (a revolute joint about the vertical) and
 *   the stone turning on the axle (a revolute joint about the axle).
 *
 * The declivity, the galleries and stairs, the dome's size, the basins' depth and the axle's
 * thickness are the author's (創作). Every function takes the kernel profile of the build that
 * will evaluate it, since content hashes include it.
 */
import {
  applyCadOperation,
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
  type CadJoint,
  type CadKernelProfile,
  type CadNewBody,
  type CadSketch,
  type Quaternion,
} from '@editor-platform/cad-core';

type Kernel = Pick<CadKernelProfile, 'id' | 'buildHash'>;
type V3 = [number, number, number];
const inch = 25.4;
const foot = 304.8;
const yard = 914.4;
const mile = 1_609_344;

const look = (color: string, roughness = 0.85, metalness = 0, opacity = 1): CadAppearance => ({
  color,
  opacity,
  roughness,
  metalness,
});
const adamant = look('#c9d3dc', 0.25, 0.2);
const minerals = look('#7a6a58');
const mould = look('#5f7f45');
const water = look('#3f7aa6', 0.1, 0, 0.75);
const stone = look('#a59a88');
const lodestone = look('#2c2e33', 0.45, 0.6);
const lodestoneRed = look('#5a2a2a', 0.45, 0.6);

const newBody = (
  id: string,
  name: string,
  source: string,
  appearance: CadAppearance,
): CadNewBody => ({
  id,
  name,
  sourceFeatureId: source,
  placementFeatureId: `${id}-placement`,
  appearance,
});
const boolean = (id: string, mode: 'union' | 'cut', inputs: [string, ...string[]]): CadFeature => ({
  id,
  name: id,
  type: 'boolean',
  inputFeatureIds: inputs,
  args: { mode },
});
function cylinder(
  id: string,
  radius: number,
  height: number,
  at: V3,
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
function box(
  id: string,
  size: V3,
  at: V3,
  orientation: Quaternion = identityQuaternion(),
): CadFeature {
  return {
    id,
    name: id,
    type: 'box',
    inputFeatureIds: [],
    args: { size: [mm(size[0]), mm(size[1]), mm(size[2])], origin: position(...at), orientation },
  };
}
/** z along +x: an axle's frame. */
const zAlongX: Quaternion = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
/** The xz plane: sketch x → world x, sketch y → world z (so a turn about sketch y is about z). */
const xzPlane: Quaternion = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];

/** A closed polygon sketch on a plane through `origin`. */
function polygon(
  id: string,
  origin: V3,
  orientation: Quaternion,
  corners: [number, number][],
): CadSketch {
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
  return {
    id,
    name: id,
    plane: { origin: position(...origin), orientation },
    entities,
    constraints: [],
    solved,
  };
}
/** A whole turn of a sketch's region about the sketch's y axis. */
function revolve(id: string, sketch: CadSketch): CadFeature {
  return {
    id,
    name: id,
    type: 'revolve',
    inputFeatureIds: [],
    args: {
      sketchId: sketch.id,
      region: {
        outer: sketch.entities.filter((e) => e.type === 'line').map((e) => e.id),
        holes: [],
      },
      axisOrigin: [mm(0), mm(0)],
      axisDirection: [0, 1],
      angle: { literalRad: 2 * Math.PI },
    },
  };
}

/** The island (F116 / F117). Lengths in mm; z = 0 is the island's under surface. */
export const islandSizes = {
  /** 本文: "its diameter 7837 yards, or about four miles and a half". */
  diameter: 7_837 * yard,
  /** 本文: "three hundred yards thick". */
  thickness: 300 * yard,
  /** 本文: the adamant "shooting up to the height of about two hundred yards". */
  adamant: 200 * yard,
  /** 本文: "a coat of rich mould, ten or twelve feet deep" (11 ft). */
  mould: 11 * foot,
  /** 創作: the upper surface falls 30 m from the rim to the centre (本文: "declivity"). */
  declivity: 30_000,
  /** 本文: four basins "each of about half a mile in circuit, and two hundred yards distant from the centre". */
  basinCircuit: 0.5 * mile,
  basinFromCentre: 200 * yard,
  /** 創作: the basins are 6 m deep. */
  basinDepth: 6_000,
  /** 本文: "a chasm about fifty yards in diameter". */
  chasm: 50 * yard,
  /** 本文: the dome "at the depth of a hundred yards beneath the upper surface of the adamant". */
  caveDepth: 100 * yard,
  /** 創作: the dome is 80 m across, its walls 12 m high under a half sphere. */
  caveRadius: 40_000,
  caveWall: 12_000,
  /** 創作: six galleries round the side, 12 m deep and 2 m thick, every 40 m from the top. */
  galleries: 6,
  galleryDepth: 12_000,
  gallerySlab: 2_000,
  galleryPitch: 40_000,
  /** 創作: stairs between the galleries every 45°, 4 m wide, at 35°. */
  stairs: 8,
  stairWidth: 4_000,
  stairSlope: (35 * Math.PI) / 180,
} as const;

export const loadstoneSizes = {
  /** 本文: "in length six yards, and in the thickest part at least three yards over". */
  length: 6 * yard,
  thickest: 3 * yard,
  /** 本文: the hoop "four feet deep, as many thick, and twelve yards in diameter". */
  hoopDiameter: 12 * yard,
  hoopDepth: 4 * foot,
  hoopThick: 4 * foot,
  /** 本文: "eight adamantine feet, each six yards high". */
  feet: 8,
  footHeight: 6 * yard,
  /** 創作: the feet are 1 m across. */
  footRadius: 500,
  /** 本文: "a groove twelve inches deep" in the middle of the concave side. */
  groove: 12 * inch,
  /** 創作: the axle is 600 mm thick; the groove 700 mm high. */
  axleRadius: 300,
  grooveHeight: 700,
} as const;

/** The upper surface's height at a radius r (it falls toward the centre). */
export function surfaceZ(r: number): number {
  const s = islandSizes;
  return s.thickness - s.declivity * (1 - r / (s.diameter / 2));
}
/** The cave's floor above the under surface. */
export const caveFloorZ = (): number => islandSizes.adamant - islandSizes.caveDepth;
/** The four basins' centres (at 45°, 135°, 225°, 315°) and radius. */
export function basins(): { at: [number, number]; radius: number }[] {
  const s = islandSizes;
  const radius = s.basinCircuit / (2 * Math.PI);
  return [1, 3, 5, 7].map((k) => {
    const a = (k * Math.PI) / 4;
    return { at: [s.basinFromCentre * Math.cos(a), s.basinFromCentre * Math.sin(a)], radius };
  });
}
/** Gallery k's top (0 is the highest). */
export const galleryTopZ = (k: number): number =>
  islandSizes.thickness - 10_000 - k * islandSizes.galleryPitch;

/** F116: the island, centred on the z axis, its under surface at z = 0. */
export function f116Island(kernel: Kernel): CadDocument {
  const s = islandSizes;
  const R = s.diameter / 2;
  const top0 = surfaceZ(0);
  const sketches: CadSketch[] = [
    polygon('adamant-profile', [0, 0, 0], xzPlane, [
      [0, 0],
      [R, 0],
      [R, s.adamant],
      [0, s.adamant],
    ]),
    // The minerals up to the mould's underside, which follows the declivity.
    polygon('minerals-profile', [0, 0, 0], xzPlane, [
      [0, s.adamant],
      [R, s.adamant],
      [R, s.thickness - s.mould],
      [0, top0 - s.mould],
    ]),
    polygon('mould-profile', [0, 0, 0], xzPlane, [
      [0, top0 - s.mould],
      [R, s.thickness - s.mould],
      [R, s.thickness],
      [0, top0],
    ]),
    // The dome: walls then a half sphere (a 12-step arc), as a turned profile.
    polygon('cave-profile', [0, 0, 0], xzPlane, [
      [0, caveFloorZ()],
      [s.caveRadius, caveFloorZ()],
      [s.caveRadius, caveFloorZ() + s.caveWall],
      ...Array.from({ length: 11 }, (_, i): [number, number] => {
        const a = ((i + 1) * Math.PI) / 2 / 12;
        return [s.caveRadius * Math.cos(a), caveFloorZ() + s.caveWall + s.caveRadius * Math.sin(a)];
      }),
      [0, caveFloorZ() + s.caveWall + s.caveRadius],
    ]),
  ];
  const features: CadFeature[] = [
    revolve('adamant-turn', sketches[0]!),
    revolve('minerals-turn', sketches[1]!),
    revolve('mould-turn', sketches[2]!),
    revolve('cave', sketches[3]!),
    // The chasm, from above the surface down into the dome's top.
    cylinder('chasm', s.chasm / 2, s.thickness + 10_000 - (caveFloorZ() + s.caveWall), [
      0,
      0,
      caveFloorZ() + s.caveWall,
    ]),
    cylinder('chasm-2', s.chasm / 2, s.thickness + 10_000 - (caveFloorZ() + s.caveWall), [
      0,
      0,
      caveFloorZ() + s.caveWall,
    ]),
    cylinder('chasm-3', s.chasm / 2, s.thickness + 10_000 - (caveFloorZ() + s.caveWall), [
      0,
      0,
      caveFloorZ() + s.caveWall,
    ]),
    boolean('adamant', 'cut', ['adamant-turn', 'cave', 'chasm']),
  ];
  const basinTools: string[] = [];
  const mineralTools: string[] = [];
  const bodies: CadNewBody[] = [
    newBody('adamant-body', 'Adamant', 'adamant', adamant),
    newBody('minerals-body', 'Minerals', 'minerals', minerals),
  ];
  basins().forEach((b, k) => {
    const floor = surfaceZ(Math.hypot(...b.at)) - s.basinDepth;
    features.push(
      cylinder(`basin-${k}`, b.radius, s.basinDepth + 2 * s.declivity, [b.at[0], b.at[1], floor]),
    );
    basinTools.push(`basin-${k}`);
    // The basins are deeper than the mould: the same hollow is cut from the minerals.
    features.push(
      cylinder(`basin-${k}-minerals`, b.radius, s.basinDepth + 2 * s.declivity, [
        b.at[0],
        b.at[1],
        floor,
      ]),
    );
    mineralTools.push(`basin-${k}-minerals`);
    // The water, 1 m below the brim.
    features.push(
      cylinder(`water-${k}`, b.radius - 50, s.basinDepth - 1_000, [b.at[0], b.at[1], floor]),
    );
    bodies.push(newBody(`water-${k}-body`, `Basin ${k + 1}`, `water-${k}`, water));
  });
  features.push(
    boolean('minerals', 'cut', ['minerals-turn', 'chasm-2', ...mineralTools] as [
      string,
      ...string[],
    ]),
    boolean('mould', 'cut', ['mould-turn', 'chasm-3', ...basinTools] as [string, ...string[]]),
  );
  bodies.push(newBody('mould-body', 'Mould', 'mould', mould));

  // The galleries: rings round the side, turned from a rectangle.
  for (let k = 0; k < s.galleries; k++) {
    const top = galleryTopZ(k);
    const p = polygon(`gallery-${k}-profile`, [0, 0, 0], xzPlane, [
      [R - 1, top - s.gallerySlab],
      [R + s.galleryDepth, top - s.gallerySlab],
      [R + s.galleryDepth, top],
      [R - 1, top],
    ]);
    sketches.push(p);
    features.push(revolve(`gallery-${k}`, p));
    bodies.push(newBody(`gallery-${k}-body`, `Gallery ${k + 1}`, `gallery-${k}`, stone));
  }
  // The stairs: a flight from each gallery down to the next, every 45°, along the side.
  const run = s.galleryPitch / Math.tan(s.stairSlope);
  for (let k = 0; k + 1 < s.galleries; k++)
    for (let j = 0; j < s.stairs; j++) {
      const a = (2 * Math.PI * (j + 0.5 * (k % 2))) / s.stairs;
      // The flight: its local x up the slope along the tangent, y inward, z the slab's normal.
      const t: V3 = [-Math.sin(a), Math.cos(a), 0];
      const out: V3 = [Math.cos(a), Math.sin(a), 0];
      const [cs, sn] = [Math.cos(s.stairSlope), Math.sin(s.stairSlope)];
      const x: V3 = [cs * t[0], cs * t[1], sn];
      const z: V3 = [-sn * t[0], -sn * t[1], cs];
      const q = frameQuat(x, [-out[0], -out[1], 0], z);
      const radial = R + s.galleryDepth / 2 + s.stairWidth / 2;
      const thick = 1_000;
      const foot: V3 = [
        radial * out[0] - thick * z[0],
        radial * out[1] - thick * z[1],
        galleryTopZ(k + 1) - thick * z[2],
      ];
      const len = Math.hypot(run, s.galleryPitch);
      features.push(box(`stair-${k}-${j}`, [len, s.stairWidth, thick], foot, q));
      bodies.push(
        newBody(`stair-${k}-${j}-body`, `Stair ${k + 1}.${j + 1}`, `stair-${k}-${j}`, stone),
      );
    }
  return applyCadOperation(emptyCad(kernel), {
    type: 'insertFeatures',
    parameters: [],
    sketches,
    features,
    bodies,
  });
}

/** The rotation whose columns are the unit axes x, y, z (right-handed), as a quaternion. */
function frameQuat(x: V3, y: V3, z: V3): Quaternion {
  const [m00, m10, m20] = x,
    [m01, m11, m21] = y,
    [m02, m12, m22] = z;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const S = Math.sqrt(tr + 1) * 2;
    return [(m21 - m12) / S, (m02 - m20) / S, (m10 - m01) / S, 0.25 * S];
  }
  if (m00 > m11 && m00 > m22) {
    const S = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return [0.25 * S, (m01 + m10) / S, (m02 + m20) / S, (m21 - m12) / S];
  }
  if (m11 > m22) {
    const S = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return [(m01 + m10) / S, 0.25 * S, (m12 + m21) / S, (m02 - m20) / S];
  }
  const S = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return [(m02 + m20) / S, (m12 + m21) / S, 0.25 * S, (m10 - m01) / S];
}

/** The axle's height above the cave floor: the hoop's middle. */
export const axleZ = (): number => loadstoneSizes.footHeight + loadstoneSizes.hoopDepth / 2;

/** The hoop on its eight feet, the cave floor at z = 0, centred on the z axis. */
export function hoopAndFeet(kernel: Kernel): CadDocument {
  const l = loadstoneSizes;
  const Ro = l.hoopDiameter / 2,
    Ri = Ro - l.hoopThick;
  const z0 = l.footHeight;
  const hoop = polygon('hoop-profile', [0, 0, 0], xzPlane, [
    [Ri, z0],
    [Ro, z0],
    [Ro, z0 + l.hoopDepth],
    [Ri, z0 + l.hoopDepth],
  ]);
  const zg = axleZ() - l.grooveHeight / 2;
  const groove = polygon('groove-profile', [0, 0, 0], xzPlane, [
    [Ri - 10, zg],
    [Ri + l.groove, zg],
    [Ri + l.groove, zg + l.grooveHeight],
    [Ri - 10, zg + l.grooveHeight],
  ]);
  const features: CadFeature[] = [revolve('hoop-turn', hoop), revolve('groove', groove)];
  const legs: string[] = [];
  for (let k = 0; k < l.feet; k++) {
    const a = (2 * Math.PI * k) / l.feet;
    const r = (Ro + Ri) / 2;
    features.push(
      cylinder(`foot-${k}`, l.footRadius, z0 + 1, [r * Math.cos(a), r * Math.sin(a), 0]),
    );
    legs.push(`foot-${k}`);
  }
  features.push(
    boolean('hoop-cut', 'cut', ['hoop-turn', 'groove']),
    boolean('hoop', 'union', ['hoop-cut', ...legs] as [string, ...string[]]),
  );
  return applyCadOperation(emptyCad(kernel), {
    type: 'insertFeatures',
    parameters: [],
    sketches: [hoop, groove],
    features,
    bodies: [newBody('hoop-body', 'Hoop and feet', 'hoop', adamant)],
  });
}

/** The axle of adamant, along x through the origin, its ends in the groove. */
export function axle(kernel: Kernel): CadDocument {
  const l = loadstoneSizes;
  const half = l.hoopDiameter / 2 - l.hoopThick + l.groove - 20;
  return applyCadOperation(emptyCad(kernel), {
    type: 'insertFeatures',
    parameters: [],
    sketches: [],
    features: [cylinder('axle', l.axleRadius, 2 * half, [-half, 0, 0], zAlongX)],
    bodies: [newBody('axle-body', 'Axle', 'axle', adamant)],
  });
}

/**
 * The loadstone: a weaver's shuttle along z, centred on the origin. Its +z half (the attracting
 * end, c) is dark grey; its −z half (the repelling end, d) dark red.
 */
export function loadstone(kernel: Kernel): CadDocument {
  const l = loadstoneSizes;
  const h = l.length / 2,
    r = l.thickest / 2;
  // Sketch in the xz plane: sketch y is world z, the turn is about z.
  const half = (id: string, s: 1 | -1) =>
    polygon(
      id,
      [0, 0, 0],
      xzPlane,
      s > 0
        ? [
            [0, 0],
            [r, 0],
            [0.92 * r, 0.3 * h],
            [0.66 * r, 0.6 * h],
            [0.3 * r, 0.88 * h],
            [0, h],
          ]
        : [
            [0, -h],
            [0.3 * r, -0.88 * h],
            [0.66 * r, -0.6 * h],
            [0.92 * r, -0.3 * h],
            [r, 0],
            [0, 0],
          ],
    );
  const c = half('attracting-profile', 1),
    d = half('repelling-profile', -1);
  return applyCadOperation(emptyCad(kernel), {
    type: 'insertFeatures',
    parameters: [],
    sketches: [c, d],
    features: [revolve('attracting', c), revolve('repelling', d)],
    bodies: [
      newBody('attracting-body', 'Attracting end (c)', 'attracting', lodestone),
      newBody('repelling-body', 'Repelling end (d)', 'repelling', lodestoneRed),
    ],
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
 * F117: the island with its loadstone. The hoop stands on the cave floor; joint `j-axle` turns the
 * axle about the vertical (its yaw, 0 = along x); joint `j-stone` turns the stone on the axle (its
 * tilt: 0 = erect with the attracting end c up, π/2 = parallel to the horizon).
 */
export function f117Laputa(kernel: Kernel, pose: { yawRad?: number; tiltRad?: number } = {}) {
  const s = islandSizes,
    l = loadstoneSizes;
  const island = fixtureVersion('gv-laputa-island', 'v1', f116Island(kernel));
  const hoop = fixtureVersion('gv-laputa-hoop', 'v1', hoopAndFeet(kernel));
  const ax = fixtureVersion('gv-laputa-axle', 'v1', axle(kernel));
  const stone = fixtureVersion('gv-laputa-loadstone', 'v1', loadstone(kernel));
  const R = s.diameter / 2 + s.galleryDepth;
  const Ro = l.hoopDiameter / 2;
  let doc = emptyCad(kernel);
  doc.parts = [
    fixturePart('part-island', 'Island', island, [
      [-R, -R, 0],
      [R, R, s.thickness],
    ]),
    fixturePart('part-hoop', 'Hoop', hoop, [
      [-Ro, -Ro, 0],
      [Ro, Ro, l.footHeight + l.hoopDepth],
    ]),
    fixturePart('part-axle', 'Axle', ax, [
      [-Ro, -l.axleRadius, -l.axleRadius],
      [Ro, l.axleRadius, l.axleRadius],
    ]),
    fixturePart('part-stone', 'Loadstone', stone, [
      [-l.thickest / 2, -l.thickest / 2, -l.length / 2],
      [l.thickest / 2, l.thickest / 2, l.length / 2],
    ]),
  ];
  const floor = caveFloorZ();
  doc.components = [
    fixtureComponent('c-island', 'part-island'),
    fixtureComponent('c-hoop', 'part-hoop', [0, 0, floor]),
    fixtureComponent('c-axle', 'part-axle', [0, 0, floor + axleZ()]),
    fixtureComponent('c-stone', 'part-stone', [0, 0, floor + axleZ()]),
  ];
  const at = (t: V3, rotation: Quaternion = identityQuaternion()) => ({
    ref: { origin: true as const },
    flip: false,
    offset: { translation: position(...t), rotation },
  });
  const turnAxle: CadJoint = {
    id: 'j-axle',
    name: 'Axle in the groove',
    type: 'revolute',
    parent: { componentPath: ['c-hoop'], ...at([0, 0, axleZ()]) },
    child: { componentId: 'c-axle', connector: { componentPath: [], ...at([0, 0, 0]) } },
    values: { angle: { literalRad: pose.yawRad ?? 0 } },
    limits: [{ of: 'angle', min: -Math.PI, max: Math.PI }],
  };
  const turnStone: CadJoint = {
    id: 'j-stone',
    name: 'Stone on the axle',
    type: 'revolute',
    parent: { componentPath: ['c-axle'], ...at([0, 0, 0], zAlongX) },
    child: { componentId: 'c-stone', connector: { componentPath: [], ...at([0, 0, 0], zAlongX) } },
    values: { angle: { literalRad: pose.tiltRad ?? 0 } },
    limits: [{ of: 'angle', min: -Math.PI, max: Math.PI }],
  };
  doc = applyCadOperation(doc, { type: 'insertJoint', joint: turnAxle });
  doc = applyCadOperation(doc, { type: 'insertJoint', joint: turnStone });
  const closure = new Map<string, CadDocument>(
    [island, hoop, ax, stone].map((v) => [v.contentHash, v.content]),
  );
  return { assembly: placed(doc, closure), versions: [island, hoop, ax, stone], closure };
}
