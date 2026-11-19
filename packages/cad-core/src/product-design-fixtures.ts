/**
 * F150 (docs/cad/product-design.md, PD1): a watch case with two lugs and its design targets. The
 * lugs' inner faces are `Lug gap` apart (11.2 mm as SK-01 was first drawn); the strap needs
 * 16 mm (RQ-04), so the lug target fails until the gap is 16 mm. The case's size and mass have
 * targets of their own (RQ-02, RQ-07).
 */
import { cadBuilder } from './builder';
import { fixtureKernel } from './fixtures';
import type { CadDocument, CadKernelProfile } from './model';

export function f150LugTargets(
  kernel: Pick<CadKernelProfile, 'id' | 'buildHash'> = fixtureKernel,
  gapMm = 11.2,
): CadDocument {
  const b = cadBuilder(kernel);
  b.parameter('Lug gap', 'length', gapMm);
  const caseId = b.cylinder('Case', { radius: 20, height: 10, origin: [0, 0, 0] });
  // Each lug 2 mm thick (X), 6 mm long (Y) and 4 mm high, its inner face at ±gap/2.
  const left = b.box('Lug left', { size: [2, 6, 4], origin: ['-{Lug gap} / 2 - 2mm', 18, 3] });
  const right = b.box('Lug right', { size: [2, 6, 4], origin: ['{Lug gap} / 2', 18, 3] });
  const doc = b.document;
  // Steel (316L), on the case only: the lugs' mass is not a target here.
  for (const body of doc.bodies) if (body.id === caseId) body.mass = { densityKgM3: 8000 };
  doc.designTargets = [
    {
      id: 'lug-width',
      name: 'Lug width',
      requirement: 'RQ-04',
      measure: { kind: 'distance', a: [left], b: [right] },
      min: 15.9,
      max: 16.1,
    },
    {
      id: 'case-diameter',
      name: 'Case diameter',
      requirement: 'RQ-02',
      measure: { kind: 'extent', bodyIds: [caseId], axis: 'x' },
      max: 42,
    },
    {
      id: 'case-mass',
      name: 'Case mass',
      requirement: 'RQ-07',
      measure: { kind: 'mass', bodyIds: [caseId] },
      max: 0.12,
    },
  ];
  return doc;
}

/**
 * F152 (docs/cad/product-design.md, PD3): the centre distance of two wheels on a watch's main
 * plate, as a tolerance stack. The plate's two pivot holes sit at `Hole A x` and `Hole B x`
 * (±0.005 mm each, normal); each pivot can lie anywhere in its hole's play (`Pivot A play`,
 * `Pivot B play`, nominal 0, ±0.005 mm, uniform). The gears mesh well within 8 ±0.02 mm
 * (RQ-11). A design target reads the stack's worst-case minimum (PD1).
 */
export function f152CenterDistance(
  kernel: Pick<CadKernelProfile, 'id' | 'buildHash'> = fixtureKernel,
): CadDocument {
  const b = cadBuilder(kernel);
  const holeA = b.parameter('Hole A x', 'length', -4);
  const holeB = b.parameter('Hole B x', 'length', 4);
  const playA = b.parameter('Pivot A play', 'length', 0);
  const playB = b.parameter('Pivot B play', 'length', 0);
  b.box('Main plate', { size: [16, 8, 1], origin: [-8, -4, 0] });
  b.cylinder('Arbor A', { radius: 0.5, height: 3, origin: ['{Hole A x}', 0, 1] });
  b.cylinder('Arbor B', { radius: 0.5, height: 3, origin: ['{Hole B x}', 0, 1] });
  const doc = b.document;
  const hole = (id: string, name: string, parameterId: string, sign: 1 | -1) => ({
    id,
    name,
    source: { kind: 'parameter' as const, parameterId, lower: -0.005, upper: 0.005 },
    sign,
    distribution: 'normal' as const,
  });
  const play = (id: string, name: string, parameterId: string, sign: 1 | -1) => ({
    ...hole(id, name, parameterId, sign),
    distribution: 'uniform' as const,
  });
  doc.toleranceStacks = [
    {
      id: 'center-distance',
      name: 'Centre distance A–B',
      requirement: 'RQ-11',
      contributors: [
        hole('hole-b', 'Hole B position', holeB, 1),
        hole('hole-a', 'Hole A position', holeA, -1),
        play('play-b', 'Pivot B in its hole', playB, 1),
        play('play-a', 'Pivot A in its hole', playA, -1),
      ],
      min: 7.98,
      max: 8.02,
      runs: 100_000,
      seed: 152,
    },
  ];
  doc.designTargets = [
    {
      id: 'center-distance-min',
      name: 'Centre distance, worst case min',
      requirement: 'RQ-11',
      measure: { kind: 'tolerance-stack', stackId: 'center-distance', value: 'worst-min' },
      min: 7.98,
    },
  ];
  return doc;
}
