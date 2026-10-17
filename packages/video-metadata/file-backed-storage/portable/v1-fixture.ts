/** Synthetic fractional native and parent-only closure, never actual media. */
import { contentHash, type ArtifactVersion } from '@editor-platform/artifact-core';
import { time, type VideoContentV1 } from '@editor-platform/video-core';
import { prepareImportSetV1, type ImportSetV1 } from '../../host-media/file-source/import-v1';
import { memory, type Scanner } from './io';
import type { Project } from './project';
export function emptyV1Fixture(): VideoContentV1 {
  return {
    schema: 'video-core-prototype-v1',
    sources: [],
    sequence: {
      id: 'sequence',
      duration: time(0),
      frameRate: time(25),
      clips: [],
      tracks: [
        { id: 'visual', kind: 'visual', enabled: true, locked: false },
        { id: 'audio', kind: 'audio', enabled: true, locked: false },
      ],
    },
  };
}
export async function v1Fixture(
  scan: Scanner,
  selectedEmpty = false,
  byteCount = 4,
): Promise<Project<VideoContentV1, ImportSetV1>> {
  const bytes = Uint8Array.from({ length: byteCount }, (_, i) => i % 251),
    original = memory(bytes),
    hash = (await scan(original, new AbortController().signal)).sha256;
  const plan: ImportSetV1 = {
    format: 'video-media-interpretation-v1',
    streams: [
      {
        id: 'v',
        kind: 'video',
        destination: 'visual',
        mediaStart: time(0),
        mediaEnd: time(42251, 600),
        presentationStart: time(0),
      },
      {
        id: 'a',
        kind: 'audio',
        destination: 'audio',
        mediaStart: time(0),
        mediaEnd: time(42251, 600),
        presentationStart: time(0),
        sampleRate: 44100,
        sampleCount: 3107840,
        sampleOrigin: time(0),
      },
    ],
  };
  const content = prepareImportSetV1(
    emptyV1Fixture(),
    plan,
    { assetId: 'original', sha256: hash, byteLength: bytes.length },
    'source',
  );
  const versions: ArtifactVersion<VideoContentV1>[] = [];
  for (const [i, value] of [
    content,
    selectedEmpty ? emptyV1Fixture() : structuredClone(content),
  ].entries())
    versions.push({
      artifactId: 'v1-synthetic',
      versionId: 'version' + i,
      parentVersionId: i ? 'version0' : null,
      schemaVersion: 1,
      content: value,
      contentHash: await contentHash(value),
      createdAt: '2026-10-13T00:00:00Z',
      createdBy: null,
      reason: null,
    });
  return {
    operationId: 'v1-fixture',
    capture: {
      scope: { artifactId: 'v1-synthetic', sessionId: 'session', generation: 'generation' },
      revision: { kind: 'local-draft', sessionId: 'session', sequence: 1 },
      contentHash: versions[1].contentHash,
    },
    selectedVersionId: 'version1',
    versions,
    plans: [{ sourceId: 'source', plan }],
    originals: new Map([[hash, original]]),
  };
}
