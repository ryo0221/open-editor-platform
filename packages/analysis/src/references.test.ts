import { expect, it } from 'vitest';
import { contentHash } from '@editor-platform/artifact-core';
import { ReferenceResolver, type ReferenceSnapshot } from '@editor-platform/artifact-references';
import { calculateRun } from '@editor-platform/analysis-core';
import { analysisFixture } from '../../analysis-core/src/fixtures';
import { testWorker } from './test-worker';
import { createAnalysisReferenceAdapter } from './references';
it('AN18 cold synchronous adapter refuses until retained snapshot preflight replays the run', async () => {
  const document = await analysisFixture();
  document.runs = [await calculateRun(document, 'run')];
  const snapshot: ReferenceSnapshot = {
    artifactId: 'analysis',
    domain: 'analysis',
    versionId: 'v1',
    revision: 1,
    content: document,
    contentHash: await contentHash(document),
    dependencies: [],
  };
  const source = {
    artifactId: 'analysis',
    domain: 'analysis',
    target: { kind: 'table', viewId: JSON.stringify(['run', 'total-output']) },
  };
  const adapter = createAnalysisReferenceAdapter({ worker: testWorker });
  expect(() => adapter.validate(snapshot)).toThrow('preflight');
  const resolver = new ReferenceResolver(
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
  const result = await resolver.capture(
    [
      {
        id: 'image',
        src: '',
        reference: { schemaVersion: 1, source, mode: 'fixed', fit: 'contain', snapshot },
      },
    ],
    false,
  );
  expect(result[0].src).toContain('data:image/svg+xml');
  const forged = structuredClone(snapshot);
  (forged.content as typeof document).runs[0].results['total-output'].rows[0].values.total = '99';
  forged.contentHash = await contentHash(forged.content);
  await expect(resolver.validate(forged, source)).rejects.toThrow('unverified-result');
});
it('AN17/18 current-result targets follow a saved recomputation while fixed bytes and scope isolation remain intact', async () => {
  const document = await analysisFixture();
  document.runs = [await calculateRun(document, 'old')];
  const snapshot: ReferenceSnapshot = {
    artifactId: 'analysis',
    domain: 'analysis',
    versionId: 'v1',
    revision: 1,
    content: document,
    contentHash: await contentHash(document),
    dependencies: [],
  };
  let generation = 'scope-1';
  const adapter = createAnalysisReferenceAdapter({
    worker: testWorker,
    generation: () => generation,
  });
  const target = { kind: 'table' as const, viewId: JSON.stringify([null, 'total-output']) };
  await adapter.prepare!(snapshot);
  const fixed = adapter.project(snapshot, target);
  const next = structuredClone(document);
  next.parameters[0].value = '1.1';
  next.runs.push(await calculateRun(next, 'new'));
  const newer = {
    ...snapshot,
    content: next,
    versionId: 'v2',
    revision: 2,
    contentHash: await contentHash(next),
  };
  await adapter.prepare!(newer);
  expect(adapter.project(newer, target)).not.toEqual(fixed);
  expect(adapter.project(snapshot, target)).toEqual(fixed);
  generation = 'scope-2';
  expect(() => adapter.project(snapshot, target)).toThrow('preflight');
});
