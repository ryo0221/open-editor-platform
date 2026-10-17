import { expect, it } from 'vitest';
import { createArtifact, commitVersion, clone, contentHash } from '@editor-platform/artifact-core';
import {
  createArtifactOutputManifest,
  verifyArtifactOutputManifest,
  type OutputFile,
} from './index';
const generator = { id: 'example-text', version: '1.0.0' };
const files = (): OutputFile[] => [
  {
    path: 'generated/Text.txt',
    mediaType: 'text/plain',
    bytes: new TextEncoder().encode('Original text'),
  },
];
const artifact = async () =>
  commitVersion(
    createArtifact('example', 'Example', { text: 'Original text' }),
    'fixture',
    'immutable',
  );
const dependencies = [{ id: 'host-runtime', version: '1.0.0', hash: 'a'.repeat(64) }];
it('pins immutable source/generator/Host dependencies and verifies actual output bytes', async () => {
  const a = await artifact(),
    source = a.versions[0];
  const manifest = await createArtifactOutputManifest(
    a,
    source.versionId,
    generator,
    files(),
    dependencies,
  );
  const expected = { source: manifest.source, generator, dependencies };
  expect(await verifyArtifactOutputManifest(manifest, files(), expected)).toEqual(manifest);
  expect(manifest.source.contentHash).toBe(source.contentHash);
  expect(Object.isFrozen(manifest.files)).toBe(true);
  a.draft.content.text = 'New draft';
  expect(
    await createArtifactOutputManifest(a, source.versionId, generator, files(), dependencies),
  ).toEqual(manifest);
  expect(manifest.dependencies[0].hash).toBe('a'.repeat(64));
});
it('owns files/pins before awaiting hashing and rejects stale source/generator or changed bytes', async () => {
  const a = await artifact(),
    f = files(),
    pins = clone(dependencies);
  const pending = createArtifactOutputManifest(a, a.versions[0].versionId, generator, f, pins);
  f[0].bytes.fill(0);
  pins[0].version = 'changed';
  const manifest = await pending;
  const expected = { source: manifest.source, generator, dependencies };
  await expect(verifyArtifactOutputManifest(manifest, f, expected)).rejects.toThrow(
    /file mismatch/,
  );
  await expect(
    verifyArtifactOutputManifest(manifest, files(), {
      ...expected,
      generator: { ...generator, version: '2.0.0' },
    }),
  ).rejects.toThrow(/pin mismatch/);
  await expect(
    verifyArtifactOutputManifest(manifest, files(), {
      ...expected,
      source: { ...manifest.source, versionId: 'other' },
    }),
  ).rejects.toThrow(/pin mismatch/);
});
it.each(['../escape.txt', '/absolute.txt', 'a\\b.txt', 'a//b.txt', 'a/./b.txt'])(
  'rejects unsafe output path %s',
  async (path) => {
    const a = await artifact();
    await expect(
      createArtifactOutputManifest(a, a.versions[0].versionId, generator, [
        { ...files()[0], path },
      ]),
    ).rejects.toThrow(/unsafe/);
  },
);
it('rejects uncommitted, corrupt historical content, duplicate paths/pins and malformed or tampered manifests', async () => {
  const a = await artifact(),
    version = a.versions[0].versionId;
  await expect(createArtifactOutputManifest(a, 'absent', generator, files())).rejects.toThrow(
    /existing immutable/,
  );
  await expect(
    createArtifactOutputManifest(a, version, { ...generator, version: 'latest' }, files()),
  ).rejects.toThrow(/pin/);
  await expect(
    createArtifactOutputManifest(a, version, generator, [...files(), ...files()]),
  ).rejects.toThrow(/duplicate/);
  await expect(
    createArtifactOutputManifest(a, version, generator, files(), [
      ...dependencies,
      ...dependencies,
    ]),
  ).rejects.toThrow(/duplicate/);
  const manifest = await createArtifactOutputManifest(a, version, generator, files());
  const expected = { source: manifest.source, generator, dependencies: [] };
  await expect(
    verifyArtifactOutputManifest({ ...manifest, fingerprint: '0'.repeat(64) }, files(), expected),
  ).rejects.toThrow(/fingerprint/);
  await expect(verifyArtifactOutputManifest(manifest, [], expected)).rejects.toThrow(/file count/);
  await expect(
    verifyArtifactOutputManifest({ ...manifest, extra: true }, files(), expected),
  ).rejects.toThrow(/fields/);
  let invoked = false;
  await expect(
    verifyArtifactOutputManifest(
      {
        get source() {
          invoked = true;
          return {};
        },
      },
      files(),
      expected,
    ),
  ).rejects.toThrow(/accessors/);
  expect(invoked).toBe(false);
  const corrupt = clone(a);
  corrupt.versions[0].content.text = 'Corrupt';
  await expect(createArtifactOutputManifest(corrupt, version, generator, files())).rejects.toThrow(
    /source content hash/,
  );
});
it.each([
  ['a', 'a/file.txt'],
  ['a/file.txt', 'a'],
  ['A/file.txt', 'a'],
])(
  'rejects file/directory collision %s / %s during creation and verification',
  async (first, second) => {
    const a = await artifact();
    const f = [
      { ...files()[0], path: first },
      { ...files()[0], path: second },
    ];
    await expect(
      createArtifactOutputManifest(a, a.versions[0].versionId, generator, f),
    ).rejects.toThrow(/collision/);
    const manifest = await createArtifactOutputManifest(
      a,
      a.versions[0].versionId,
      generator,
      files(),
    );
    await expect(
      verifyArtifactOutputManifest(manifest, f, {
        source: manifest.source,
        generator,
        dependencies: [],
      }),
    ).rejects.toThrow(/collision/);
  },
);
it('rejects ancestor collisions in a correctly fingerprinted manifest even when actual files are safe', async () => {
  const a = await artifact();
  const f = [
    { ...files()[0], path: 'a' },
    { ...files()[0], path: 'b' },
  ];
  const manifest = await createArtifactOutputManifest(a, a.versions[0].versionId, generator, f);
  const { fingerprint: _fingerprint, ...metadata } = clone(manifest);
  metadata.files[1].path = 'a/file.txt';
  const forged = { ...metadata, fingerprint: await contentHash(metadata) };
  await expect(
    verifyArtifactOutputManifest(forged, f, {
      source: manifest.source,
      generator,
      dependencies: [],
    }),
  ).rejects.toThrow(/collision/);
});
it('rejects a selected version owned by a different Artifact even with a valid hash', async () => {
  const a = await artifact(),
    foreign = await artifact();
  a.versions = [foreign.versions[0]];
  await expect(
    createArtifactOutputManifest(
      a,
      foreign.versions[0].versionId,
      generator,
      files(),
      dependencies,
    ),
  ).rejects.toThrow(/belong|ownership/i);
});
