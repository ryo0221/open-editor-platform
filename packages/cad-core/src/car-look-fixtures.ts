/**
 * The car look process's fixtures (docs/cad/car-look-process.md). F80: the package of 「翔」, the
 * CL1 subject (an original two-seat mid-engine car), as boxes and wheels on the ground, with its
 * proportion setup (CLF3). Front axle at x = 0, the car running towards −X; y across, z up.
 */
import { f81TwoView, fixtureKernel } from './fixtures';
import type { CadSketch } from './sketch';
import { applyCadOperation, type CadNewBody } from './operations';
import {
  emptyCad,
  identityQuaternion,
  mm,
  position,
  type CadAppearance,
  type CadDocument,
  type CadFeature,
  type CadKernelProfile,
  type CadCurveSource,
} from './model';
import { defaultProportions } from './proportions';

/** F80's CL1 numbers (mm): /mnt/project-files/cad-car-look/cl1/cl1-rules.md. */
export const f80Rules = Object.freeze({
  length: 4350,
  width: 1950,
  height: 1130,
  wheelbase: 2650,
  overhang: { front: 950, rear: 750 },
  /** 245/35 R20 and 305/30 R21: section width, and the outer diameter. */
  tyre: {
    front: { width: 245, diameter: 20 * 25.4 + 2 * 0.35 * 245 },
    rear: { width: 305, diameter: 21 * 25.4 + 2 * 0.3 * 305 },
  },
  track: { front: 1680, rear: 1640 },
  clearance: 120,
  belt: 800,
});

const tyreLook: CadAppearance = { color: '#1d1f22', opacity: 1 };
const bodyLook: CadAppearance = { color: '#b8c4cf', opacity: 1 };
const glassLook: CadAppearance = { color: '#5b7086', opacity: 0.6 };
/** A quarter turn about X: a cylinder's +Z axis to −Y (`out` −1) or +Y (`out` +1). */
const across = (out: 1 | -1) =>
  [(-out * Math.SQRT1_2) as number, 0, 0, Math.SQRT1_2] as [number, number, number, number];

/** F80: the package of 「翔」 (CL2's boxes and wheels) with its proportion setup (CLF3). */
export function f80Package(
  kernel: Pick<CadKernelProfile, 'id' | 'buildHash'> = fixtureKernel,
): CadDocument {
  const r = f80Rules;
  const features: CadFeature[] = [];
  const bodies: CadNewBody[] = [];
  const add = (
    id: string,
    name: string,
    feature: CadFeature['args'],
    type: 'box' | 'cylinder',
    look: CadAppearance,
  ) => {
    features.push({ id, name, type, inputFeatureIds: [], args: feature } as CadFeature);
    bodies.push({
      id: `${id}-body`,
      name,
      sourceFeatureId: id,
      placementFeatureId: `${id}-placement`,
      appearance: look,
    });
  };
  for (const [axle, x, tyre, track] of [
    ['front', 0, r.tyre.front, r.track.front],
    ['rear', r.wheelbase, r.tyre.rear, r.track.rear],
  ] as const)
    for (const out of [1, -1] as const) {
      const side = out > 0 ? 'left' : 'right';
      add(
        `${axle}-${side}`,
        `${axle === 'front' ? 'Front' : 'Rear'} ${side} wheel`,
        {
          radius: mm(tyre.diameter / 2),
          height: mm(tyre.width),
          // The tyre's inner face; the axis points outwards.
          origin: position(x, out * (track / 2 - tyre.width / 2), tyre.diameter / 2),
          orientation: across(out),
        },
        'cylinder',
        tyreLook,
      );
    }
  const front = -r.overhang.front;
  add(
    'shell',
    'Body',
    {
      size: [mm(r.length), mm(r.width), mm(r.belt - r.clearance)],
      origin: position(front, -r.width / 2, r.clearance),
      orientation: identityQuaternion(),
    },
    'box',
    bodyLook,
  );
  // The cabin's glass, ahead of the engine behind the seats.
  add(
    'glass',
    'Glass',
    {
      size: [mm(1500), mm(1300), mm(r.height - r.belt)],
      origin: position(700, -650, r.belt),
      orientation: identityQuaternion(),
    },
    'box',
    glassLook,
  );
  const doc = applyCadOperation(emptyCad(kernel), { type: 'insertFeatures', features, bodies });
  return applyCadOperation(doc, {
    type: 'setProportions',
    proportions: defaultProportions({
      frontWheels: ['front-left-body', 'front-right-body'],
      rearWheels: ['rear-left-body', 'rear-right-body'],
      body: ['shell-body'],
      windows: ['glass-body'],
    }),
  });
}

/**
 * The CLF-s roof: F81's sphere cap (80 × 80 mm) times 17.5, over F80's glass: x 750–2150,
 * y −700–700, its crown at the roof line z 1130 and its corners near the belt (z 823).
 */
const roof = { scale: 17.5, shift: [750, -700, 430] as const };

/** A sketch scaled about the world origin and moved: its plane origin and its solved points. */
function placed(s: CadSketch, id: string, name: string): CadSketch {
  const { scale: k, shift } = roof;
  // F81's planes are placed (not on faces), at literal positions.
  if (!('origin' in s.plane)) throw new Error(`${s.id}: not a placed plane`);
  const o = s.plane.origin.map((c) => (c as { literalMm: number }).literalMm);
  return {
    ...s,
    id,
    name,
    plane: {
      orientation: s.plane.orientation,
      origin: position(o[0]! * k + shift[0], o[1]! * k + shift[1], o[2]! * k + shift[2]),
    },
    solved: Object.fromEntries(
      Object.entries(s.solved).map(([key, [u, v]]) => [key, [u * k, v * k] as [number, number]]),
    ),
  };
}

/**
 * The CLF-s sample: F80 with the roof's curves, each `u` curve drawn twice (a side arc on
 * `roof-u0`…`roof-u2` and a plan line on `roof-plan`) and the cross arcs `roof-v0`…`roof-v2`.
 * With `network` the curve network the Boundary dialog makes from them is there too.
 */
export function f80Sample(
  kernel: Pick<CadKernelProfile, 'id' | 'buildHash'> = fixtureKernel,
  network = false,
): CadDocument {
  const f81 = f81TwoView();
  const sketches = f81.sketches.map((s) => placed(s, `roof-${s.id}`, `Roof ${s.id}`));
  const doc = applyCadOperation(f80Package(kernel), {
    type: 'insertFeatures',
    parameters: [],
    sketches,
    features: [],
    bodies: [],
  });
  if (!network) return doc;
  const u: CadCurveSource[] = [0, 1, 2].map((n) => ({
    twoView: {
      side: { sketchId: `roof-u${n}`, element: 'arc' },
      plan: { sketchId: 'roof-plan', element: `l${n}` },
    },
  }));
  return applyCadOperation(doc, {
    type: 'insertFeatures',
    parameters: [],
    sketches: [],
    features: [
      {
        id: 'roof',
        name: 'Roof',
        type: 'curveNetwork',
        inputFeatureIds: [],
        args: {
          u,
          v: [0, 1, 2].map((n) => ({ sketchId: `roof-v${n}`, element: 'arc' })),
          toleranceMm: 0.01,
        },
      },
    ],
    bodies: [
      {
        id: 'roof-body',
        name: 'Roof',
        sourceFeatureId: 'roof',
        placementFeatureId: 'roof-placement',
        appearance: bodyLook,
      },
    ],
  });
}
