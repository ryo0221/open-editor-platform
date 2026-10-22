import { describe, expect, it } from 'vitest';
import type { ReferenceResolver } from '@editor-platform/artifact-references';
import {
  createSchedule,
  type ScheduleDocument,
  type ScheduleLane,
} from '@editor-platform/schedule/model';
import { captureArtifactReferences } from './artifact-references';

const lane: ScheduleLane = {
  id: 'lane-1',
  reference: {
    schemaVersion: 1,
    source: {
      artifactId: 'artifact_data',
      domain: 'data',
      target: { kind: 'timeline', viewId: 'v' },
    },
    mode: 'follow',
    fit: 'contain',
    snapshot: {
      artifactId: 'artifact_data',
      domain: 'data',
      versionId: 'version_1',
      revision: 1,
      contentHash: 'a'.repeat(64),
      content: {},
      dependencies: [],
    },
  },
};

describe('Schedule lane capture in the Playground', () => {
  it('refuses a capture whose newer snapshots push the Schedule past its own limit', async () => {
    const content: ScheduleDocument = { ...createSchedule('UTC'), lanes: [lane] };
    const grown = 'x'.repeat(2 * 1024 * 1024 + 1);
    const resolver = {
      capture: async (items: ScheduleLane[]) =>
        items.map((item) => ({
          ...item,
          reference: {
            ...item.reference,
            snapshot: { ...item.reference.snapshot, content: { grown } },
          },
        })),
    } as unknown as ReferenceResolver;
    await expect(captureArtifactReferences(content, resolver)).rejects.toThrow();
    // Within the limit the captured lanes are kept.
    const small = {
      capture: async (items: ScheduleLane[]) => items,
    } as unknown as ReferenceResolver;
    await expect(captureArtifactReferences(content, small)).resolves.toMatchObject({
      lanes: [{ id: 'lane-1' }],
    });
  });
});
