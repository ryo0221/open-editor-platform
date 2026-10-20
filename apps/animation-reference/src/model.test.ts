import { expect, it } from 'vitest';
import { createRectangleAnimation } from '@editor-platform/animation-core';
import {
  createArtifact,
  commitVersion,
  serializeArtifact,
  type Artifact,
} from '@editor-platform/artifact-core';
import { readAnimationHostArtifact, savedAnimationEmbed } from './model';

it('owns native draft and saved versions and admits embed metadata at the exact limit', async () => {
  const draft = createArtifact('animation', 'Animation', createRectangleAnimation());
  expect(await readAnimationHostArtifact(serializeArtifact(draft))).toEqual(draft);
  expect(savedAnimationEmbed(draft)).toBeUndefined();
  const saved = await commitVersion(draft, 'test', 'Saved');
  saved.id = 'a'.repeat(200);
  saved.name = 'n'.repeat(200);
  saved.versions = saved.versions.map((version) => ({
    ...version,
    artifactId: saved.id,
    versionId: 'v'.repeat(200),
  }));
  saved.draft.baseVersionId = saved.versions[0].versionId;
  const loaded = await readAnimationHostArtifact(serializeArtifact(saved));
  expect(loaded).toEqual(saved);
  expect(savedAnimationEmbed(loaded)?.source).toEqual({
    artifactId: saved.id,
    versionId: saved.versions[0].versionId,
    contentHash: saved.versions[0].contentHash,
    compositionId: 'root',
  });
  loaded.draft.content.compositions[0].duration--;
  expect(saved.draft.content.compositions[0].duration).toBe(960000);
});

it('refuses saved artifacts with unusable Player labels or exact source IDs', async () => {
  const saved = await commitVersion(
    createArtifact('animation', 'Valid', createRectangleAnimation()),
    'test',
    'Saved',
  );
  const changes: Array<(artifact: Artifact<unknown>) => void> = [
    (a) => {
      a.name = '';
    },
    (a) => {
      a.name = '   ';
    },
    (a) => {
      a.name = 'n'.repeat(201);
    },
    ...['', 'a'.repeat(201)].map((id) => (a: Artifact<unknown>) => {
      a.id = id;
      a.versions = a.versions.map((v) => ({ ...v, artifactId: id }));
    }),
    ...['', 'v'.repeat(201)].map((id) => (a: Artifact<unknown>) => {
      a.versions = a.versions.map((v) => ({ ...v, versionId: id }));
      a.draft.baseVersionId = id;
    }),
  ];
  for (const change of changes) {
    const invalid = structuredClone(saved);
    change(invalid);
    await expect(readAnimationHostArtifact(serializeArtifact(invalid))).rejects.toThrow(
      /animation-(label|source)|Invalid (artifact kind|retained version identity)/,
    );
  }
  expect(savedAnimationEmbed(saved)?.label).toBe('Valid');
});

it('checks future saved Player metadata even when the imported artifact has no saved versions', async () => {
  const draft = createArtifact('animation', '', createRectangleAnimation());
  await expect(readAnimationHostArtifact(serializeArtifact(draft))).rejects.toThrow(
    /animation-label/,
  );
  draft.name = 'Valid';
  draft.id = 'a'.repeat(201);
  await expect(readAnimationHostArtifact(serializeArtifact(draft))).rejects.toThrow(
    /animation-source/,
  );
});

it('retains native domain and all-version content/hash validation before admission', async () => {
  const saved = await commitVersion(
    createArtifact('animation', 'Valid', createRectangleAnimation()),
    'test',
    'Saved',
  );
  const wrongHash = structuredClone(saved);
  wrongHash.versions[0].contentHash = '0'.repeat(64);
  await expect(readAnimationHostArtifact(serializeArtifact(wrongHash))).rejects.toThrow(
    /hash mismatch/,
  );
  const wrongContent = structuredClone(saved);
  wrongContent.versions[0].content.compositions = [];
  await expect(readAnimationHostArtifact(serializeArtifact(wrongContent))).rejects.toThrow();
  await expect(
    readAnimationHostArtifact(serializeArtifact({ ...saved, kind: 'slide' })),
  ).rejects.toThrow(/Invalid artifact kind/);
});

const invalidHistory: Array<{ name: string; change(a: Artifact<unknown>): void; error: RegExp }> = [
  {
    name: 'duplicate version IDs',
    change: (a) => {
      a.versions[1].versionId = a.versions[0].versionId;
    },
    error: /retained version identity/,
  },
  {
    name: 'empty version ID',
    change: (a) => {
      a.versions[0].versionId = '';
    },
    error: /retained version identity/,
  },
  {
    name: 'whitespace version ID',
    change: (a) => {
      a.versions[0].versionId = ' ';
    },
    error: /retained version identity/,
  },
  {
    name: 'missing parent',
    change: (a) => {
      a.versions[1].parentVersionId = 'missing';
    },
    error: /retained version identity/,
  },
  {
    name: 'missing parent field',
    change: (a) => {
      Reflect.deleteProperty(a.versions[0], 'parentVersionId');
    },
    error: /retained version identity/,
  },
  {
    name: 'self cycle',
    change: (a) => {
      a.versions[0].parentVersionId = a.versions[0].versionId;
    },
    error: /parent cycle/,
  },
  {
    name: 'two-version cycle',
    change: (a) => {
      a.versions[0].parentVersionId = a.versions[1].versionId;
    },
    error: /parent cycle/,
  },
  {
    name: 'missing draft base',
    change: (a) => {
      a.draft.baseVersionId = 'missing';
    },
    error: /Draft base version is missing/,
  },
  {
    name: 'missing draft base field',
    change: (a) => {
      Reflect.deleteProperty(a.draft, 'baseVersionId');
    },
    error: /Draft base version is missing/,
  },
];
it.each(invalidHistory)(
  'refuses $name before returning imported Animation history',
  async ({ change, error }) => {
    const first = await commitVersion(
      createArtifact('animation', 'Motion', createRectangleAnimation()),
      'test',
      'First',
    );
    const original = await commitVersion(first, 'test', 'Second'),
      invalid = structuredClone(original);
    change(invalid);
    await expect(readAnimationHostArtifact(serializeArtifact(invalid))).rejects.toThrow(error);
    expect(await readAnimationHostArtifact(serializeArtifact(original))).toEqual(original);
  },
);

it('preserves valid branching and reordered history, a restored base, and unsaved drafts', async () => {
  const draft = createArtifact('animation', 'Motion', createRectangleAnimation());
  expect(await readAnimationHostArtifact(serializeArtifact(draft))).toEqual(draft);
  const first = await commitVersion(draft, 'test', 'First'),
    second = await commitVersion(first, 'test', 'Second');
  const branch = await commitVersion(
    { ...second, draft: { ...second.draft, baseVersionId: first.versions[0].versionId } },
    'test',
    'Branch',
  );
  const reordered = {
    ...branch,
    versions: [branch.versions[1], branch.versions[0], branch.versions[2]],
    draft: { ...branch.draft, baseVersionId: first.versions[0].versionId },
  };
  const loaded = await readAnimationHostArtifact(serializeArtifact(reordered));
  expect(loaded).toEqual(reordered);
  const saved = await commitVersion(loaded, 'test', 'After restore');
  expect(saved.versions.slice(0, 3)).toEqual(reordered.versions);
  expect(saved.versions[3].parentVersionId).toBe(first.versions[0].versionId);
  expect(await readAnimationHostArtifact(serializeArtifact(saved))).toEqual(saved);
});
