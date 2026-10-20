import { expect, it } from 'vitest';
import {
  commitVersion,
  createArtifact,
  contentHash,
  canonicalJson,
} from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import { createRectangleAnimation, createAnimationEmbed } from '../embedding';
import { identityTransform } from '../model';
import { evaluateAnimation } from '../evaluate';
import { prepareRectangleAnimationV1Sync } from '../prepare';
import {
  animationPlaybackContent2,
  inspectPlayableAnimationEmbed,
  type AnimationHostContent,
} from './embedding';
import { upgradeAnimationCommand2 } from './commands';
import { evaluateAnimation2, prepareAnimation2 } from './evaluate';

function legacyMotion() {
  const content = createRectangleAnimation();
  content.compositions[0].layers[0].transform = {
    ...identityTransform(),
    x: 25,
    y: -15,
    rotation: 35,
    scaleX: -0.7,
    scaleY: 1.4,
    opacity: 0.6,
  };
  content.compositions[0].layers.push({
    id: 'box',
    type: 'rect',
    parentId: 'group',
    start: 0,
    end: 960000,
    transform: { ...identityTransform(), x: 80, y: 100, anchorX: 20, rotation: -10 },
    width: 120,
    height: 80,
    fill: '#aabbcc',
  });
  content.compositions[0].tracks.push({
    id: 'motion',
    layerId: 'box',
    property: 'x',
    keys: [
      {
        id: 'first',
        tick: 0,
        value: 80,
        easing: { type: 'bezier', x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
      },
      { id: 'last', tick: 960000, value: 500, easing: { type: 'hold' } },
    ],
  });
  return content;
}
it('validates a legacy pin before an in-memory projection and preserves every sampled pose', async () => {
  const content = legacyMotion();
  const embed = createAnimationEmbed(
    {
      artifactId: 'old',
      versionId: 'v1',
      compositionId: 'root',
      contentHash: await contentHash(content),
    },
    content,
    'Legacy',
  );
  const bytes = canonicalJson(embed),
    old = prepareRectangleAnimationV1Sync(embed.snapshot);
  const current = prepareAnimation2(animationPlaybackContent2(embed));
  for (const tick of [0, 8000, 480000, 960000, 1, 700001, 480000]) {
    const previous = evaluateAnimation(old, 'root', tick),
      scene = evaluateAnimation2(current, 'root', tick);
    expect(
      scene.items.map((item) => ({
        instancePath: item.instancePath,
        layerId: item.id,
        matrix: item.matrix,
        opacity: item.opacity,
        ...('width' in item.layer ? { width: item.layer.width, height: item.layer.height } : {}),
        fill: 'fill' in item.layer ? item.layer.fill : '',
      })),
    ).toEqual(previous.rectangles);
  }
  expect(canonicalJson(embed)).toBe(bytes);
  expect(inspectPlayableAnimationEmbed(embed).embed.source.contentHash).toBe(
    await contentHash(content),
  );
  expect(() =>
    animationPlaybackContent2({
      ...embed,
      source: { ...embed.source, contentHash: '0'.repeat(64) },
    }),
  ).toThrow('hash-mismatch');
});
it('migrates only the draft; saves and Undo retain the original version bytes/hash', async () => {
  const original = await commitVersion(
    createArtifact<AnimationHostContent>('animation', 'Old', legacyMotion()),
    'test',
    'Before',
  );
  const versions = canonicalJson(original.versions);
  const session = new EditorSession(original.draft.content);
  const command = upgradeAnimationCommand2(legacyMotion(), { canEdit: () => true });
  session.execute(command);
  expect(session.content.schemaVersion).toBe(2);
  const saved = await commitVersion(
    { ...original, draft: { ...original.draft, content: session.content } },
    'test',
    'After',
  );
  expect(canonicalJson(saved.versions.slice(0, 1))).toBe(versions);
  expect(saved.versions[1].contentHash).not.toBe(saved.versions[0].contentHash);
  session.undo();
  expect(session.content).toEqual(original.draft.content);
  session.redo();
  expect(session.content).toEqual(saved.versions[1].content);
});
it('refuses a stale or revoked migration without changing content or history', () => {
  const content = legacyMotion(),
    session = new EditorSession<AnimationHostContent>(content);
  let canEdit = true;
  const command = upgradeAnimationCommand2(content, { canEdit: () => canEdit });
  canEdit = false;
  expect(() => session.execute(command)).toThrow('read-only');
  expect(session.content).toEqual(content);
  expect(session.canUndo).toBe(false);
  canEdit = true;
  session.execute(command);
  expect(() => session.execute(command)).toThrow();
  session.undo();
  expect(session.content).toEqual(content);
});
