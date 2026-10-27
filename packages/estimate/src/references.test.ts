import { expect, it } from 'vitest';
import { contentHash } from '@editor-platform/artifact-core';
import {
  ReferenceResolver,
  ReferenceError,
  type ReferenceSnapshot,
} from '@editor-platform/artifact-references';
import { calculateEstimate, retainPriceData } from '@editor-platform/estimate-core';
import { estimateFixture } from '../../estimate-core/src/fixtures';
import { createEstimateReferenceAdapter } from './references';
async function fixture() {
  const doc = estimateFixture();
  doc.calculations = [await calculateEstimate(doc, 'old')];
  const snapshot: ReferenceSnapshot = {
    artifactId: 'estimate',
    domain: 'estimate',
    versionId: 'v1',
    revision: 1,
    content: doc,
    contentHash: await contentHash(doc),
    dependencies: [],
  };
  return { doc, snapshot };
}
it('ES20/21 cold preflight recomputes retained results and rejects matching-hash tampering before capture', async () => {
  const { doc: _doc, snapshot } = await fixture(),
    adapter = createEstimateReferenceAdapter(),
    target = { kind: 'table', viewId: JSON.stringify([null, null]) };
  expect(() => adapter.project(snapshot, target)).toThrow('preflight');
  const source = { artifactId: 'estimate', domain: 'estimate', target },
    resolver = new ReferenceResolver(
      {
        async list() {
          return [];
        },
        async read() {
          return snapshot;
        },
        subscribe() {
          return () => {};
        },
      },
      [adapter],
      'destination',
    );
  const captured = await resolver.capture(
    [
      {
        id: 'image',
        src: '',
        reference: { schemaVersion: 1, source, mode: 'fixed', fit: 'contain', snapshot },
      },
    ],
    false,
  );
  expect(captured[0].src).toContain('data:image/svg+xml');
  const forged = structuredClone(snapshot);
  const changed = forged.content as typeof _doc;
  changed.calculations[0].result.total = '1';
  changed.calculations[0].resultHash = await contentHash(changed.calculations[0].result);
  forged.contentHash = await contentHash(changed);
  await expect(resolver.validate(forged, source)).rejects.toThrow('unverified-result');
});
it('ES20 fixed bytes preserve prior prices and current selectors follow saved recomputation; scope changes invalidate cache', async () => {
  const { doc, snapshot } = await fixture();
  let generation = 'scope1';
  const adapter = createEstimateReferenceAdapter({ generation: () => generation }),
    target = { kind: 'table', viewId: JSON.stringify([null, null]) };
  await adapter.prepare!(snapshot);
  const old = adapter.project(snapshot, target);
  doc.rates[1].unitPrice = '30';
  doc.calculations.push(await calculateEstimate(doc, 'new'));
  const newer = {
    ...snapshot,
    versionId: 'v2',
    revision: 2,
    content: structuredClone(doc),
    contentHash: await contentHash(doc),
  };
  // fixture source bytes must remain immutable when testing fixed retention.
  const original = await fixture();
  await adapter.prepare!(original.snapshot);
  const fixed = adapter.project(original.snapshot, target);
  await adapter.prepare!(newer);
  expect(adapter.project(newer, target)).not.toEqual(old);
  expect(adapter.project(original.snapshot, target)).toEqual(fixed);
  expect(
    adapter.project(newer, { kind: 'chart', viewId: JSON.stringify(['new', 'old']) }),
  ).toBeDefined();
  generation = 'scope2';
  expect(() => adapter.project(newer, target)).toThrow('preflight');
});
it('ES21 rechecks retained input permission even on a warm projection', async () => {
  const { doc, snapshot } = await fixture(),
    native = {
      schemaVersion: 2,
      columns: [{ id: 'p', name: 'Price', type: 'number' }],
      rows: [{ id: 'r', values: { p: 1 } }],
    };
  doc.retainedSources.push(
    await retainPriceData(
      {
        domain: 'data',
        artifactId: 'prices',
        versionId: 'v1',
        contentHash: await contentHash(native),
      },
      native,
    ),
  );
  const kept = { ...snapshot, content: doc, contentHash: await contentHash(doc) };
  let allowed = true;
  const adapter = createEstimateReferenceAdapter({
    canRead: () => allowed,
    check: () => {
      if (!allowed) throw new ReferenceError('forbidden', 'revoked');
    },
  });
  await adapter.prepare!(kept);
  allowed = false;
  expect(() =>
    adapter.project(kept, { kind: 'table', viewId: JSON.stringify(['old', null]) }),
  ).toThrow('revoked');
});
it('ES21 refuses oversized projections without truncating and requires exact row selectors', async () => {
  const doc = estimateFixture();
  doc.quantities = doc.quantities.slice(0, 1);
  doc.rates = doc.rates.slice(0, 1);
  doc.lines = Array.from({ length: 101 }, (_, i) => ({
    ...doc.lines[0],
    id: `line${i}`,
    category: `category${i}`,
  }));
  doc.calculations = [await calculateEstimate(doc, 'large')];
  const snapshot: ReferenceSnapshot = {
      artifactId: 'estimate',
      domain: 'estimate',
      versionId: 'v1',
      revision: 1,
      content: doc,
      contentHash: await contentHash(doc),
      dependencies: [],
    },
    adapter = createEstimateReferenceAdapter();
  await adapter.prepare!(snapshot);
  expect(() =>
    adapter.project(snapshot, { kind: 'table', viewId: JSON.stringify(['large', null]) }),
  ).toThrow('100行');
  expect(() =>
    adapter.project(snapshot, {
      kind: 'table',
      viewId: JSON.stringify(['large', null]),
      rowIds: ['missing'],
    }),
  ).toThrow('行/列');
});
it('ES20 removed scenarios remain historical without breaking the current selector', async () => {
  const { doc } = await fixture();
  doc.scenarios = [
    {
      id: 'alternative',
      name: 'Alternative',
      quantities: [],
      rates: [{ id: 'bolt-price', value: '30', reason: 'comparison' }],
      waste: [],
      workRules: [],
    },
  ];
  doc.calculations.push(await calculateEstimate(doc, 'alternative-result', 'alternative'));
  doc.scenarios = [];
  const snapshot: ReferenceSnapshot = {
    artifactId: 'estimate',
    domain: 'estimate',
    versionId: 'v2',
    revision: 2,
    content: doc,
    contentHash: await contentHash(doc),
    dependencies: [],
  };
  const adapter = createEstimateReferenceAdapter();
  await adapter.prepare!(snapshot);
  expect(
    adapter.project(snapshot, { kind: 'table', viewId: JSON.stringify([null, null]) }),
  ).toBeDefined();
  expect(
    adapter.project(snapshot, {
      kind: 'table',
      viewId: JSON.stringify(['alternative-result', null]),
    }),
  ).toBeDefined();
});
it('construction summary and explicit partitions retain exact totals without silently truncating', async () => {
  const { doc, snapshot } = await fixture();
  const adapter = createEstimateReferenceAdapter();
  await adapter.prepare!(snapshot);
  const summary = adapter.project(snapshot, {
    kind: 'table',
    viewId: JSON.stringify([null, null, 'summary']),
  });
  const svg = Buffer.from(summary.src.split(',')[1], 'base64').toString('utf8');
  expect(svg).toContain('1,350');
  expect(svg).toContain('見積合計');
  const lineId = JSON.stringify(['line', doc.calculations[0].result.lines[0].id]);
  expect(
    adapter.project(snapshot, {
      kind: 'table',
      viewId: JSON.stringify([null, null]),
      rowIds: [lineId],
    }),
  ).toBeDefined();
  expect(() =>
    adapter.project(snapshot, {
      kind: 'table',
      viewId: JSON.stringify([null, null]),
      rowIds: ['missing'],
    }),
  ).toThrow('行/列');
  expect(() =>
    adapter.project(snapshot, { kind: 'table', viewId: JSON.stringify([null, null, 'unknown']) }),
  ).toThrow();
  const altered = structuredClone(snapshot);
  (altered.content as typeof doc).calculations[0].result.total = '99';
  expect(() =>
    adapter.project(altered, { kind: 'table', viewId: JSON.stringify([null, null, 'summary']) }),
  ).toThrow('preflight');
});
