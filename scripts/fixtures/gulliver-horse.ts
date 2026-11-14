/**
 * GV6b (docs/cad/gulliver-world.md): the Houyhnhnms and the Yahoos of Part IV as rigged figures,
 * from the English text (Project Gutenberg #829).
 *
 * - F121, a Houyhnhnm: the text's Houyhnhnms are horses ("a horse walking softly in the field",
 *   "the gray", "a sorrel nag"), so the figure is a horse on four legs: a box body on bones, its
 *   legs on IK chains (C5d) that put the hooves on the ground, and a four-beat walk. Its sizes are
 *   a horse of 1.6 m at the withers (創作).
 * - F122, a Yahoo: "a perfect human figure" (第4篇第2章), bare-skinned "of a brown buff colour",
 *   hair on the head (第4篇第1章), built on Gulliver's body plan at 1,700 mm (創作) with the same walk.
 *
 * The quadruped uses the product's skeleton, skin and IK chains as they are (GV-U6: nothing in
 * them assumes two legs).
 */
import {
  axisAngleQuat,
  emptyCharacter,
  type CharacterAction,
  type CharacterDocument,
  type CharacterIkChain,
  type Quat,
  type Vec3,
} from '@editor-platform/character-core';
import {
  addBoxFigure,
  addFigure,
  sideAxis,
  swingTrack,
  walkAction,
  type BoxBodyPlan,
  type FigureLook,
  type PeopleFixture,
  type PlacedFigure,
} from './gulliver-people';

/** 創作: a horse of 1,600 mm at the withers; the body plan's fractions are of this. */
export const houyhnhnmWithersMm = 1_600;
/** 創作: a Yahoo is a person (the text gives no height): 1,700 mm. */
export const yahooHeightMm = 1_700;

type HorseSlot = 'coat' | 'mane' | 'hoof' | 'muzzle';
type Side = 'L' | 'R';
const sides: [Side, number][] = [
  ['L', -1],
  ['R', 1],
];
const k = 1 / houyhnhnmWithersMm;
const v = (x: number, y: number, z: number): Vec3 => [x * k, y * k, z * k];

/** Leg joints (mm at a 1,600 mm horse): the hip or elbow, the hock or knee, the fetlock. */
const legs = {
  hind: { top: [220, -650, 1_150], mid: [220, -800, 550], low: [220, -780, 130] },
  fore: { top: [220, 560, 1_050], mid: [220, 580, 500], low: [220, 590, 130] },
} as const;

