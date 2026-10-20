import { expect, it } from 'vitest';
import { contentHash, clone } from '@editor-platform/artifact-core';
import { createAnimationEmbed, createRectangleAnimation, inspectAnimationEmbed } from './embedding';
import { prepareRectangleAnimationV1Sync } from './prepare';
import { prepareRectangleAnimationV1 } from './v1';
import { evaluateAnimation } from './evaluate';

it('pins exact native bytes and produces the same scene through sync and async admission', async () => {
  const content = createRectangleAnimation();
  content.compositions[0].layers.push({
    id: 'rect',
    type: 'rect',
    parentId: 'group',
    start: 0,
    end: 960000,
    width: 80,
    height: 80,
    fill: '#ff0000',
    transform: { ...content.compositions[0].layers[0].transform, x: 20 },
  });
  content.compositions[0].tracks.push({
    id: 'x',
    layerId: 'rect',
    property: 'x',
    keys: [
      { id: 'a', tick: 0, value: 20, easing: { type: 'linear' } },
      { id: 'b', tick: 960000, value: 300, easing: { type: 'hold' } },
    ],
  });
  const original = clone(content),
    hash = await contentHash(content);
  const embed = createAnimationEmbed(
    { artifactId: 'animation', versionId: 'v1', contentHash: hash, compositionId: 'root' },
    content,
    'Pinned rectangle',
  );
  content.compositions[0].layers[0].transform.x = 400;
  expect(embed.snapshot).toEqual(original);
  const sync = prepareRectangleAnimationV1Sync(original),
    asyncPrepared = await prepareRectangleAnimationV1(original);
  expect(sync.contentHash).toBe(hash);
  for (const tick of [960000, 0, 120000, 480000])
    expect(evaluateAnimation(sync, 'root', tick)).toEqual(
      evaluateAnimation(asyncPrepared, 'root', tick),
    );
  expect(inspectAnimationEmbed(JSON.parse(JSON.stringify(embed))).embed).toEqual(embed);
  expect(() => inspectAnimationEmbed({ ...embed, snapshot: content })).toThrow(/hash-mismatch/);
  expect(() => inspectAnimationEmbed({ ...embed, posterTick: 960001 })).toThrow(/poster-tick/);
  expect(() =>
    inspectAnimationEmbed({ ...embed, source: { ...embed.source, compositionId: 'missing' } }),
  ).toThrow();
  expect(() => inspectAnimationEmbed({ ...embed, playerVersion: 'latest' })).toThrow(/version/);
  expect(() =>
    inspectAnimationEmbed({
      ...embed,
      snapshot: { ...original, schemaVersion: 'animation-prototype-0' },
    }),
  ).toThrow(/expected-v1/);
});
