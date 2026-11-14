/**
 * GV3c (docs/cad/gulliver-world.md): Gulliver and the Lilliputians as rigged figures. One body
 * plan, built at each person's own height (the joints and boxes are fractions of the height), so a
 * Lilliputian is a 146 mm person, not a 1,750 mm one shrunk by a part's scale.
 *
 * A figure faces +y (turned by `facingRad` about z); its left is −x. Its bones: hip (the root),
 * spine, head, arm/forearm/hand and thigh/shin/foot on each side. Legs and arms bend about the
 * figure's side axis (`sideAxis`), positive swinging the limb forward.
 */
import { boxMesh, encodeEpm, epmSha256, type EpmMesh } from '@editor-platform/geometry-mesh';
import {
  axisAngleQuat,
  characterAssetMediaTypes,
  multiplyQuat,
  composeMat4,
  emptyCharacter,
  identityTransform,
  invertMat4,
  type CharacterAction,
  type CharacterBone,
  type CharacterDocument,
  type CharacterKey,
  type CharacterTrack,
  type Quat,
  type Vec3,
} from '@editor-platform/character-core';

/** 第1篇第1章: "a human creature not six inches high"; Gulliver 1,750 mm at 12 : 1 gives 146 mm. */
export const gulliverHeightMm = 1750;
export const lilliputianHeightMm = 146;
/** 第2篇: Brobdingnag is Lilliput the other way round, twelve times our size: 1,750 × 12 = 21 m. */
export const brobdingnagianHeightMm = 21_000;
/** 第2篇第2章: Glumdalclitch, nine years old, "not above forty feet high" (創作: 12,000 mm). */
export const glumdalclitchHeightMm = 12_000;

export interface FigureLook {
  coat: string;
  breeches: string;
  stockings: string;
  shoes: string;
  skin: string;
  hair: string;
}
export const gulliverLook: FigureLook = {
  coat: '#3d5573',
  breeches: '#b49a6a',
  stockings: '#e8e2d2',
  shoes: '#2a2420',
  skin: '#e9c4a0',
  hair: '#5a3b22',
};
/** Lilliputian dress (創作: the text says only that it is plain, "between the Asiatic and the European"). */
/** 創作: a farmer of Brobdingnag in a working smock, and Glumdalclitch in a girl's frock. */
export const farmerLook: FigureLook = {
  coat: '#7a6a4f',
  breeches: '#4b4136',
  stockings: '#cfc5ae',
  shoes: '#3a2c20',
  skin: '#e2b893',
  hair: '#6b4a2a',
};
export const glumdalclitchLook: FigureLook = {
  coat: '#b0484f',
  breeches: '#e5dccb',
  stockings: '#f1ece0',
  shoes: '#5a3326',
  skin: '#f0cfae',
  hair: '#8a5a2b',
};
export const lilliputLooks: FigureLook[] = [
  {
    coat: '#8c2f39',
    breeches: '#3c3c46',
    stockings: '#d8d0bd',
    shoes: '#2b2622',
    skin: '#eac6a3',
    hair: '#2f2218',
  },
  {
    coat: '#2f6b4f',
    breeches: '#5b4a35',
    stockings: '#e2dccb',
    shoes: '#2b2622',
    skin: '#dcb48c',
    hair: '#6b4a2a',
  },
  {
    coat: '#c49a3a',
    breeches: '#4a3f33',
    stockings: '#e2dccb',
    shoes: '#2b2622',
    skin: '#efcfae',
    hair: '#1f1a16',
  },
  {
    coat: '#4b4f8c',
    breeches: '#7a6a52',
    stockings: '#d8d0bd',
    shoes: '#2b2622',
    skin: '#d9ad86',
    hair: '#8a6a3a',
  },
];

