import { describe, expect, it } from 'vitest';
import { fixtureComponent, fixturePart, fixtureVersion } from './assembly-fixtures';
import { assemblyStepPlan, cadStepAssemblyLimits } from './assembly-step';
import { r2bBom } from './bom-fixtures';
import { f02Plate, f03Revolve, fixtureKernel } from './fixtures';
import { emptyCad, type CadDocument } from './model';
import { applyCadOperation, cadContentHash } from './operations';

describe('STEP AP242 product plan (R2b-5, CAD52)', () => {
  const f = r2bBom();
  const lookup = (h: string) => f.closure.get(h);
  const rootHash = cadContentHash(f.assembly);

  it('writes each version once, nested assemblies as products and every copy as an instance', () => {
    const planned = assemblyStepPlan(f.assembly, rootHash, lookup, 'Cart');
    if (planned.status !== 'ok') throw new Error(planned.code);
    const { plan } = planned;
    // Placed before placing: the root's own bodies, the plates, the bolt, the wheel, the root.
    expect(plan.products.map((p) => [p.key, p.name, p.id])).toEqual([
      ['root bodies', 'Cart bodies', 'CART-1-bodies'],
      [f.plate1.contentHash, 'Plate', 'PL-100'],
      [f.plate2.contentHash, 'Plate', 'PL-100'],
      [f.bolt.contentHash, 'Bolt "M8", long', '=B-M8'],
      [f.wheel.contentHash, 'Wheel', 'W-1'],
      ['root', 'Cart', 'CART-1'],
    ]);
    const product = (key: string) => plan.products.find((p) => p.key === key)!;
    // Shapes are the versions' active bodies; a product that only places others has none.
    expect(product(f.wheel.contentHash).shape).toBeUndefined();
    expect(product('root').shape).toBeUndefined();
    expect(product('root bodies').shape?.contentHash).toBe(rootHash);
    expect(product(f.bolt.contentHash).shape?.bodies).toEqual([
      { kind: 'solid', color: f.bolt.content.bodies[0]!.appearance.color },
    ]);
    // The wheel places its hub and two bolts in its own frame, once for all four wheels.
    expect(
      product(f.wheel.contentHash).instances.map((i) => [i.product, i.pose.translationMm]),
    ).toEqual([
      [f.plate1.contentHash, [0, 0, 0]],
      [f.bolt.contentHash, [20, 25, 5]],
      [f.bolt.contentHash, [60, 25, 5]],
    ]);
    // The root: its own plate, two plates, four wheels, two bolts, the jig (STEP is the shape,
    // not the BOM), the ring's 8 and the row's 6 with their patterns' names.
    const root = product('root').instances;
    expect(root).toHaveLength(1 + 2 + 4 + 2 + 1 + 8 + 6);
    expect(root[0]).toEqual({
      product: 'root bodies',
      name: 'Cart bodies',
      pose: { translationMm: [0, 0, 0], rotation: [0, 0, 0, 1] },
    });
    const names = root.map((i) => i.name);
    expect(names).toContain('c-jig');
    expect(names.filter((n) => n.startsWith('Bolt ring '))).toHaveLength(7);
    expect(names.filter((n) => n.startsWith('Bolt row '))).toHaveLength(5);
    const row = root.filter((i) => i.name.startsWith('Bolt row ')).map((i) => i.pose.translationMm);
    expect(row[0]).toEqual([20, 400, 5]);
    expect(plan.instances).toBe(3 + root.length);
  });

  it('refuses a missing version and more products than the limit', () => {
    const missing = assemblyStepPlan(
      f.assembly,
      rootHash,
      (h) => (h === f.wheel.contentHash ? undefined : lookup(h)),
      'Cart',
    );
    expect(missing).toEqual({ status: 'refused', code: 'step-part-missing' });

    // Sub-assemblies with bodies of their own: two products each.
    const bolt = fixtureVersion('bolt', 'v1', f03Revolve());
    const count = Math.ceil(cadStepAssemblyLimits.products / 2);
    const subs = Array.from({ length: count }, (_, i) =>
      fixtureVersion(
        `sub-${i}`,
        'v1',
        applyCadOperation(
          applyCadOperation(f02Plate(), {
            type: 'setPartProperties',
            partNumber: `S-${i}`,
            description: '',
          }),
          {
            type: 'insertComponents',
            parts: [fixturePart('bolt', 'Bolt', bolt)],
            components: [fixtureComponent('bolt-1', 'bolt')],
          },
        ),
      ),
    );
    const root: CadDocument = applyCadOperation(emptyCad(fixtureKernel), {
      type: 'insertComponents',
      parts: subs.map((s, i) => fixturePart(`p-${i}`, `Sub ${i}`, s)),
      components: subs.map((_, i) => fixtureComponent(`c-${i}`, `p-${i}`, [i * 10, 0, 0])),
    });
    const closure = new Map([bolt, ...subs].map((v) => [v.contentHash, v.content]));
    expect(assemblyStepPlan(root, cadContentHash(root), (h) => closure.get(h), 'Big')).toEqual({
      status: 'refused',
      code: 'step-product-limit',
    });
  });
});