/** The horse's joints as fractions of the withers height: [bone, parent, at]. */
const horseJoints: (readonly [string, string | null, Vec3])[] = [
  ['pelvis', null, v(0, -650, 1_400)],
  ['chest', 'pelvis', v(0, 450, 1_350)],
  ['neck', 'chest', v(0, 750, 1_450)],
  ['head', 'neck', v(0, 1_150, 1_900)],
  ['tail', 'pelvis', v(0, -1_000, 1_450)],
  ...sides.flatMap(([s, x]): (readonly [string, string | null, Vec3])[] => [
    [`hind.${s}`, 'pelvis', v(x * legs.hind.top[0], legs.hind.top[1], legs.hind.top[2])],
    [`hock.${s}`, `hind.${s}`, v(x * legs.hind.mid[0], legs.hind.mid[1], legs.hind.mid[2])],
    [`hindhoof.${s}`, `hock.${s}`, v(x * legs.hind.low[0], legs.hind.low[1], legs.hind.low[2])],
    [`fore.${s}`, 'chest', v(x * legs.fore.top[0], legs.fore.top[1], legs.fore.top[2])],
    [`knee.${s}`, `fore.${s}`, v(x * legs.fore.mid[0], legs.fore.mid[1], legs.fore.mid[2])],
    [`forehoof.${s}`, `knee.${s}`, v(x * legs.fore.low[0], legs.fore.low[1], legs.fore.low[2])],
  ]),
];
/** Boxes: [bone, size, centre, slot], as fractions of the withers height. */
const horseBoxes: (readonly [string, Vec3, Vec3, HorseSlot])[] = [
  ['pelvis', v(560, 950, 620), v(0, -380, 1_150), 'coat'],
  ['pelvis', v(520, 450, 300), v(0, -650, 1_330), 'coat'],
  ['chest', v(600, 850, 660), v(0, 300, 1_150), 'coat'],
  ['chest', v(520, 300, 560), v(0, 640, 1_080), 'coat'],
  // The withers, at 1.6 m.
  ['chest', v(300, 320, 160), v(0, 450, 1_520), 'coat'],
  ['neck', v(240, 420, 620), v(0, 930, 1_640), 'coat'],
  ['neck', v(70, 380, 620), v(0, 840, 1_720), 'mane'],
  ['head', v(230, 520, 260), v(0, 1_300, 1_860), 'coat'],
  ['head', v(190, 260, 210), v(0, 1_570, 1_790), 'muzzle'],
  ['head', v(50, 60, 140), v(-70, 1_120, 2_040), 'coat'],
  ['head', v(50, 60, 140), v(70, 1_120, 2_040), 'coat'],
  ['tail', v(130, 140, 750), v(0, -1_030, 1_080), 'mane'],
  ...sides.flatMap(([s, x]): (readonly [string, Vec3, Vec3, HorseSlot])[] => [
    [`hind.${s}`, v(190, 300, 620), v(x * 220, -720, 860), 'coat'],
    [`hock.${s}`, v(110, 120, 440), v(x * 220, -790, 340), 'coat'],
    [`hindhoof.${s}`, v(140, 170, 130), v(x * 220, -770, 65), 'hoof'],
    [`fore.${s}`, v(170, 210, 560), v(x * 220, 565, 775), 'coat'],
    [`knee.${s}`, v(110, 120, 390), v(x * 220, 585, 315), 'coat'],
    [`forehoof.${s}`, v(140, 170, 130), v(x * 220, 595, 65), 'hoof'],
  ]),
];
const horsePlan: BoxBodyPlan<HorseSlot> = {
  joints: horseJoints,
  boxes: horseBoxes,
  slots: ['coat', 'mane', 'hoof', 'muzzle'],
  roughness: (slot) => (slot === 'hoof' ? 0.45 : 0.75),
};

/** 本文: "the gray" (the master's horse) and "a sorrel nag" (a servant). */
export const grayCoat: Record<HorseSlot, string> = {
  coat: '#a7a8a5',
  mane: '#e2e1dc',
  hoof: '#34302b',
  muzzle: '#5e5c58',
};
export const sorrelCoat: Record<HorseSlot, string> = {
  coat: '#9a4f25',
  mane: '#b8682f',
  hoof: '#34302b',
  muzzle: '#5a3a26',
};

/** The four legs' IK chains, by name: the hoof's bone is the tip, two bones above it. */
export const legChains = ['hind.L', 'hind.R', 'fore.L', 'fore.R'] as const;
const tipOf = (leg: (typeof legChains)[number]) => {
  const [end, s] = leg.split('.') as ['hind' | 'fore', Side];
  return `${end}hoof.${s}`;
};

/**
 * Adds a Houyhnhnm at `at` facing `facingRad`, with an IK chain on each leg (C5d) whose target is
 * its hoof's ground point at rest and whose pole bends the leg as a horse's does: the hock to the
 * rear, the knee to the front. The chains are added disabled (keys drive the walk); enabling one
 * plants that hoof.
 */
export function addHorse(
  doc: CharacterDocument,
  assets: Map<string, Uint8Array>,
  spec: {
    prefix: string;
    name: string;
    withersMm?: number;
    at?: Vec3;
    facingRad?: number;
    coat?: Record<HorseSlot, string>;
  },
): PlacedFigure {
  const h = spec.withersMm ?? houyhnhnmWithersMm;
  const f = addBoxFigure(doc, assets, horsePlan, {
    prefix: spec.prefix,
    name: spec.name,
    scaleMm: h,
    at: spec.at,
    facingRad: spec.facingRad,
    colors: spec.coat ?? grayCoat,
  });
  const c = Math.cos(f.facingRad),
    s = Math.sin(f.facingRad);
  const world = (p: Vec3): Vec3 => [
    f.at[0] + (c * p[0] - s * p[1]) * h,
    f.at[1] + (s * p[0] + c * p[1]) * h,
    f.at[2] + p[2] * h,
  ];
  const at = new Map(horseJoints.map(([b, , p]) => [b, p]));
  const skeleton = doc.skeletons.find((x) => x.id === f.bone('rig'))!;
  skeleton.ik = legChains.map((leg): CharacterIkChain => {
    const tip = tipOf(leg);
    const p = at.get(tip)!;
    const hind = leg.startsWith('hind');
    return {
      id: f.bone(`ik-${leg}`),
      name: `${hind ? 'Hind' : 'Fore'} leg ${leg.endsWith('L') ? 'left' : 'right'}`,
      tipBoneId: f.bone(tip),
      length: 2,
      target: world(p),
      pole: world([p[0], p[1] + (hind ? -0.6 : 0.6), p[2] + 0.4]),
      enabled: false,
    };
  });
  return f;
}

