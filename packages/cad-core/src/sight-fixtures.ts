/**
 * F157 (docs/cad/product-design.md, PD7): three small scenes for the sight checks, far enough
 * apart that none stands in another's lines of sight.
 *
 * - A driver's two eyes (65 mm apart, 1,200 mm up, looking along +X) and two A-pillars
 *   (60 × 60 mm, 700 mm ahead, 600 mm to each side): the angle each pillar hides from both eyes.
 * - A watch seen from 250 mm above its crystal: a balance (Ø10 mm) half under a bridge, whose
 *   edge lies in the plane through the eye, so half of the balance's face is seen through the
 *   clear crystal.
 * - A lamp looking along +X with a fender 100–300 mm ahead and 100–200 mm to its right: its
 *   light turns right only atan(100/300) = 18.4° before the fender's far corner stops it.
 */
import { cadBuilder } from './builder';
import { fixtureKernel } from './fixtures';
import type { CadDocument, CadKernelProfile, Vec3 } from './model';

export const f157Eyes: Vec3[] = [
  [0, 32.5, 1200],
  [0, -32.5, 1200],
];
export const f157WatchEye: Vec3 = [0, 5000, 250];
export const f157Lamp: Vec3 = [-3000, 0, -500];

export function f157SightChecks(
  kernel: Pick<CadKernelProfile, 'id' | 'buildHash'> = fixtureKernel,
): CadDocument {
  const b = cadBuilder(kernel);
  const pillarLeft = b.box('A-pillar left', { size: [60, 60, 800], origin: [700, 600, 900] });
  const pillarRight = b.box('A-pillar right', { size: [60, 60, 800], origin: [700, -660, 900] });
  const balance = b.cylinder('Balance', { radius: 5, height: 1, origin: [0, 5000, 0] });
  // The bridge covers x < 0 over the balance; its edge x = 0 is in the plane through the eye.
  b.box('Bridge', { size: [6, 12, 0.5], origin: [-6, 4994, 3] });
  const crystal = b.cylinder(
    'Crystal',
    { radius: 15, height: 1, origin: [0, 5000, 8] },
    { color: '#ddeeff', opacity: 0.3 },
  );
  const lamp = b.box('Lamp lens', { size: [20, 20, 20], origin: [-3010, -10, -510] });
  b.box('Fender', { size: [200, 100, 100], origin: [-2900, -200, -550] });
  const doc = b.document;
  doc.sightChecks = [
    {
      id: 'pillar-left',
      name: 'Left A-pillar',
      requirement: 'RQ-21',
      measure: {
        kind: 'obstruction',
        eyes: structuredClone(f157Eyes),
        forward: [1, 0, 0],
        up: [0, 0, 1],
        fromDeg: 0,
        toDeg: 90,
        bodyIds: [pillarLeft],
      },
      max: 6,
    },
    {
      id: 'pillar-right',
      name: 'Right A-pillar',
      requirement: 'RQ-21',
      measure: {
        kind: 'obstruction',
        eyes: structuredClone(f157Eyes),
        forward: [1, 0, 0],
        up: [0, 0, 1],
        fromDeg: -90,
        toDeg: 0,
        bodyIds: [pillarRight],
      },
      max: 6,
    },
    {
      id: 'balance-seen',
      name: 'Balance through the crystal',
      requirement: 'RQ-12',
      measure: {
        kind: 'visibleFraction',
        eyes: [[...f157WatchEye]],
        targetIds: [balance],
        clearIds: [crystal],
      },
      min: 0.4,
    },
    {
      id: 'lamp-right',
      name: 'Lamp, outward',
      requirement: 'RQ-31',
      measure: {
        kind: 'visibleAngle',
        from: [...f157Lamp],
        forward: [1, 0, 0],
        up: [0, 0, 1],
        toward: 'right',
        limitDeg: 45,
        clearIds: [lamp],
      },
      min: 30,
    },
  ];
  return doc;
}
