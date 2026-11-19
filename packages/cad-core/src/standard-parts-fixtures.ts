/**
 * PD4 fixtures (docs/cad/product-design.md): F153 a watch case back with its gasket groove and
 * gasket, F154 the standard parts the watch (SK-01) and car (「翔」) examples need.
 */
import { cadBuilder } from './builder';
import { fixtureKernel } from './fixtures';
import type { CadDocument, CadKernelProfile } from './model';
import {
  oRingGland,
  oRingGroove,
  standardPart,
  type CadORingGland,
  type CadStandardPart,
  type CadStandardPartSpec,
} from './standard-parts';

type Kernel = Pick<CadKernelProfile, 'id' | 'buildHash'>;

/** F153: the case back's sizes (mm) and its gasket (custom: below the ISO 3601 sections). */
export const f153Sizes = Object.freeze({
  /** The case's bore the back is pushed into, and the back's spigot. */
  bore: 30,
  spigot: 29.9,
  spigotHeight: 2,
  /** The flange that rests on the case. */
  flange: 34,
  flangeHeight: 1.2,
  gasket: { innerDiameter: 28.5, section: 0.7, custom: true },
});

/**
 * F153: a push-in watch case back (spigot under a flange, axis +Z, flange on top), its gasket
 * groove cut in the spigot's side against the case bore, and the gasket made as a standard part.
 */
export function f153CaseBack(
  kernel: Kernel = fixtureKernel,
  options: { groove?: boolean } = {},
): {
  back: CadDocument;
  gland: CadORingGland & { featureId: string };
  gasket: CadStandardPart;
} {
  const s = f153Sizes;
  const b = cadBuilder(kernel);
  const look = { color: '#c9ced3', metalness: 0.9, roughness: 0.25 };
  const spigot = b.cylinder(
    'Case back spigot',
    { radius: s.spigot / 2, height: s.spigotHeight },
    look,
  );
  const flange = b.cylinder(
    'Case back flange',
    { radius: s.flange / 2, height: s.flangeHeight, origin: [0, 0, s.spigotHeight] },
    look,
  );
  b.boolean(spigot, [flange], 'union', 'Case back');
  const groove = {
    kind: 'radial-outer' as const,
    ring: s.gasket,
    diameter: s.bore,
    z: s.spigotHeight / 2,
    name: 'Gasket groove',
  };
  // Without the cut (a reference for checks), the gland is the same, its featureId empty.
  const gland =
    options.groove === false
      ? { ...oRingGland(groove), featureId: '' }
      : oRingGroove(b, spigot, groove);
  const gasket = standardPart({ family: 'o-ring', ...s.gasket }, kernel);
  return { back: b.build().document, gland, gasket };
}

/** F154: the standard parts of the examples, by designation's spec. */
export const f154Specs: readonly CadStandardPartSpec[] = Object.freeze([
  // Watch (SK-01): movement screws, jewels for the balance, the strap's spring bars.
  { family: 'screw', standard: 'watch', size: 'M1', length: 2 },
  { family: 'screw', standard: 'ISO 1207', size: 'M1.6', length: 3 },
  { family: 'hole-jewel', hole: 0.1, diameter: 1, height: 0.2 },
  { family: 'cap-jewel', diameter: 1.2, height: 0.15 },
  { family: 'spring-bar', length: 16, diameter: 1.8 },
  { family: 'ball-bearing', code: '681' },
  // Car (「翔」): body and chassis screws, a dowel, a hub-size and a small bearing, a seal.
  { family: 'screw', standard: 'ISO 4762', size: 'M6', length: 20 },
  { family: 'screw', standard: 'ISO 4762', size: 'M8', length: 25 },
  { family: 'screw', standard: 'ISO 7045', size: 'M4', length: 10 },
  { family: 'parallel-pin', diameter: 6, length: 20 },
  { family: 'ball-bearing', code: '6204' },
  { family: 'ball-bearing', code: '6002' },
  { family: 'ball-bearing', code: '6805' },
  { family: 'o-ring', innerDiameter: 20, section: 2.65 },
]);

export function f154StandardParts(kernel: Kernel = fixtureKernel): CadStandardPart[] {
  return f154Specs.map((spec) => standardPart(spec, kernel));
}
