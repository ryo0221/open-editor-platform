/**
 * GV5c (docs/cad/gulliver-world.md): the professor's frame in the academy of Lagado (Part III
 * chapter 5) in CAD, from the English text (Project Gutenberg #829):
 *
 * F119: "It was twenty feet square, placed in the middle of the room. The superfices was composed
 * of several bits of wood, about the bigness of a die, but some larger than others. They were all
 * linked together by slender wires. These bits of wood were covered, on every square, with paper
 * pasted on them; and on these papers were written all the words of their language ... The
 * pupils, at his command, took each of them hold of an iron handle, whereof there were forty fixed
 * round the edges of the frame; and giving them a sudden turn, the whole disposition of the words
 * was entirely changed ... the engine was so contrived, that the words shifted into new places, as
 * the square bits of wood moved upside down."
 *
 * Die-sized bits filling twenty feet square would be some 90,000, and would not fit forty
 * handles; here each handle turns one row of bits on its wire, forty rows, and the bits are
 * about 120 mm (創作). Four row patterns, with bits of different lengths ("some larger than
 * others"), repeat across the frame; the handles stand at the rows' ends, alternately on the east
 * and west edges. The frame's rails and legs are the author's (創作). Every function takes the
 * kernel profile of the build that will evaluate it.
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
  type Quaternion,
} from '@editor-platform/cad-core';

type Kernel = Pick<CadKernelProfile, 'id' | 'buildHash'>;
type V3 = [number, number, number];
const foot = 304.8;

const look = (color: string, roughness = 0.85, metalness = 0): CadAppearance => ({
  color,
  opacity: 1,
  roughness,
  metalness,
});
const oak = look('#7a5634');
const paper = look('#ece3cc');
const iron = look('#3f4246', 0.45, 0.85);

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
function box(id: string, lo: V3, hi: V3): CadFeature {
  return {
    id,
    name: id,
    type: 'box',
    inputFeatureIds: [],
    args: {
      size: [mm(hi[0] - lo[0]), mm(hi[1] - lo[1]), mm(hi[2] - lo[2])],
      origin: position(...lo),
      orientation: identityQuaternion(),
    },
  };
}
function cylinder(
  id: string,
  radius: number,
  height: number,
  at: V3,
  orientation: Quaternion,
): CadFeature {
  return {
    id,
    name: id,
    type: 'cylinder',
    inputFeatureIds: [],
    args: { radius: mm(radius), height: mm(height), origin: position(...at), orientation },
  };
}
const union = (id: string, inputs: string[]): CadFeature => ({
  id,
  name: id,
  type: 'boolean',
  inputFeatureIds: inputs as [string, ...string[]],
  args: { mode: 'union' },
});
/** z along +x, and along −x. */
const zAlongX: Quaternion = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
const zAlongMinusX: Quaternion = [0, -Math.SQRT1_2, 0, Math.SQRT1_2];

export const frameSizes = {
  /** 本文: "It was twenty feet square". */
  side: 20 * foot,
  /** 本文: "forty fixed round the edges": one handle a row, forty rows (創作). */
  handles: 40,
  rows: 40,
  /** 創作: oak rails 150 mm square, the frame's top 1,000 mm from the floor. */
  rail: 150,
  top: 1_000,
  /** 創作: bits 120 mm across the row and high, 90–150 mm along it, 10 mm apart. */
  bit: 120,
  bitLengths: [90, 150] as const,
  bitGap: 10,
  /** 本文: "slender wires" (創作: 3 mm). */
  wire: 1.5,
  /** 創作: the crank: an arm 250 mm and a grip 120 mm. */
  crank: 250,
  grip: 120,
  /** 創作: four row patterns repeat. */
  patterns: 4,
} as const;

/** The inside of the frame, between the rails. */
const inside = () => frameSizes.side - 2 * frameSizes.rail;
/** Row k's centre line: y across the frame, at the rails' middle height. */
export function rowAt(k: number): V3 {
  const f = frameSizes;
  const pitch = inside() / f.rows;
  return [0, -inside() / 2 + pitch * (k + 0.5), f.top - f.rail / 2];
}

/** A row's bits along x (start, length), filling the inside, from a seeded sequence. */
export function rowBits(pattern: number): [number, number][] {
  const f = frameSizes;
  let s = 1_234 + 97 * pattern;
  const next = () => {
    s = (s * 16_807) % 2_147_483_647;
    return s / 2_147_483_647;
  };
  const out: [number, number][] = [];
  let x = -inside() / 2 + f.bitGap;
  const end = inside() / 2 - f.bitGap;
  while (x < end - f.bitLengths[0]) {
    let len = Math.round(f.bitLengths[0] + next() * (f.bitLengths[1] - f.bitLengths[0]));
    if (x + len > end) len = Math.round(end - x);
    out.push([x, len]);
    x += len + f.bitGap;
  }
  return out;
}

