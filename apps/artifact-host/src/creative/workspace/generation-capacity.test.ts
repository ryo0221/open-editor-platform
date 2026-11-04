import { describe, expect, it } from 'vitest';
import { commitVersion, createArtifact, updateDraft } from '@editor-platform/artifact-core';
import { createDesign, makeDesignElement } from '@editor-platform/design/model';
import {
  hostNativeArtifactByteLimit,
  serializeHostNativeArtifact,
} from '@editor-platform/editor-host';
import { assertWorldGenerationCapacity, checkWorldResultCapacity } from './generation-capacity';

describe('World generation native storage budget', () => {
  it('allows the native byte limit exactly and rejects the next UTF-8 byte without changing retained versions', async () => {
    const artifact = await commitVersion(
      createArtifact('design', '容量', createDesign()),
      null,
      'initial',
    );
    const next = await commitVersion(
      updateDraft(artifact, artifact.draft.content),
      null,
      'Host save',
    );
    const currentBytes = new TextEncoder().encode(serializeHostNativeArtifact(next)).length;
    const paddingBytes = hostNativeArtifactByteLimit - currentBytes;
    const boundary = {
      ...artifact,
      // Same real UTF-8 byte boundary, with fewer UTF-16 code units to retain/copy.
      name:
        artifact.name + '界'.repeat(Math.floor(paddingBytes / 3)) + 'x'.repeat(paddingBytes % 3),
    };
    // Strings are immutable. Snapshot every mutable field without serializing the
    // 64 MiB envelope twice just to check that the capacity check did not mutate it.
    const before = { ...structuredClone({ ...boundary, name: '' }), name: boundary.name };
    const assertCurrent = await checkWorldResultCapacity(boundary, boundary.draft.content);
    expect(() => assertCurrent(boundary)).not.toThrow();
    await expect(
      checkWorldResultCapacity({ ...boundary, name: boundary.name + 'x' }, boundary.draft.content),
    ).rejects.toThrow('保存候補');
    expect(boundary).toEqual(before);
  });
  it('includes retained versions, ancestors and four new raster copies before generating', async () => {
    const artifact = createArtifact('design', 'fixture', createDesign());
    await expect(
      assertWorldGenerationCapacity(artifact, artifact.draft.content, 569, 691, 0),
    ).resolves.toBeUndefined();
    await expect(
      assertWorldGenerationCapacity(artifact, artifact.draft.content, 2048, 2048, 0),
    ).rejects.toThrow('容量見積り');
    const retainedBytes = hostNativeArtifactByteLimit - 3 * 1024 * 1024;
    const historical = await commitVersion(
      updateDraft(artifact, {
        ...createDesign(),
        elements: [
          {
            ...makeDesignElement('text'),
            text: '界'.repeat(Math.floor(retainedBytes / 3)) + 'x'.repeat(retainedBytes % 3),
          },
        ],
      }),
      null,
      'historical content',
    );
    const retained = updateDraft(historical, createDesign());
    expect(() => serializeHostNativeArtifact(retained)).not.toThrow();
    await expect(
      assertWorldGenerationCapacity(retained, retained.draft.content, 569, 691, 0),
    ).rejects.toThrow('容量見積り');
    await expect(
      assertWorldGenerationCapacity(
        artifact,
        artifact.draft.content,
        2,
        2,
        hostNativeArtifactByteLimit / 2,
      ),
    ).rejects.toThrow('容量見積り');
    expect(artifact.versions).toEqual([]);
  });
  it('invalidates the final synchronous assertion when another save changes history without changing content', async () => {
    const artifact = createArtifact('design', 'fixture', createDesign());
    const assertion = await checkWorldResultCapacity(artifact, artifact.draft.content);
    const saved = await commitVersion(artifact, null, 'Host save');
    expect(saved.draft.content).toEqual(artifact.draft.content);
    expect(() => assertion(saved)).toThrow('保存版が変わり');
    expect(() => assertion(artifact)).not.toThrow();
  });
});