/**
 * A horse's walk on the spot, a four-beat gait (each hoof lifts in turn: left hind, left fore,
 * right hind, right fore) in `seconds`: the upper leg swings ±0.3 rad, the knee folds back and the
 * hock flexes as its leg swings forward, and the head nods twice a stride (創作: the angles).
 */
export function horseWalkAction(f: PlacedFigure, id = 'walk', seconds = 1.6): CharacterAction {
  const axis = sideAxis(f.facingRad);
  const w = (2 * Math.PI) / seconds;
  const phase: Record<(typeof legChains)[number], number> = {
    'hind.L': 0,
    'fore.L': 0.25,
    'hind.R': 0.5,
    'fore.R': 0.75,
  };
  const tracks = legChains.flatMap((leg) => {
    const [end, s] = leg.split('.') as ['hind' | 'fore', Side];
    const p = -2 * Math.PI * phase[leg];
    const lower = end === 'hind' ? `hock.${s}` : `knee.${s}`;
    const fold = end === 'hind' ? 0.5 : -0.8;
    return [
      swingTrack(`${id}-${leg}`, f.bone(leg), axis, seconds, 16, (t) => 0.3 * Math.sin(w * t + p)),
      swingTrack(
        `${id}-${lower}`,
        f.bone(lower),
        axis,
        seconds,
        16,
        (t) => fold * Math.max(0, Math.sin(w * t + p + Math.PI / 2)),
      ),
    ];
  });
  tracks.push(
    swingTrack(`${id}-neck`, f.bone('neck'), axis, seconds, 16, (t) => 0.06 * Math.sin(2 * w * t)),
  );
  return {
    id,
    name: 'Walk',
    duration: Math.round(seconds * 240_000),
    frameRate: { numerator: 30, denominator: 1 },
    tracks,
  };
}

/** A rotation about the figure's side axis (for poses keyed by hand). */
export const sideTurn = (f: PlacedFigure, rad: number): Quat =>
  axisAngleQuat(sideAxis(f.facingRad), rad) as Quat;

/** 本文 (第4篇第1章): skin "of a brown buff colour", thick dark hair on the head (創作: shades). */
export const yahooLook: FigureLook = {
  coat: '#b08a64',
  breeches: '#a98260',
  stockings: '#b08a64',
  shoes: '#9c7656',
  skin: '#b08a64',
  hair: '#2e2118',
};

/** F121: a Houyhnhnm, the gray, 1,600 mm at the withers, with four IK legs and a walk. */
export function f121Houyhnhnm(): PeopleFixture {
  const doc = emptyCharacter('Houyhnhnm');
  const assets = new Map<string, Uint8Array>();
  const figure = addHorse(doc, assets, { prefix: 'h', name: 'The gray' });
  doc.actions.push(horseWalkAction(figure));
  return { doc, assets, figure };
}

/** F122: a Yahoo, 1,700 mm, on Gulliver's body plan, with the same walk. */
export function f122Yahoo(): PeopleFixture {
  const doc = emptyCharacter('Yahoo');
  const assets = new Map<string, Uint8Array>();
  const figure = addFigure(doc, assets, {
    prefix: 'y',
    name: 'Yahoo',
    heightMm: yahooHeightMm,
    look: yahooLook,
  });
  doc.actions.push(walkAction(figure));
  return { doc, assets, figure };
}
