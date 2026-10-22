import { expect, it } from 'vitest';
import {
  commitVersion,
  createArtifact,
  serializeArtifact,
  deserializeArtifact,
} from '@editor-platform/artifact-core';
import { adoptVideoContentV2 } from '@editor-platform/video-core';
import { emptyV1Fixture } from '../file-backed-storage/portable/v1-fixture';
import { applyVideoMigration, previewVideoMigration, type VideoMigrationHost } from './v1-v2';
const signal = () => new AbortController().signal;
async function fixture() {
  const artifact = await commitVersion(
    createArtifact('video', 'Original', emptyV1Fixture()),
    null,
    null,
  );
  const live = { artifact, revision: '1', canEdit: true };
  const host: VideoMigrationHost = { read: () => live, validateSources: async () => {} };
  return { live, host };
}
it('creates a separate unsaved lineage and serializes origin without modifying retained source', async () => {
  const { live, host } = await fixture(),
    before = serializeArtifact(live.artifact);
  const preview = await previewVideoMigration(host, signal());
  expect(preview.content).toEqual(adoptVideoContentV2(live.artifact.draft.content));
  const target = await applyVideoMigration(preview, signal());
  expect(target.id).not.toBe(live.artifact.id);
  expect(target.versions).toEqual([]);
  expect(target.draft.baseVersionId).toBeNull();
  expect(target.provenance.migration?.sourceBaseVersionId).toBe(live.artifact.draft.baseVersionId);
  expect(deserializeArtifact(serializeArtifact(target))).toEqual(target);
  expect(serializeArtifact(live.artifact)).toBe(before);
  await expect(applyVideoMigration(preview, signal())).rejects.toThrow('consumed');
});
it.each(['revision', 'content', 'permission', 'identity'] as const)(
  'rejects changed %s on apply',
  async (change) => {
    const { live, host } = await fixture();
    const preview = await previewVideoMigration(host, signal());
    if (change === 'revision') live.revision = '2';
    if (change === 'content') live.artifact.draft.content.sequence.id = 'edited';
    if (change === 'permission') live.canEdit = false;
    if (change === 'identity') live.artifact.id = 'other';
    const before = serializeArtifact(live.artifact);
    await expect(applyVideoMigration(preview, signal())).rejects.toThrow();
    expect(serializeArtifact(live.artifact)).toBe(before);
  },
);
it('rejects forged previews and rechecks permission after async closure validation', async () => {
  const { live, host } = await fixture();
  const preview = await previewVideoMigration(host, signal());
  await expect(applyVideoMigration(structuredClone(preview), signal())).rejects.toThrow('Unknown');
  host.validateSources = async () => {
    live.canEdit = false;
  };
  await expect(applyVideoMigration(preview, signal())).rejects.toThrow('permission');
});
it('refuses closure failure and cancellation without altering source', async () => {
  const { live, host } = await fixture(),
    before = serializeArtifact(live.artifact);
  host.validateSources = async () => {
    throw Error('Missing original bytes');
  };
  await expect(previewVideoMigration(host, signal())).rejects.toThrow('Missing original');
  const controller = new AbortController();
  controller.abort();
  await expect(previewVideoMigration(host, controller.signal)).rejects.toThrow();
  expect(serializeArtifact(live.artifact)).toBe(before);
});
it('refuses a stale preview completion', async () => {
  const { live, host } = await fixture();
  host.validateSources = async () => {
    live.revision = '2';
  };
  await expect(previewVideoMigration(host, signal())).rejects.toThrow('changed');
});

it('preserves A/V source coordinates while introducing unity gain and zero fades', async () => {
  const { v1Fixture } = await import('../file-backed-storage/portable/v1-fixture');
  const { scan } = await import('../file-backed-storage/io');
  const project = await v1Fixture(scan);
  const artifact = createArtifact('video', 'A/V', project.versions[1].content);
  const host: VideoMigrationHost = {
    read: () => ({ artifact, revision: '1', canEdit: true }),
    validateSources: async (content) => {
      expect(content.sources).toEqual(project.versions[1].content.sources);
    },
  };
  const migrated = await applyVideoMigration(await previewVideoMigration(host, signal()), signal());
  expect(migrated.draft.content.sources).toEqual(artifact.draft.content.sources);
  const audio = migrated.draft.content.sequence.clips.filter((c) => c.kind === 'audio');
  expect(audio.length).toBeGreaterThan(0);
  for (const clip of audio) {
    expect(clip.gain).toBe(1);
    expect(clip.fade).toEqual({
      start: clip.sourceIn,
      end: clip.sourceOut,
      in: { value: 0, timescale: 1 },
      out: { value: 0, timescale: 1 },
    });
  }
});