type Slot = keyof FigureLook;
const slots: Slot[] = ['coat', 'breeches', 'stockings', 'shoes', 'skin', 'hair'];
type Side = 'L' | 'R';
/** Joints as fractions of the height: [bone, parent, x, z] (y = 0); L is −x. */
const joints: [string, string | null, number, number][] = [
  ['hip', null, 0, 0.53],
  ['spine', 'hip', 0, 0.62],
  ['head', 'spine', 0, 0.855],
  ...(['L', 'R'] as Side[]).flatMap((s): [string, string | null, number, number][] => {
    const x = s === 'L' ? -1 : 1;
    return [
      [`arm.${s}`, 'spine', 0.12 * x, 0.815],
      [`forearm.${s}`, `arm.${s}`, 0.13 * x, 0.64],
      [`hand.${s}`, `forearm.${s}`, 0.135 * x, 0.475],
      [`thigh.${s}`, 'hip', 0.055 * x, 0.51],
      [`shin.${s}`, `thigh.${s}`, 0.055 * x, 0.285],
      [`foot.${s}`, `shin.${s}`, 0.055 * x, 0.045],
    ];
  }),
];
/** Boxes as fractions of the height: [bone, size, centre, slot]. */
const boxes: [string, Vec3, Vec3, Slot][] = [
  ['hip', [0.2, 0.12, 0.1], [0, 0, 0.535], 'breeches'],
  ['hip', [0.235, 0.15, 0.1], [0, 0, 0.6], 'coat'],
  ['spine', [0.23, 0.13, 0.22], [0, 0, 0.75], 'coat'],
  ['head', [0.04, 0.045, 0.05], [0, 0, 0.87], 'skin'],
  ['head', [0.085, 0.1, 0.11], [0, 0.005, 0.93], 'skin'],
  ['head', [0.092, 0.105, 0.03], [0, -0.004, 0.985], 'hair'],
  ...(['L', 'R'] as Side[]).flatMap((s): [string, Vec3, Vec3, Slot][] => {
    const x = s === 'L' ? -1 : 1;
    return [
      [`arm.${s}`, [0.05, 0.055, 0.18], [0.127 * x, 0, 0.73], 'coat'],
      [`forearm.${s}`, [0.045, 0.05, 0.165], [0.132 * x, 0, 0.56], 'coat'],
      [`hand.${s}`, [0.032, 0.05, 0.075], [0.135 * x, 0, 0.44], 'skin'],
      [`thigh.${s}`, [0.075, 0.085, 0.23], [0.055 * x, 0, 0.4], 'breeches'],
      [`shin.${s}`, [0.06, 0.065, 0.24], [0.055 * x, 0, 0.165], 'stockings'],
      [`foot.${s}`, [0.06, 0.13, 0.045], [0.055 * x, 0.03, 0.0225], 'shoes'],
    ];
  }),
];

/** Lengths of a figure's leg and arm segments (mm) at height h. */
export function limbLengths(h: number) {
  return { thigh: 0.225 * h, shin: 0.24 * h, hipZ: 0.51 * h, ankleZ: 0.045 * h };
}

/** The figure's side axis (its −x turned by `facingRad`): a positive turn swings a limb forward. */
export const sideAxis = (facingRad: number): Vec3 => [Math.cos(facingRad), Math.sin(facingRad), 0];
/** The direction a figure faces. */
export const forwardAxis = (facingRad: number): Vec3 => [
  -Math.sin(facingRad),
  Math.cos(facingRad),
  0,
];

export interface PlacedFigure {
  prefix: string;
  heightMm: number;
  at: Vec3;
  facingRad: number;
  /** A bone's ID in the document. */
  bone(name: string): string;
}

/**
 * GV6b: a figure's body plan as boxes on bones, at any scale: joints as `[bone, parent, at]` and
 * boxes as `[bone, size, centre, slot]`, all as fractions of `scaleMm`, in the figure's frame
 * (facing +y, left −x, z up from the ground). Every box follows its bone rigidly.
 */
export interface BoxBodyPlan<S extends string> {
  joints: readonly (readonly [string, string | null, Vec3])[];
  boxes: readonly (readonly [string, Vec3, Vec3, S])[];
  slots: readonly S[];
  roughness?: (slot: S) => number;
}

/**
 * Adds one box figure at `scaleMm` standing at `at` (its ground point) facing `facingRad`: its
 * mesh asset, materials, a part, a skeleton and a skin, every ID under `prefix`.
 */
