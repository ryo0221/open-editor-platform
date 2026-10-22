import { describe, expect, it } from 'vitest';
import {
  commitVersion,
  createArtifact,
  serializeArtifact,
  updateDraft,
} from '@editor-platform/artifact-core';
import { createCounter } from '@editor-platform/extension-sample';
import { readCounterVersions } from './versions';

async function fixture() {
  const first = await commitVersion(
    createArtifact('example.counter', 'Counter', createCounter()),
    null,
    null,
  );
  return commitVersion(updateDraft(first, { id: 'counter', value: 2 }), null, null);
}
describe('Counter Host version admission', () => {
  it('reads exact retained bytes/hash and owns its decoded content', async () => {
    const artifact = await fixture(),
      raw = serializeArtifact(artifact);
    const read = await readCounterVersions(raw);
    expect(serializeArtifact(read)).toBe(raw);
    read.versions[0].content.value = 4;
    expect(artifact.versions[0].content.value).toBe(0);
    expect((await readCounterVersions(raw)).versions[0].content.value).toBe(0);
  });
  it.each(['hash', 'domain', 'missing-parent', 'cycle', 'duplicate', 'base', 'schema'] as const)(
    'refuses corrupt retained history: %s',
    async (mode) => {
      const artifact = JSON.parse(serializeArtifact(await fixture()));
      const first = artifact.versions[0],
        last = artifact.versions[1];
      if (mode === 'hash') first.content.value = 1;
      if (mode === 'domain') artifact.kind = 'other';
      if (mode === 'missing-parent') last.parentVersionId = 'missing';
      if (mode === 'cycle') first.parentVersionId = last.versionId;
      if (mode === 'duplicate') last.versionId = first.versionId;
      if (mode === 'base') artifact.draft.baseVersionId = 'missing';
      if (mode === 'schema') first.schemaVersion = 2;
      await expect(readCounterVersions(JSON.stringify(artifact))).rejects.toThrow();
    },
  );
});
