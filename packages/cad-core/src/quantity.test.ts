import { expect, it } from 'vitest';
import { r2bBom } from './bom-fixtures';
import { cadQuantityRows } from './quantity';
import { bomRows } from './bom';

it('ES11/13 preserves occurrence/body identity through reorder and rename, and counts patterns once', () => {
  const f = r2bBom(),
    lookup = (hash: string) => f.closure.get(hash);
  const projection = cadQuantityRows('root', f.assembly, lookup);
  const bolts = projection.rows.filter(
    (r) => r.kind === 'part' && r.reference?.artifactId === f.bolt.artifactId && !r.excluded,
  );
  const bom = bomRows(f.assembly, lookup, 'flat');
  expect(bolts.length).toBe(
    bom.find((r) => r.reference?.artifactId === f.bolt.artifactId)!.quantity,
  );
  const changed = structuredClone(f.assembly);
  changed.components.reverse();
  changed.parts.forEach((p) => (p.name = 'same name'));
  changed.bodies.forEach((b) => (b.name = 'same name'));
  const after = cadQuantityRows('root', changed, lookup);
  expect(after.rows.map((r) => r.identity).sort()).toEqual(
    projection.rows.map((r) => r.identity).sort(),
  );
  expect(projection.rows.some((r) => r.excluded)).toBe(true);
  const parent = projection.rows.find((r) => r.kind === 'assembly')!;
  expect(parent.coverage.length).toBeGreaterThan(0);
  expect(
    projection.rows.some((r) => r.kind === 'body' && parent.coverage.includes(r.identity)),
  ).toBe(true);
});
it('ES15 rejects unavailable closure and revoked source even for excluded occurrences', () => {
  const f = r2bBom();
  expect(() => cadQuantityRows('root', f.assembly, () => undefined)).toThrow(
    'quantity-missing-closure',
  );
  expect(() =>
    cadQuantityRows(
      'root',
      f.assembly,
      (h) => f.closure.get(h),
      (a) => a === 'root',
    ),
  ).toThrow('quantity-source-access-denied');
});
