import { expect, it } from 'vitest';
import { r2bBom, cadContentHash } from '@editor-platform/cad-core';
import { pinKey } from '@editor-platform/calculation-core';
import {
  createEstimate,
  makeEstimateBasis,
  evaluateEstimate,
  verifyEstimate,
} from '@editor-platform/estimate-core';
import {
  retainCadSource,
  cadSourceProjection,
  cadQuantity,
  cadQuantityVerification,
} from './cad-source';
it('ES11/12/15 retains exact CAD closure, verifies quantities and rejects hash/value/coverage forgery', async () => {
  const f = r2bBom(),
    pin = {
      domain: 'cad' as const,
      artifactId: 'root',
      versionId: 'v1',
      contentHash: cadContentHash(f.assembly),
    };
  const sources = await retainCadSource(pin, f.assembly, (h) => f.closure.get(h)),
    root = sources.find((s) => s.key === pinKey(pin))!;
  const row = cadSourceProjection(root, sources).rows.find(
    (r) => r.kind === 'body' && !r.path.length,
  )!;
  const doc = createEstimate();
  doc.retainedSources = sources;
  doc.quantities = [cadQuantity(root, sources, row.identity, 'material')];
  await expect(
    verifyEstimate(doc, undefined, false, cadQuantityVerification),
  ).resolves.toBeDefined();
  await expect(verifyEstimate(doc)).rejects.toThrow('quantity-verifier-required');
  const forged = structuredClone(doc);
  forged.quantities[0].value = '999';
  await expect(verifyEstimate(forged, undefined, false, cadQuantityVerification)).rejects.toThrow(
    'quantity-source-mismatch',
  );
  const tampered = structuredClone(doc);
  tampered.retainedSources.find((s) => s.key === root.key)!.nativeContent = {};
  await expect(
    verifyEstimate(tampered, undefined, false, cadQuantityVerification),
  ).rejects.toThrow();
  const parent = cadSourceProjection(root, sources).rows.find((r) => r.kind === 'assembly')!;
  const child = cadSourceProjection(root, sources).rows.find(
    (r) => r.kind === 'body' && parent.coverage.includes(r.identity),
  )!;
  doc.quantities = [
    cadQuantity(root, sources, parent.identity, 'parent'),
    cadQuantity(root, sources, child.identity, 'child'),
  ];
  doc.rates = [
    {
      id: 'price',
      name: 'Price',
      unitPrice: '1',
      perUnit: 'count',
      currency: 'JPY',
      evidence: 'fixture',
    },
  ];
  doc.lines = doc.quantities.map((q) => ({
    id: q.id,
    name: q.name,
    category: 'materials',
    note: '',
    bindings: [{ quantityId: q.id, allocationRatio: '1' }],
    rateId: 'price',
    wasteRatio: '0',
    inclusion: 'include',
    exclusionReason: '',
  }));
  expect(
    evaluateEstimate(makeEstimateBasis(doc)).diagnostics.some(
      (d) => d.code === 'duplicate-coverage',
    ),
  ).toBe(true);
  doc.lines[1].category = 'labor';
  expect(evaluateEstimate(makeEstimateBasis(doc)).total).toBe('2');
});
it('ES13/14 source updates keep line notes, overrides and stable IDs, while additions/removals remain pending', async () => {
  const { proposeCadSourceUpdate } = await import('./cad-source');
  const f = r2bBom(),
    pin = {
      domain: 'cad' as const,
      artifactId: 'root',
      versionId: 'old',
      contentHash: cadContentHash(f.assembly),
    };
  const sources = await retainCadSource(pin, f.assembly, (h) => f.closure.get(h)),
    root = sources.find((s) => s.key === pinKey(pin))!;
  const doc = createEstimate();
  doc.retainedSources = sources;
  doc.quantities = cadSourceProjection(root, sources).rows.map((row, i) =>
    cadQuantity(root, sources, row.identity, `q${i}`),
  );
  doc.quantities[0].override = { value: '2', reason: 'manual adjustment' };
  const changed = structuredClone(f.assembly);
  changed.bodies[0].name = 'Renamed';
  const updatedPin = { ...pin, versionId: 'new', contentHash: cadContentHash(changed) };
  const closure = await retainCadSource(updatedPin, changed, (h) => f.closure.get(h)),
    replacement = closure.find((s) => s.key === pinKey(updatedPin))!;
  let id = 0;
  const proposed = await proposeCadSourceUpdate(
    doc,
    root.key,
    replacement,
    closure,
    () => `new${id++}`,
  );
  expect(proposed.document.quantities[0].id).toBe(doc.quantities[0].id);
  expect(proposed.document.quantities[0].override).toEqual(doc.quantities[0].override);
  expect(doc.quantities[0].source!.snapshotKey).toBe(root.key);
  expect(proposed.document.quantities[0].source!.snapshotKey).toBe(replacement.key);
  expect(proposed.differences.some((d) => d.state === 'changed')).toBe(true);
});
