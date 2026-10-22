import { expect, it } from 'vitest';
import {
  commitVersion,
  createArtifact,
  serializeArtifact,
  deserializeArtifact,
} from '@editor-platform/artifact-core';
import { upgradeAnimation2 } from '@editor-platform/animation-core/v2';
import { createRectangleAnimation } from '@editor-platform/animation-core';
import {
  applyAnimationMigration,
  previewAnimationMigration,
  type AnimationMigrationHost,
} from './animation-migration';
const signal = () => new AbortController().signal;
async function fixture() {
  const artifact = await commitVersion(
    createArtifact('animation', 'Original', createRectangleAnimation()),
    null,
    null,
  );
  const live = {
    artifact,
    revision: '1',
    canEdit: true,
    pins: {
      sourceReader: `sha256:${'a'.repeat(64)}`,
      targetReader: `sha256:${'b'.repeat(64)}`,
      converter: `sha256:${'c'.repeat(64)}`,
    },
  };
  const host: AnimationMigrationHost = { read: () => live, validateSources: async () => {} };
  return { live, host };
}
it('creates a separate unsaved lineage and serializes origin without modifying retained source', async () => {
  const { live, host } = await fixture(),
    before = serializeArtifact(live.artifact);
  const preview = await previewAnimationMigration(host, signal());
  expect(preview.content).toEqual(upgradeAnimation2(live.artifact.draft.content));
  const target = await applyAnimationMigration(preview, signal());
  expect(target.id).not.toBe(live.artifact.id);
  expect(target.versions).toEqual([]);
  expect(target.draft.baseVersionId).toBeNull();
  expect(target.provenance.migration?.sourceBaseVersionId).toBe(live.artifact.draft.baseVersionId);
  expect(deserializeArtifact(serializeArtifact(target))).toEqual(target);
  expect(serializeArtifact(live.artifact)).toBe(before);
  await expect(applyAnimationMigration(preview, signal())).rejects.toThrow('consumed');
});
it.each(['revision', 'content', 'permission', 'identity'] as const)(
  'rejects changed %s on apply',
  async (change) => {
    const { live, host } = await fixture();
    const preview = await previewAnimationMigration(host, signal());
    if (change === 'revision') live.revision = '2';
    if (change === 'content') live.artifact.draft.content.compositions[0].id = 'edited';
    if (change === 'permission') live.canEdit = false;
    if (change === 'identity') live.artifact.id = 'other';
    const before = serializeArtifact(live.artifact);
    await expect(applyAnimationMigration(preview, signal())).rejects.toThrow();
    expect(serializeArtifact(live.artifact)).toBe(before);
  },
);
it('rejects forged previews and rechecks permission after async closure validation', async () => {
  const { live, host } = await fixture();
  const preview = await previewAnimationMigration(host, signal());
  await expect(applyAnimationMigration(structuredClone(preview), signal())).rejects.toThrow(
    'Unknown',
  );
  host.validateSources = async () => {
    live.canEdit = false;
  };
  await expect(applyAnimationMigration(preview, signal())).rejects.toThrow('permission');
});
it('refuses closure failure and cancellation without altering source', async () => {
  const { live, host } = await fixture(),
    before = serializeArtifact(live.artifact);
  host.validateSources = async () => {
    throw Error('Missing original bytes');
  };
  await expect(previewAnimationMigration(host, signal())).rejects.toThrow('Missing original');
  const controller = new AbortController();
  controller.abort();
  await expect(previewAnimationMigration(host, controller.signal)).rejects.toThrow();
  expect(serializeArtifact(live.artifact)).toBe(before);
});
it('refuses a stale preview completion', async () => {
  const { live, host } = await fixture();
  host.validateSources = async () => {
    live.revision = '2';
  };
  await expect(previewAnimationMigration(host, signal())).rejects.toThrow('changed');
});

it('refuses changed converter and reader pins after preview', async () => {
  for (const key of ['sourceReader', 'targetReader', 'converter'] as const) {
    const { live, host } = await fixture();
    const preview = await previewAnimationMigration(host, signal());
    live.pins[key] = `sha256:${'d'.repeat(64)}`;
    await expect(applyAnimationMigration(preview, signal())).rejects.toThrow('changed');
  }
});

it('preserves animated poses with the existing native converter and records reader pins', async () => {
  const { identityTransform, evaluateAnimation, prepareRectangleAnimationV1Sync } = await import(
    '@editor-platform/animation-core'
  );
  const { evaluateAnimation2, prepareAnimation2 } = await import(
    '@editor-platform/animation-core/v2'
  );
  const { live, host } = await fixture();
  const root = live.artifact.draft.content.compositions[0];
  root.layers.push({
    id: 'box',
    type: 'rect',
    parentId: 'group',
    start: 0,
    end: 960000,
    transform: identityTransform(),
    width: 120,
    height: 80,
    fill: '#aabbcc',
  });
  root.tracks = [
    {
      id: 'motion',
      layerId: 'box',
      property: 'x',
      keys: [
        { id: 'a', tick: 0, value: 0, easing: { type: 'linear' } },
        { id: 'b', tick: 960000, value: 100, easing: { type: 'hold' } },
      ],
    },
  ];
  const preview = await previewAnimationMigration(host, signal());
  expect(preview.sourceContentHash).not.toBe(live.artifact.versions[0].contentHash);
  const target = await applyAnimationMigration(preview, signal());
  expect(target.provenance.migration?.converterPin).toBe(live.pins.converter);
  const before = prepareRectangleAnimationV1Sync(live.artifact.draft.content),
    after = prepareAnimation2(target.draft.content);
  for (const tick of [0, 8000, 480000, 960000]) {
    expect(
      evaluateAnimation2(after, 'root', tick).items.map((item) => ({
        instancePath: item.instancePath,
        layerId: item.id,
        matrix: item.matrix,
        opacity: item.opacity,
        ...('width' in item.layer ? { width: item.layer.width, height: item.layer.height } : {}),
        fill: 'fill' in item.layer ? item.layer.fill : '',
      })),
    ).toEqual(evaluateAnimation(before, 'root', tick).rectangles);
  }
});
