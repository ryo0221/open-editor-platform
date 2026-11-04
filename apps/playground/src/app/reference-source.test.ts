import { it, expect } from 'vitest';
import { createArtifact, commitVersion, updateDraft } from '@editor-platform/artifact-core';
import { createFictionMap } from '@editor-platform/fiction-map/model';
import { nativeReferenceAdapters } from '@editor-platform/reference-adapters';
import { ReferenceResolver } from '@editor-platform/artifact-references';
import { savedRecordReferences } from './reference-source';
import type { StoredArtifact } from '../model';
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
