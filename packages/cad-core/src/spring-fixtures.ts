/**
 * F155 (docs/cad/product-design.md, PD5): springs of the sample watch SK-01 and a coil, with
 * design targets on their estimates.
 *
 * - `Mainspring`: a 0.1 × 0.55 mm steel strip in SK-01's barrel (drum 5.1 mm inside, arbor core
 *   1.6 mm), drawn as 13 turns from 1.8 mm out with 0.24 mm a turn. One barrel turn lasts 8 h
 *   (centre pinion 10 → barrel 80, `trainHoursPerTurn` on SK-01), so the run time is about 65 h:
 *   the 40 h power reserve (RQ-11) passes.
 * - `Hairspring`: 0.03 × 0.2 mm, 12 turns from 0.5 mm, at a 300° amplitude.
 * - `Crown spring`: a compression coil, 0.3 mm wire on 2.4 mm, 8 turns (6 active), 0.6 mm pitch,
 *   pressed 1.0 mm.
 */
import { cadBuilder } from './builder';
import { fixtureKernel } from './fixtures';
import type { CadDocument, CadKernelProfile } from './model';

/** Spring steel (MPa). */
export const springSteel = Object.freeze({ youngsModulusMpa: 206_000, shearModulusMpa: 79_000 });

export function f155Springs(
  kernel: Pick<CadKernelProfile, 'id' | 'buildHash'> = fixtureKernel,
): CadDocument {
  const b = cadBuilder(kernel);
  b.spiralSpring('Mainspring', {
    use: 'mainspring',
    thickness: 0.1,
    height: 0.55,
    innerRadius: 1.8,
    pitch: 0.24,
    turns: 13,
    material: { youngsModulusMpa: springSteel.youngsModulusMpa },
    barrel: { innerRadius: 5.1, arborRadius: 1.6, hoursPerTurn: 8 },
  });
  b.spiralSpring('Hairspring', {
    use: 'hairspring',
    thickness: 0.03,
    height: 0.2,
    innerRadius: 0.5,
    pitch: 0.1,
    turns: 12,
    material: { youngsModulusMpa: 190_000 },
    angle: (300 * Math.PI) / 180,
    origin: [15, 0, 0],
  });
  b.coilSpring('Crown spring', {
    use: 'compression',
    wireDiameter: 0.3,
    meanDiameter: 2.4,
    pitch: 0.6,
    coils: 8,
    activeCoils: 6,
    material: springSteel,
    deflection: 1,
    origin: [0, 15, 0],
  });
  const doc = b.document;
  const feature = (name: string) => doc.features.find((f) => f.name === name)!.id;
  const [main, hair, crown] = ['Mainspring', 'Hairspring', 'Crown spring'].map(feature);
  doc.designTargets = [
    {
      id: 'power-reserve',
      name: 'Power reserve',
      requirement: 'RQ-11',
      measure: { kind: 'spring', featureId: main!, quantity: 'runHours' },
      min: 40,
    },
    {
      id: 'mainspring-stress',
      name: 'Mainspring stress fully wound',
      measure: { kind: 'spring', featureId: main!, quantity: 'fullStress' },
      max: 2000,
    },
    {
      id: 'hairspring-rate',
      name: 'Hairspring rate',
      measure: { kind: 'spring', featureId: hair!, quantity: 'rate' },
      min: 1e-5,
    },
    {
      id: 'crown-force',
      name: 'Crown spring force',
      measure: { kind: 'spring', featureId: crown!, quantity: 'workingForce' },
      min: 0.5,
      max: 2,
    },
  ];
  return doc;
}
