/**
 * F22 (docs/cad/r2b-assembly.md, R2b-3): an assembly for the BOM. It has a plate of its own,
 * two versions of one plate part, a "wheel" sub-assembly (a hub plate and two bolts) used four
 * times, two bolts of its own, a ring of 8 bolts (a circular component pattern about a vertical
 * axis), a row of 6 (a linear one) and a jig plate left out of the BOM. The bolt's description
 * starts with `-` and its name has a comma and quotes, for the CSV rules.
 */
import { fixtureComponent, fixturePart, fixtureVersion } from './assembly-fixtures';
import { f02Plate, f03Revolve, fixtureKernel } from './fixtures';
import { emptyCad, mm, position, type CadDocument, type CadKernelProfile } from './model';
import { applyCadOperation } from './operations';

export function r2bBom(kernel: Pick<CadKernelProfile, 'id' | 'buildHash'> = fixtureKernel) {
  const on = (doc: CadDocument, partNumber: string, description: string): CadDocument =>
    applyCadOperation(
      { ...doc, kernelProfile: { ...doc.kernelProfile, ...kernel } },
      { type: 'setPartProperties', partNumber, description },
    );
  const plate1 = fixtureVersion('plate', 'v1', on(f02Plate(), 'PL-100', 'Base plate'));
  const plate2 = fixtureVersion('plate', 'v2', on(f02Plate(), 'PL-100', 'Base plate, rev B'));
  const bolt = fixtureVersion('bolt', 'v1', on(f03Revolve(), '=B-M8', '-M8 x 40'));
  const wheel = fixtureVersion(
    'wheel',
    'v1',
    applyCadOperation(on(emptyCad(kernel), 'W-1', 'Wheel'), {
      type: 'insertComponents',
      parts: [fixturePart('w-hub', 'Hub', plate1), fixturePart('w-bolt', 'Bolt "M8", long', bolt)],
      components: [
        fixtureComponent('w-hub-1', 'w-hub'),
        fixtureComponent('w-bolt-1', 'w-bolt', [20, 25, 5]),
        fixtureComponent('w-bolt-2', 'w-bolt', [60, 25, 5]),
      ],
    }),
  );
  const assembly = applyCadOperation(on(f02Plate(), 'CART-1', 'Cart'), {
    type: 'insertComponents',
    parts: [
      fixturePart('part-plate-1', 'Plate', plate1),
      fixturePart('part-plate-2', 'Plate', plate2),
      fixturePart('part-wheel', 'Wheel', wheel),
      fixturePart('part-bolt', 'Bolt "M8", long', bolt),
    ],
    components: [
      fixtureComponent('c-plate-1', 'part-plate-1', [0, 100, 0]),
      fixtureComponent('c-plate-2', 'part-plate-2', [0, 200, 0]),
      ...[0, 1, 2, 3].map((i) =>
        fixtureComponent(`c-wheel-${i + 1}`, 'part-wheel', [i * 100, -100, 0]),
      ),
      fixtureComponent('c-bolt-1', 'part-bolt', [20, 125, 5]),
      fixtureComponent('c-bolt-2', 'part-bolt', [60, 125, 5]),
      { ...fixtureComponent('c-jig', 'part-plate-1', [0, 300, 0]), bom: 'exclude' as const },
      fixtureComponent('c-bolt-ring', 'part-bolt', [300, 100, 5]),
      fixtureComponent('c-bolt-row', 'part-bolt', [0, 400, 5]),
    ],
  });
  const ring = applyCadOperation(assembly, {
    type: 'insertComponentPattern',
    pattern: {
      id: 'p-ring',
      name: 'Bolt ring',
      seedComponentId: 'c-bolt-ring',
      layout: {
        type: 'circular',
        axisOrigin: position(250, 100, 0),
        axisDirection: [0, 0, 1],
        count: { literal: 8 },
        angle: { literalRad: Math.PI / 4 },
      },
    },
  });
  const patterned = applyCadOperation(ring, {
    type: 'insertComponentPattern',
    pattern: {
      id: 'p-row',
      name: 'Bolt row',
      seedComponentId: 'c-bolt-row',
      layout: { type: 'linear', direction: [1, 0, 0], count: { literal: 6 }, spacing: mm(20) },
    },
  });
  const closure = new Map(
    [plate1, plate2, bolt, wheel].map((v) => [v.contentHash, v.content] as const),
  );
  return { plate1, plate2, bolt, wheel, assembly: patterned, closure };
}
