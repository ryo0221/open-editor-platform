import { expect, it } from 'vitest';
import { reuseHash } from '@editor-platform/reuse-core';
import {
  animationCommand2,
  animationLayerSystemFont2,
  animationSystemFontText2,
  createAnimation2,
  createAnimationLayer2,
  createPlayableAnimationEmbed,
  encodeAnimationBase64,
  hashAnimationBytes2,
  prepareAnimation2,
  readAnimation2,
} from '@editor-platform/animation-core/v2';
import { planAnimationFrame2, playableAnimationPoster } from './scene2';

function japaneseText(pinned = false) {
  const content = createAnimation2(),
    root = content.compositions[0],
    layer = createAnimationLayer2('text', 'title', root.duration);
  if (layer.type !== 'text') throw Error();
  layer.text = '洋上風力';
  layer.runs = [{ text: layer.text }];
  if (pinned) {
    const bytes = Uint8Array.from([0, 1, 0, 0, 1, 2, 3, 4]);
    content.assets = [
      {
        id: 'font',
        contentHash: hashAnimationBytes2(bytes),
        mediaType: 'font/otf',
        base64: encodeAnimationBase64(bytes),
        attribution: 'Test font',
        license: 'Test',
      },
    ];
    layer.fontAssetId = 'font';
  }
  root.layers = [layer];
  return content;
}

it('keeps non-ASCII text without a pinned font as a provisional system-font display', () => {
  const content = japaneseText();
  expect(() => readAnimation2(content)).not.toThrow();
  expect(animationLayerSystemFont2(content, 'root', 'title')).toBe(true);
  expect(animationSystemFontText2(content)).toBe(true);
  expect(animationSystemFontText2(japaneseText(true))).toBe(false);
  const ascii = createAnimation2(),
    plain = createAnimationLayer2('text', 'plain', ascii.compositions[0].duration);
  ascii.compositions[0].layers = [plain];
  expect(animationSystemFontText2(ascii)).toBe(false);
});

it('accepts typing Japanese into a text layer without a font as one edit', () => {
  const content = createAnimation2(),
    root = content.compositions[0];
  root.layers = [createAnimationLayer2('text', 'title', root.duration)];
  const next = animationCommand2(
    content,
    [
      {
        type: 'layer.patch',
        compositionId: 'root',
        id: 'title',
        patch: { text: '送電網', runs: [{ text: '送電網' }] },
      },
    ],
    { canEdit: () => true },
  ).apply(content);
  expect(next.compositions[0].layers[0]).toMatchObject({ text: '送電網', fontAssetId: null });
});

it('plays and places the system-font text but refuses a static frame without a pinned font', () => {
  const content = japaneseText(),
    embed = createPlayableAnimationEmbed(
      { artifactId: 'a', versionId: 'v1', compositionId: 'root', contentHash: reuseHash(content) },
      content,
      'Title',
    );
  expect(playableAnimationPoster(embed)).toContain('font-family="sans-serif"');
  expect(() => planAnimationFrame2(prepareAnimation2(content), 'root', 0)).toThrow(
    'Pin a font asset for non-ASCII text before exporting a static frame',
  );
  const ascii = createAnimation2();
  ascii.compositions[0].layers = [
    createAnimationLayer2('text', 'plain', ascii.compositions[0].duration),
  ];
  expect(planAnimationFrame2(prepareAnimation2(ascii), 'root', 0).losses).toHaveLength(1);
});

it('treats a Japanese consumer input on an unpinned text layer as system-font text', () => {
  const content = createAnimation2(),
    root = content.compositions[0];
  root.layers = [createAnimationLayer2('text', 'title', root.duration)];
  content.publicInputs = [
    {
      id: 'headline',
      name: 'Headline',
      kind: 'text',
      default: 'Wind',
      min: 0,
      max: 0,
      target: { compositionId: 'root', layerId: 'title', property: 'text' },
    },
  ];
  expect(animationSystemFontText2(content)).toBe(false);
  expect(animationSystemFontText2(content, [{ inputId: 'headline', value: '風力' }])).toBe(true);
});
