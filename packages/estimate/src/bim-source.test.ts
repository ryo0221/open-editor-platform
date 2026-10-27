import { it, expect } from 'vitest';
import { contentHash } from '@editor-platform/artifact-core';
import { bimStarter, f39Roofs } from '@editor-platform/bim-core';
import { createEstimate, calculateEstimate, verifyEstimate } from '@editor-platform/estimate-core';
import {
  retainBimSource,
  bimQuantity,
  bimQuantityVerification,
  type EstimateBimEvaluator,
} from './bim-source';
it('ES16 EF4 keeps gross/net distinct and converts 550000000 mm3 to 0.55 m3 / 11000 JPY', async () => {
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
    {
      id: 'opening',
      kind: 'opening',
      hostId: 'wall',
      wall: { alongMm: 1000, sillMm: 500, widthMm: 1000, heightMm: 500 },
    },
  ];
  const pin = {
      domain: 'bim' as const,
      artifactId: 'building',
      versionId: 'v1',
      contentHash: await contentHash(doc),
    },
    source = await retainBimSource(pin, doc);
  const net = await bimQuantity(source, 'wall', 'netVolume', 'q');
  expect(net.value).toBe('0.55');
  expect(net.unit).toBe('m3');
  expect((await bimQuantity(source, 'wall', 'grossVolume', 'gross')).value).toBe('0.6');
  await expect(bimQuantity(source, 'wall', 'grossArea', 'area')).rejects.toThrow(
    'missing-bim-metric',
  );
  const estimate = createEstimate();
  estimate.quantities = [net];
  estimate.retainedSources = [source];
  estimate.rates = [
    {
      id: 'rate',
      name: 'Concrete',
      unitPrice: '20000',
      perUnit: 'm3',
      currency: 'JPY',
      evidence: 'fixture',
    },
  ];
  estimate.lines = [
    {
      id: 'line',
      name: 'Wall net volume',
      category: 'concrete',
      note: '',
      bindings: [{ quantityId: 'q', allocationRatio: '1' }],
      rateId: 'rate',
      wasteRatio: '0',
      inclusion: 'include',
      exclusionReason: '',
    },
  ];
  estimate.calculations = [await calculateEstimate(estimate, 'result')];
  expect(estimate.calculations[0].result.total).toBe('11000');
  await expect(
    verifyEstimate(estimate, undefined, false, bimQuantityVerification()),
  ).resolves.toBeDefined();
  estimate.quantities[0].value = '0.6';
  await expect(
    verifyEstimate(estimate, undefined, false, bimQuantityVerification()),
  ).rejects.toThrow('quantity-source-mismatch');
});
it('ES17/19 never trusts global ok, stale basis, missing gross or a persisted kernel value alone', async () => {
  const doc = f39Roofs('gable'),
    pin = {
      domain: 'bim' as const,
      artifactId: 'building',
      versionId: 'v1',
      contentHash: await contentHash(doc),
    },
    source = await retainBimSource(pin, doc);
  const valid: EstimateBimEvaluator = async () => ({
    contentHash: pin.contentHash,
    engine: 'kernel-fixture',
    status: 'ok',
    elements: new Map([['w-east', { status: 'ok' }]]),
    quantities: new Map([['w-east', { netVolume: 550000000 }]]),
  });
  expect((await bimQuantity(source, 'w-east', 'netVolume', 'q', valid)).value).toBe('0.55');
  await expect(bimQuantity(source, 'w-east', 'grossVolume', 'q', valid)).rejects.toThrow(
    'missing-bim-metric',
  );
  await expect(bimQuantity(source, 'w-east', 'netVolume', 'q')).rejects.toThrow(
    'bim-kernel-verifier-required',
  );
  await expect(
    bimQuantity(source, 'w-east', 'netVolume', 'q', async (d, p) => ({
      ...(await valid(d, p)),
      elements: new Map([['w-east', { status: 'error' }]]),
    })),
  ).rejects.toThrow('bim-element-evaluation-failed');
  await expect(
    bimQuantity(source, 'w-east', 'netVolume', 'q', async (d, p) => ({
      ...(await valid(d, p)),
      contentHash: '0'.repeat(64),
    })),
  ).rejects.toThrow('stale-bim-evaluation');
});
it('ES18 refuses CAD part placement metrics instead of counting the same placed part twice', async () => {
  const { f02Plate, cadContentHash } = await import('@editor-platform/cad-core');
  const { retainCadSource } = await import('./cad-source');
  const cad = f02Plate();
  const partPin = { artifactId: 'cad-part', versionId: 'v1', contentHash: cadContentHash(cad) };
  const cadSources = await retainCadSource({ domain: 'cad', ...partPin }, cad, () => undefined);
  const doc = bimStarter();
  doc.types.push({
    id: 'cad-type',
    name: 'Placed CAD',
    kind: 'part',
    source: partPin,
    hintBounds: { min: [0, 0, 0], max: [100, 100, 100] },
  });
  doc.elements = [
    {
      id: 'placed',
      kind: 'part',
      typeId: 'cad-type',
      at: { xy: [0, 0] },
      base: { level: 'l-1f', offsetMm: 0 },
      rotationRad: 0,
    },
  ];
  const pin = {
    domain: 'bim' as const,
    artifactId: 'building',
    versionId: 'v1',
    contentHash: await contentHash(doc),
  };
  const source = await retainBimSource(pin, doc, cadSources);
  await expect(bimQuantity(source, 'placed', 'netVolume', 'q')).rejects.toThrow(
    'bim-quantity-unavailable',
  );
  await expect(bimQuantity(source, 'placed', 'length', 'q')).rejects.toThrow(
    'bim-quantity-unavailable',
  );
});
it('ES19 aborts a delayed kernel request even when its evaluator returns a valid old measurement', async () => {
  const doc = f39Roofs('gable');
  const pin = {
    domain: 'bim' as const,
    artifactId: 'building',
    versionId: 'v1',
    contentHash: await contentHash(doc),
  };
  const source = await retainBimSource(pin, doc);
  const abort = new AbortController();
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    release = resolve;
  });
  const evaluator: EstimateBimEvaluator = async (_doc, _pin, signal) => {
    expect(signal).toBe(abort.signal);
    release();
    await new Promise<void>((resolve) =>
      signal!.addEventListener('abort', () => resolve(), { once: true }),
    );
    return {
      contentHash: pin.contentHash,
      engine: 'kernel-fixture',
      status: 'ok',
      elements: new Map([['w-east', { status: 'ok' }]]),
      quantities: new Map([['w-east', { netVolume: 550000000 }]]),
    };
  };
  const pending = bimQuantity(source, 'w-east', 'netVolume', 'q', evaluator, abort.signal);
  await entered;
  abort.abort();
  await expect(pending).rejects.toThrow('cancelled');
});
