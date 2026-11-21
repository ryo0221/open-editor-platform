import { expect, it } from 'vitest';
import { contentHash } from '@editor-platform/artifact-core';
import { bimStarter } from '@editor-platform/bim-core';
import { cadContentHash, r2bBom } from '@editor-platform/cad-core';
import type { SourceBackedQuantity } from '@editor-platform/calculation-core';
import { geometryQuantitySources } from './index';

// Headless: the quantity sources work without any calculation (office) package.
it('reads, re-verifies and refuses forged CAD counts through the shared contract', async () => {
  const geometry = geometryQuantitySources();
  const f = r2bBom();
  const pin = {
    domain: 'cad' as const,
    artifactId: 'root',
    versionId: 'v1',
    contentHash: cadContentHash(f.assembly),
  };
  const closure = [...f.closure].map(([hash, content]) => ({ contentHash: hash, content }));
  const { root, sources } = await geometry.retainCad({ pin, content: f.assembly, closure });
  expect(root.pin).toEqual(pin);
  const rows = await geometry.cadRows(root, sources);
  const row = rows.find((r) => r.kind === 'body' && !r.path.length)!;
  const measured = await geometry.measureCad(root, sources, row.identity);
  expect(measured).toMatchObject({ unit: 'count', quality: 'cad', value: String(row.count) });
  const quantity: SourceBackedQuantity = {
    id: 'q',
    unit: measured.unit,
    value: measured.value,
    quality: measured.quality,
    source: measured.source,
    inclusion: 'include',
  };
  for (const source of sources) await geometry.verification.verifySource(source, sources);
  await expect(
    geometry.verification.verifyQuantities([quantity], sources),
  ).resolves.toBeUndefined();
  await expect(
    geometry.verification.verifyQuantities([{ ...quantity, value: '999' }], sources),
  ).rejects.toThrow('quantity-source-mismatch');
});

it('lists BIM elements and reads an analytic metric without a kernel', async () => {
  const geometry = geometryQuantitySources();
  const doc = bimStarter(),
    type = doc.types.find((t) => t.id === 't-wall-200')!;
  if (type.kind !== 'wall') throw Error('fixture');
  type.layers = [{ materialId: 'm-concrete', thicknessMm: 100 }];
  doc.elements = [
    {
      id: 'wall',
      kind: 'wall',
      typeId: type.id,
      start: { xy: [0, 0] },
      end: { xy: [3000, 0] },
      location: 'center',
      base: { level: 'l-1f', offsetMm: 0 },
      top: { heightMm: 2000 },
    },
  ];
  expect(await geometry.bimElements({ not: 'bim' })).toBeUndefined();
  const elements = await geometry.bimElements(doc);
  expect(elements).toEqual([{ id: 'wall', name: undefined, kind: 'wall' }]);
  const pin = {
    domain: 'bim' as const,
    artifactId: 'bim',
    versionId: 'v1',
    contentHash: await contentHash(doc),
  };
  const { root, sources } = await geometry.retainBim({ pin, content: doc, closure: [] });
  expect(sources.map((s) => s.key)).toContain(root.key);
  const measured = await geometry.measureBim(root, 'wall', 'grossVolume');
  expect(measured).toMatchObject({ value: '0.6', unit: 'm3', excluded: false });
  expect(measured.source.identity).toBe('wall');
});