export function addBoxFigure<S extends string>(
  doc: CharacterDocument,
  assets: Map<string, Uint8Array>,
  plan: BoxBodyPlan<S>,
  spec: {
    prefix: string;
    name: string;
    scaleMm: number;
    at?: Vec3;
    facingRad?: number;
    colors: Record<S, string>;
  },
): PlacedFigure {
  const { prefix, scaleMm: h } = spec;
  const at = spec.at ?? [0, 0, 0];
  const facing = spec.facingRad ?? 0;
  const c = Math.cos(facing),
    s = Math.sin(facing);
  const world = (p: Vec3): Vec3 => [
    at[0] + c * p[0] - s * p[1],
    at[1] + s * p[0] + c * p[1],
    at[2] + p[2],
  ];
  const id = (name: string) => `${prefix}/${name}`;
  const boneIds = plan.joints.map(([b]) => id(b));
  const pos: number[] = [],
    sizes: number[] = [],
    idx: number[] = [],
    mats: number[] = [],
    bones: number[] = [];
  for (const [bone, size, centre, slot] of plan.boxes) {
    const b = boxMesh(size.map((v) => v * h) as Vec3, [
      centre[0] * h,
      centre[1] * h,
      centre[2] * h,
    ]);
    const base = pos.length / 3;
    const boneIndex = plan.joints.findIndex(([j]) => j === bone);
    if (boneIndex < 0) throw new Error(`box on unknown bone ${bone}`);
    for (let i = 0; i < 8; i++) {
      const p = world([b.positions[3 * i]!, b.positions[3 * i + 1]!, b.positions[3 * i + 2]!]);
      pos.push(...p);
      bones.push(boneIndex);
    }
    sizes.push(...b.faceSizes);
    idx.push(...[...b.faceIndices].map((i) => i + base));
    mats.push(...[...b.faceMaterials].map(() => plan.slots.indexOf(slot)));
  }
  const v = pos.length / 3;
  const mesh: EpmMesh = {
    positions: new Float32Array(pos),
    faceSizes: new Uint32Array(sizes),
    faceIndices: new Uint32Array(idx),
    faceMaterials: new Uint16Array(mats),
    weights: {
      offsets: new Uint32Array(Array.from({ length: v + 1 }, (_, i) => i)),
      bones: new Uint16Array(bones),
      values: new Float32Array(v).fill(1),
    },
    boneIds,
    morphs: [],
  };
  const bytes = encodeEpm(mesh);
  doc.assets.push({
    id: id('mesh'),
    kind: 'mesh-epm',
    sha256: epmSha256(bytes),
    byteLength: bytes.length,
    mediaType: characterAssetMediaTypes['mesh-epm'],
  });
  assets.set(id('mesh'), bytes);
  for (const slot of plan.slots)
    doc.materials.push({
      id: id(`mat-${slot}`),
      name: `${spec.name} ${slot}`,
      color: spec.colors[slot],
      opacity: 1,
      roughness: plan.roughness?.(slot) ?? 0.8,
      metalness: 0,
      maps: {},
      doubleSided: false,
    });
  doc.parts.push({
    id: id('body'),
    name: spec.name,
    parentId: null,
    transform: identityTransform(),
    mesh: id('mesh'),
    materials: plan.slots.map((slot) => id(`mat-${slot}`)),
    visible: true,
  });
  const jointAt = new Map(
    plan.joints.map(([b, , p]) => [b, world([p[0] * h, p[1] * h, p[2] * h])]),
  );
  const bonesOut: CharacterBone[] = plan.joints.map(([b, parent]) => {
    const p = jointAt.get(b)!;
    const q = parent ? jointAt.get(parent)! : ([0, 0, 0] as Vec3);
    return {
      id: id(b),
      name: b,
      parentId: parent ? id(parent) : null,
      rest: { ...identityTransform(), translation: [p[0] - q[0], p[1] - q[1], p[2] - q[2]] },
    };
  });
  doc.skeletons.push({
    id: id('rig'),
    name: `${spec.name} rig`,
    parentPartId: null,
    bones: bonesOut,
  });
  doc.skins.push({
    id: id('skin'),
    partId: id('body'),
    skeletonId: id('rig'),
    inverseBind: plan.joints.map(([b]) => ({
      boneId: id(b),
      matrix: invertMat4(composeMat4({ ...identityTransform(), translation: jointAt.get(b)! }))!,
    })),
  });
  return { prefix, heightMm: h, at, facingRad: facing, bone: id };
}

const personPlan: BoxBodyPlan<Slot> = {
  joints: joints.map(([b, parent, x, z]) => [b, parent, [x, 0, z]] as const),
  boxes,
  slots,
  roughness: (slot) => (slot === 'shoes' ? 0.4 : 0.8),
};

/**
 * Adds one figure of `heightMm` standing at `at` (its feet's ground point) facing `facingRad`:
 * its mesh asset, materials, a part, a skeleton and a skin, every ID under `prefix`.
 */
