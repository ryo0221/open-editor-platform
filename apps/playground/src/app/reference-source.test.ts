import { it, expect } from 'vitest';
import {
  createArtifact,
  commitVersion,
  contentHash,
  updateDraft,
} from '@editor-platform/artifact-core';
import { createFictionMap } from '@editor-platform/fiction-map/model';
import { nativeReferenceAdapters } from '@editor-platform/reference-adapters';
import { createLiveReference, ReferenceResolver } from '@editor-platform/artifact-references';
import { savedExtensionReferences, savedRecordReferences } from './reference-source';
import type { StoredArtifact } from '../model';

it('allows the external Editor to resolve only retained, authorized snapshots', async () => {
  const host = savedExtensionReferences('consumer');
  const [artifact] = await host.listArtifacts();
  const [old, latest] = await host.listVersions(artifact);
  const target = { kind: 'value' as const, targetId: 'counter', metricId: 'double' };
  await expect(host.provider.resolve(old, target)).resolves.toEqual({ kind: 'value', value: 40 });
  await expect(host.provider.resolve(latest, target)).resolves.toEqual({
    kind: 'value',
    value: 120,
  });
  const forged = { ...old, content: latest.content, contentHash: latest.contentHash };
  await expect(host.provider.resolve(forged, target)).rejects.toMatchObject({ status: 'stale' });
  await expect(host.provider.list({ ...old, versionId: 'draft' })).rejects.toMatchObject({
    status: 'missing-target',
  });
  await expect(host.listVersions({ ...artifact, domain: 'wrong' })).rejects.toMatchObject({
    status: 'missing-source',
  });
  const self = savedExtensionReferences(artifact.artifactId);
  await expect(self.listArtifacts()).resolves.toEqual([]);
  await expect(self.provider.list(old)).rejects.toMatchObject({ status: 'forbidden' });
});

it('checks saved Fiction Map version retention while preserving fixed projections across newer saves', async () => {
  const a = {
    ...(await commitVersion(
      createArtifact('fiction-map', 'Map', createFictionMap()),
      null,
      'first',
    )),
    annotations: [],
  } as StoredArtifact;
  const saved = { current: new Map([[a.id, a]]) },
    notifications = { current: new Set<(id: string) => void>() };
  const host = savedRecordReferences({
      saved,
      notifications,
      navigation: { current: () => false },
    }),
    resolver = new ReferenceResolver(host, nativeReferenceAdapters, 'consumer');
  const [option] = await host.list();
  expect(option.source.domain).toBe('fiction-map');
  const ref = await resolver.create(option.source, 'fixed'),
    before = await resolver.refresh(ref);
  const newer = {
    ...(await commitVersion(updateDraft(a, createFictionMap()), null, 'second')),
    annotations: [],
  };
  saved.current.set(a.id, newer);
  expect((await resolver.refresh(ref)).projection).toEqual(before.projection);
  expect(ref.snapshot.versionId).toBe(a.versions[0].versionId);
  saved.current.set(a.id, { ...newer, versions: newer.versions.slice(1) });
  const missing = await resolver.refresh(ref);
  expect(missing.status).toBe('missing-target');
  expect(missing.message).toContain('version');
  expect(missing.projection).toBeUndefined();
  const corrupt = structuredClone(a);
  corrupt.versions[0].contentHash = '0'.repeat(64);
  saved.current.set(a.id, corrupt);
  expect((await resolver.refresh(ref)).status).toBe('stale');
  saved.current.delete(a.id);
  const gone = await resolver.refresh(ref);
  expect(gone.status).toBe('missing-source');
  expect(gone.projection).toBeUndefined();
  expect(a.versions).toHaveLength(1);
});

it('offers only the registered Editor and refuses a web source for selection and insertion', async () => {
  const connection = savedExtensionReferences('destination');
  expect(await connection.listArtifacts()).toEqual([
    expect.objectContaining({ label: 'Counter サンプル' }),
  ]);
  const artifact = { artifactId: 'https://example.invalid/number', domain: 'web', label: 'Web' };
  const reason = {
    status: 'missing-source',
    message: '保存済みの引用元が見つかりません。',
  };
  await expect(connection.listVersions(artifact)).rejects.toMatchObject(reason);
  const content = { value: 12 };
  await expect(
    createLiveReference(
      { ...artifact, target: { kind: 'value', targetId: 'page', metricId: 'number' } },
      {
        ...artifact,
        versionId: 'claimed-version',
        revision: 1,
        content,
        contentHash: await contentHash(content),
        dependencies: [],
      },
      connection.provider,
      { style: 'decimal', digits: 0, unit: '' },
      connection.destinationArtifactId,
    ),
  ).rejects.toMatchObject(reason);
});
