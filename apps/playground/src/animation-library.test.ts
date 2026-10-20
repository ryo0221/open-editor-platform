import { expect, it } from 'vitest';
import { createArtifact, commitVersion } from '@editor-platform/artifact-core';
import { createAnimation2 } from '@editor-platform/animation-core/v2';
import { savedAnimationCatalog } from './animation-library';
it('shares one admitted immutable snapshot across every composition in a saved version', async () => {
  const content = createAnimation2(),
    root = content.compositions[0];
  content.compositions.push(
    ...Array.from({ length: 20 }, (_, i) => ({ ...structuredClone(root), id: 'composition-' + i })),
  );
  const saved = await commitVersion(
    createArtifact('animation', 'Shared snapshot', content),
    'test',
    'Saved',
  );
  const first = savedAnimationCatalog([saved]),
    second = savedAnimationCatalog([saved]);
  expect(first.sources).toHaveLength(21);
  expect(new Set(first.sources.map((embed) => embed.snapshot)).size).toBe(1);
  expect(second.sources[0].snapshot).toBe(first.sources[0].snapshot);
  expect(first.sources.every((embed) => Object.isFrozen(embed.snapshot))).toBe(true);
});
it('keeps usable saved sources available when another source cannot become a playable embed', async () => {
  const bad = await commitVersion(
    createArtifact('animation', 'x'.repeat(201), createAnimation2()),
    'test',
    'Saved',
  );
  const good = await commitVersion(
    createArtifact('animation', 'Good', createAnimation2()),
    'test',
    'Saved',
  );
  const catalog = savedAnimationCatalog([bad, good]);
  expect(catalog.sources).toHaveLength(1);
  expect(catalog.sources[0].source.contentHash).toBe(good.versions[0].contentHash);
  expect(catalog.unavailable).toHaveLength(1);
  expect(catalog.unavailable[0].reason).toContain('animation-label');
  expect(savedAnimationCatalog([{ ...good, versions: [] }]).sources).toEqual([]);
});

it('revalidates mutable versions and does not let a cached snapshot mask a changed source hash or label', async () => {
  const saved = await commitVersion(
    createArtifact('animation', 'Original', createAnimation2()),
    'test',
    'Saved',
  );
  const catalog = savedAnimationCatalog([saved]);
  expect(catalog.sources).toHaveLength(1);
  expect(savedAnimationCatalog([{ ...saved, name: 'Renamed' }]).sources[0].label).toBe(
    'Renamed / Main',
  );
  const badHash = {
    ...saved,
    versions: saved.versions.map((v) => ({ ...v, contentHash: '0'.repeat(64) })),
  };
  expect(savedAnimationCatalog([badHash]).unavailable[0].reason).toContain(
    'animation-source-hash-mismatch',
  );
  const mutable = structuredClone(saved);
  expect(savedAnimationCatalog([mutable]).sources).toHaveLength(1);
  mutable.versions[0].content.compositions[0].name = 'Changed';
  expect(savedAnimationCatalog([mutable]).sources).toHaveLength(0);
});
