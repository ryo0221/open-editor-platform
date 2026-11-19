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
import type { CadPartBomValues } from './assembly';

/** PD2: the BOM values F151 gives each version of F22 (absent: F22 as it is). */
export type R2bBomValues = Partial<
  Record<'plate1' | 'plate2' | 'bolt' | 'wheel' | 'assembly', CadPartBomValues>
>;
export function r2bBom(
  kernel: Pick<CadKernelProfile, 'id' | 'buildHash'> = fixtureKernel,
  values: R2bBomValues = {},
) {
  const on = (
    doc: CadDocument,
    partNumber: string,
    description: string,
    bom?: CadPartBomValues,
  ): CadDocument => {
    const named = applyCadOperation(
      { ...doc, kernelProfile: { ...doc.kernelProfile, ...kernel } },
      { type: 'setPartProperties', partNumber, description },
    );
    return bom ? applyCadOperation(named, { type: 'setPartBomProperties', ...bom }) : named;
  };
  const plate1 = fixtureVersion(
    'plate',
    'v1',
    on(f02Plate(), 'PL-100', 'Base plate', values.plate1),
  );
  const plate2 = fixtureVersion(
    'plate',
    'v2',
    on(f02Plate(), 'PL-100', 'Base plate, rev B', values.plate2),
  );
  const bolt = fixtureVersion('bolt', 'v1', on(f03Revolve(), '=B-M8', '-M8 x 40', values.bolt));
  const wheel = fixtureVersion(
    'wheel',
    'v1',
    applyCadOperation(on(emptyCad(kernel), 'W-1', 'Wheel', values.wheel), {
      type: 'insertComponents',
      parts: [fixturePart('w-hub', 'Hub', plate1), fixturePart('w-bolt', 'Bolt "M8", long', bolt)],
      components: [
        fixtureComponent('w-hub-1', 'w-hub'),
        fixtureComponent('w-bolt-1', 'w-bolt', [20, 25, 5]),
        fixtureComponent('w-bolt-2', 'w-bolt', [60, 25, 5]),
      ],
    }),
  );
  const assembly = applyCadOperation(on(f02Plate(), 'CART-1', 'Cart', values.assembly), {
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

/**
 * F151 (docs/cad/product-design.md, PD2): F22 with every version's material, sourcing class,
 * unit cost (yen) and supplier note. The plates are aluminium (made here, rev B outsourced), the
 * bolt a steel standard part, the wheel's own assembly work 300 yen, and the cart its own 500 yen
 * of assembly work. The cart's own plate has no material of its own (its body has no density).
 */
export const f151Values = Object.freeze({
  plate1: {
    material: { name: 'aluminium', densityKgM3: 2700 },
    sourcing: 'make',
    unitCost: 1200,
    currency: 'JPY',
    supplier: 'In-house machining',
  },
  plate2: {
    material: { name: 'aluminium', densityKgM3: 2700 },
    sourcing: 'outsource',
    unitCost: 1500,
    currency: 'JPY',
    supplier: 'Plate shop "A", Osaka',
  },
  bolt: {
    material: { name: 'steel', densityKgM3: 7850 },
    sourcing: 'standard',
    unitCost: 12.5,
    currency: 'JPY',
    supplier: 'Fastener catalogue',
  },
  wheel: { sourcing: 'make', unitCost: 300, currency: 'JPY' },
  assembly: { unitCost: 500, currency: 'JPY' },
} as const satisfies Required<R2bBomValues>);
export const f151CostedBom = (kernel: Pick<CadKernelProfile, 'id' | 'buildHash'> = fixtureKernel) =>
  r2bBom(kernel, structuredClone(f151Values) as R2bBomValues);