export function addFigure(
  doc: CharacterDocument,
  assets: Map<string, Uint8Array>,
  spec: {
    prefix: string;
    name: string;
    heightMm: number;
    at?: Vec3;
    facingRad?: number;
    look: FigureLook;
  },
): PlacedFigure {
  return addBoxFigure(doc, assets, personPlan, {
    prefix: spec.prefix,
    name: spec.name,
    scaleMm: spec.heightMm,
    at: spec.at,
    facingRad: spec.facingRad,
    colors: spec.look,
  });
}

/**
 * A two-segment leg (or arm) reaching a point: the hip-to-ankle offset `forward` (along the
 * figure's facing) and `up` (along +z, negative below the hip), segment lengths `a` (thigh) and
 * `b` (shin). Returns the thigh's swing (forward positive) and the knee's bend relative to the
 * thigh (negative: the shin folds back). Out of reach, the leg straightens toward the point.
 */
export function twoBoneAngles(forward: number, up: number, a: number, b: number) {
  const d = Math.min(Math.hypot(forward, up), a + b - 1e-6);
  // The angle of the hip→ankle line from straight down, forward positive.
  const toward = Math.atan2(forward, -up);
  const atHip = Math.acos(Math.max(-1, Math.min(1, (a * a + d * d - b * b) / (2 * a * d))));
  const atKnee = Math.acos(Math.max(-1, Math.min(1, (a * a + b * b - d * d) / (2 * a * b))));
  return { thigh: toward + atHip, knee: -(Math.PI - atKnee) };
}

/** The ankle's offset from the hip for given swing angles (the inverse of `twoBoneAngles`). */
export function twoBoneReach(thigh: number, knee: number, a: number, b: number) {
  const shin = thigh + knee;
  return {
    forward: a * Math.sin(thigh) + b * Math.sin(shin),
    up: -a * Math.cos(thigh) - b * Math.cos(shin),
  };
}

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const norm = (a: V3): V3 => scale(a, 1 / Math.hypot(...a));
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const conj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
/** The shortest rotation taking unit vector `a` to unit vector `b`. */
export function rotationBetween(a: Vec3, b: Vec3): Quat {
  const c = dot(a as V3, b as V3);
  if (c < -1 + 1e-9) {
    const axis = Math.abs(a[0]) < 0.9 ? cross(a as V3, [1, 0, 0]) : cross(a as V3, [0, 1, 0]);
    return axisAngleQuat(norm(axis), Math.PI);
  }
  const x = cross(a as V3, b as V3);
  const q: Quat = [x[0], x[1], x[2], 1 + c];
  const n = Math.hypot(...q);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}
/** Rotates `v` by `q`. */
export function rotateVec(q: Quat, v: Vec3): Vec3 {
  const p = multiplyQuat(multiplyQuat(q, [v[0], v[1], v[2], 0]), conj(q));
  return [p[0], p[1], p[2]];
}

/**
 * A limb of two straight bones hanging along −z at rest (hip → knee `a`, knee → ankle `b`),
 * reaching from `root` toward `target` with its middle joint bent toward `pole`. Returns the
 * upper bone's rotation (relative to an unturned parent) and the lower bone's (relative to the
 * upper), plus the world rotation of the lower bone (for a foot kept level: its inverse) and
 * where the middle joint and the end land. Out of reach, the limb straightens toward the target.
 */
export function limbIk(root: Vec3, target: Vec3, pole: Vec3, a: number, b: number) {
  const offset = sub(target as V3, root as V3);
  const d = Math.max(Math.abs(a - b) + 1e-6, Math.min(a + b - 1e-6, Math.hypot(...offset)));
  const u = norm(offset);
  let v = sub(pole as V3, scale(u, dot(pole as V3, u)));
  if (Math.hypot(...v) < 1e-9) v = Math.abs(u[2]) < 0.9 ? cross(u, [0, 0, 1]) : cross(u, [1, 0, 0]);
  v = norm(v);
  const cosA = (a * a + d * d - b * b) / (2 * a * d);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const knee: V3 = [
    root[0] + a * (cosA * u[0] + sinA * v[0]),
    root[1] + a * (cosA * u[1] + sinA * v[1]),
    root[2] + a * (cosA * u[2] + sinA * v[2]),
  ];
  const end: V3 = [knee[0], knee[1], knee[2]];
  const toEnd = sub([root[0] + u[0] * d, root[1] + u[1] * d, root[2] + u[2] * d], knee);
  const upperDir = norm(sub(knee, root as V3));
  const lowerDir = norm(toEnd);
  end[0] += lowerDir[0] * b;
  end[1] += lowerDir[1] * b;
  end[2] += lowerDir[2] * b;
  const upper = rotationBetween([0, 0, -1], upperDir);
  const lowerWorld = multiplyQuat(rotationBetween(upperDir, lowerDir), upper);
  const lower = multiplyQuat(conj(upper), lowerWorld);
  return { upper, lower, lowerWorld, knee, end };
}
export const inverseQuat = conj;