/** The frame: four rails on four legs, centred on the origin, its top at `frameSizes.top`. */
export function frameBody(kernel: Kernel): CadDocument {
  const f = frameSizes;
  const h = f.side / 2,
    r = f.rail,
    z1 = f.top,
    z0 = f.top - r;
  const features: CadFeature[] = [
    box('rail-s', [-h, -h, z0], [h, -h + r, z1]),
    box('rail-n', [-h, h - r, z0], [h, h, z1]),
    box('rail-w', [-h, -h + r, z0], [-h + r, h - r, z1]),
    box('rail-e', [h - r, -h + r, z0], [h, h - r, z1]),
    ...(
      [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ] as const
    ).map(([sx, sy], k) =>
      box(
        `leg-${k}`,
        [sx < 0 ? -h : h - r, sy < 0 ? -h : h - r, 0],
        [sx < 0 ? -h + r : h, sy < 0 ? -h + r : h, z0 + 1],
      ),
    ),
  ];
  features.push(
    union(
      'frame',
      features.map((x) => x.id),
    ),
  );
  return applyCadOperation(emptyCad(kernel), {
    type: 'insertFeatures',
    parameters: [],
    sketches: [],
    features,
    bodies: [newBody('frame-body', 'Frame', 'frame', oak)],
  });
}

/**
 * A row, along x through the origin: its bits (papered wood) on a wire through the rails, and an
 * iron crank at the +x end: an arm up the row's +z and a grip along x.
 */
export function rowBody(kernel: Kernel, pattern: number): CadDocument {
  const f = frameSizes;
  const b = f.bit / 2;
  const reach = f.side / 2 + 60;
  const features: CadFeature[] = [];
  const bits = rowBits(pattern);
  bits.forEach(([x, len], i) => features.push(box(`bit-${i}`, [x, -b, -b], [x + len, b, b])));
  features.push(cylinder('wire', f.wire, 2 * reach, [-reach, 0, 0], zAlongX));
  features.push(union('bits', ['wire', ...bits.map((_, i) => `bit-${i}`)]));
  features.push(
    box('crank-arm', [reach - 20, -15, -15], [reach + 10, 15, f.crank]),
    cylinder('crank-grip', 18, f.grip, [reach + 10, 0, f.crank - 20], zAlongX),
    cylinder('crank-hub', 12, 40, [reach - 30, 0, 0], zAlongX),
    union('crank', ['crank-arm', 'crank-grip', 'crank-hub']),
  );
  return applyCadOperation(emptyCad(kernel), {
    type: 'insertFeatures',
    parameters: [],
    sketches: [],
    features,
    bodies: [
      newBody('bits-body', 'Bits on the wire', 'bits', paper),
      newBody('crank-body', 'Handle', 'crank', iron),
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
 * F119: the frame with its forty rows, each on a revolute joint about its wire (`j-row-k`): a
 * half turn (π) sets its bits upside down. Even rows have their handle on the east edge, odd rows
 * on the west. `turns` gives each row's angle (default 0).
 */
export function f119Frame(kernel: Kernel, turns: (k: number) => number = () => 0) {
  const f = frameSizes;
  const frame = fixtureVersion('gv-lagado-frame', 'v1', frameBody(kernel));
  const rows = Array.from({ length: f.patterns }, (_, p) =>
    fixtureVersion(`gv-lagado-row-${p}`, 'v1', rowBody(kernel, p)),
  );
  let doc = emptyCad(kernel);
  const h = f.side / 2 + 60 + f.grip + 20;
  doc.parts = [
    fixturePart('part-frame', 'Frame', frame, [
      [-f.side / 2, -f.side / 2, 0],
      [f.side / 2, f.side / 2, f.top],
    ]),
    ...rows.map((v, p) =>
      fixturePart(`part-row-${p}`, `Row ${p + 1}`, v, [
        [-h, -f.bit / 2, -f.bit / 2],
        [h, f.bit / 2, f.crank + 20],
      ]),
    ),
  ];
  doc.components = [fixtureComponent('c-frame', 'part-frame')];
  for (let k = 0; k < f.rows; k++)
    doc.components.push(fixtureComponent(`c-row-${k}`, `part-row-${k % f.patterns}`, rowAt(k)));
  const at = (t: V3, rotation: Quaternion) => ({
    ref: { origin: true as const },
    flip: false,
    offset: { translation: position(...t), rotation },
  });
  for (let k = 0; k < f.rows; k++) {
    const joint: CadJoint = {
      id: `j-row-${k}`,
      name: `Handle ${k + 1}`,
      type: 'revolute',
      parent: { componentPath: ['c-frame'], ...at(rowAt(k), zAlongX) },
      // Odd rows are put in the other way round, so their handle is on the west edge.
      child: {
        componentId: `c-row-${k}`,
        connector: { componentPath: [], ...at([0, 0, 0], k % 2 ? zAlongMinusX : zAlongX) },
      },
      values: { angle: { literalRad: turns(k) } },
      limits: [{ of: 'angle', min: -2 * Math.PI, max: 2 * Math.PI }],
    };
    doc = applyCadOperation(doc, { type: 'insertJoint', joint });
  }
  const closure = new Map<string, CadDocument>(
    [frame, ...rows].map((v) => [v.contentHash, v.content]),
  );
  return { assembly: placed(doc, closure), versions: [frame, ...rows], closure };
}