const linear = { type: 'linear' as const };
/** A rotation track sampled from `angle(t)` about `axis`, `count` keys over `seconds`. */
export function swingTrack(
  id: string,
  bone: string,
  axis: Vec3,
  seconds: number,
  count: number,
  angle: (t: number) => number,
): CharacterTrack {
  const keys: CharacterKey[] = [];
  for (let i = 0; i <= count; i++) {
    const t = (seconds * i) / count;
    keys.push({
      id: `${id}-${i}`,
      tick: Math.round(t * 240_000),
      value: axisAngleQuat(axis, angle(t)) as Quat,
      easing: linear,
    });
  }
  return { id, target: { kind: 'bone', id: bone, property: 'rotation' }, keys };
}

/**
 * A walk on the spot (one stride each side in `seconds`): thighs ±25°, knees bending on the
 * forward swing, arms opposite. The same angles at any height: the stride follows the legs.
 */
export function walkAction(f: PlacedFigure, id = 'walk', seconds = 1.2): CharacterAction {
  const axis = sideAxis(f.facingRad);
  const swing = (phase: number) => (t: number) =>
    0.44 * Math.sin((2 * Math.PI * t) / seconds + phase);
  const bend = (phase: number) => (t: number) =>
    -0.6 * Math.max(0, Math.sin((2 * Math.PI * t) / seconds + phase + Math.PI / 2));
  return {
    id,
    name: 'Walk',
    duration: Math.round(seconds * 240_000),
    frameRate: { numerator: 30, denominator: 1 },
    tracks: [
      swingTrack(`${id}-thigh-L`, f.bone('thigh.L'), axis, seconds, 12, swing(0)),
      swingTrack(`${id}-thigh-R`, f.bone('thigh.R'), axis, seconds, 12, swing(Math.PI)),
      swingTrack(`${id}-shin-L`, f.bone('shin.L'), axis, seconds, 12, bend(0)),
      swingTrack(`${id}-shin-R`, f.bone('shin.R'), axis, seconds, 12, bend(Math.PI)),
      swingTrack(`${id}-arm-L`, f.bone('arm.L'), axis, seconds, 12, (t) => -0.6 * swing(0)(t)),
      swingTrack(
        `${id}-arm-R`,
        f.bone('arm.R'),
        axis,
        seconds,
        12,
        (t) => -0.6 * swing(Math.PI)(t),
      ),
    ],
  };
}

export interface PeopleFixture {
  doc: CharacterDocument;
  assets: Map<string, Uint8Array>;
  figure: PlacedFigure;
}

function single(name: string, heightMm: number, look: FigureLook): PeopleFixture {
  const doc = emptyCharacter(name);
  const assets = new Map<string, Uint8Array>();
  const figure = addFigure(doc, assets, { prefix: 'p', name, heightMm, look });
  doc.actions.push(walkAction(figure));
  return { doc, assets, figure };
}

/** F107: Lemuel Gulliver, 1,750 mm (the plan's assumption), with a walk. */
export const f107Gulliver = () => single('Gulliver', gulliverHeightMm, gulliverLook);
/** F108: a Lilliputian, 146 mm, built at that height (not scaled), with the same walk. */
export const f108Lilliputian = () => single('Lilliputian', lilliputianHeightMm, lilliputLooks[0]!);
/** F114: a Brobdingnagian farmer, 21 m, built at that height with the same body plan and walk. */
export const f114Brobdingnagian = () =>
  single('Brobdingnagian', brobdingnagianHeightMm, farmerLook);
/** F115: Glumdalclitch, 12 m, the same body plan and walk. */
export const f115Glumdalclitch = () =>
  single('Glumdalclitch', glumdalclitchHeightMm, glumdalclitchLook);
