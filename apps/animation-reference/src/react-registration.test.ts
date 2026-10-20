import { expect, it } from 'vitest';
import { exportReactUi } from '@editor-platform/react-ui-core';
import {
  createAnimation2,
  createPlayableAnimationEmbed,
  inspectPlayableAnimationEmbed,
} from '@editor-platform/animation-core/v2';
import { reuseHash } from '@editor-platform/reuse-core';
import { createAnimationReactDocument, animationReactResolution } from './react-registration';
import { RegisteredAnimationPlayer } from './registered-player';

it('enforces UTF-8 admission on direct registered native props before parsing or mounting', async () => {
  const { createAnimationLayer2, encodeAnimationBase64, hashAnimationBytes2 } = await import(
    '@editor-platform/animation-core/v2'
  );
  const content = createAnimation2(),
    bytes = new TextEncoder().encode('OTTO00000000');
  content.assets = [
    {
      id: 'font',
      contentHash: hashAnimationBytes2(bytes),
      mediaType: 'font/otf',
      base64: encodeAnimationBase64(bytes),
      attribution: 'Header fixture',
      license: 'Test',
    },
  ];
  for (let i = 0; i < 55; i++) {
    const layer = createAnimationLayer2('text', 'caption-' + i, 960000);
    if (layer.type !== 'text') throw Error('Text fixture');
    layer.fontAssetId = 'font';
    content.compositions[0].layers.push(layer);
    content.publicInputs.push({
      id: 'input-' + i,
      name: 'Caption',
      kind: 'text',
      default: 'Text',
      min: 0,
      max: 0,
      target: { compositionId: 'root', layerId: layer.id, property: 'text' },
    });
  }
  const embed = createPlayableAnimationEmbed(
    {
      artifactId: 'source',
      versionId: 'v1',
      compositionId: 'root',
      contentHash: reuseHash(content),
    },
    content,
    'Direct imported native',
  );
  if (embed.format !== 'animation-embed-2') throw Error('Scene fixture');
  const direct = {
      ...embed,
      inputs: content.publicInputs.map((i) => ({ inputId: i.id, value: 'あ'.repeat(20000) })),
    },
    native = JSON.stringify(direct);
  expect(native.length).toBeLessThan(3 * 1024 * 1024);
  expect(new TextEncoder().encode(native).byteLength).toBeGreaterThan(3 * 1024 * 1024);
  const document = createAnimationReactDocument(embed);
  const imported = structuredClone(document);
  imported.nodes[0].props.native = native;
  const { loadReactUiDocument } = await import('@editor-platform/react-ui-core');
  expect(() => loadReactUiDocument(imported)).not.toThrow();
  expect(inspectPlayableAnimationEmbed(direct).embed).toEqual(direct);
  expect(() => RegisteredAnimationPlayer({ native })).toThrow('3 MiB');
  const below = JSON.stringify({
    ...direct,
    inputs: direct.inputs.map((i) => ({ ...i, value: 'あ'.repeat(18000) })),
  });
  expect(new TextEncoder().encode(below).byteLength).toBeLessThan(3 * 1024 * 1024);
  expect(() => RegisteredAnimationPlayer({ native: below })).not.toThrow();
});
it('exports a registered native Player with retained exact source data and refuses an unresolved runtime pin', () => {
  const content = createAnimation2(),
    embed = createPlayableAnimationEmbed(
      {
        artifactId: 'source',
        versionId: 'v1',
        compositionId: 'root',
        contentHash: reuseHash(content),
      },
      content,
      'Motion',
    ),
    document = createAnimationReactDocument(embed),
    bundle = exportReactUi(document, animationReactResolution);
  expect(bundle.files['Screen.tsx']).toContain('@animation-reference/player');
  expect(bundle.files['composition.json']).toContain(embed.source.contentHash);
  expect(() =>
    exportReactUi(document, { ...animationReactResolution, dependencies: [] }),
  ).toThrow();
  expect(document.nodes[0].props.native).toBe(JSON.stringify(embed));
});

// Multi-MiB image fixtures: coverage instrumentation slows their byte loops several-fold.
it('admits base64-expanded 1.6 MiB resources and explicitly refuses the registered subset bound', async () => {
  const { readFileSync } = await import('node:fs');
  const { encodeAnimationBase64, hashAnimationBytes2 } = await import(
    '@editor-platform/animation-core/v2'
  );
  const content = createAnimation2();
  function embedWithAsset(size: number) {
    const bytes = new Uint8Array(size);
    bytes.set(readFileSync('tests/fixtures/office/images/quadrants.png'));
    content.assets = [
      {
        id: 'image',
        mediaType: 'image/png',
        base64: encodeAnimationBase64(bytes),
        contentHash: hashAnimationBytes2(bytes),
        license: 'Fixture',
        attribution: 'Fixture',
      },
    ];
    return createPlayableAnimationEmbed(
      {
        artifactId: 'source',
        versionId: 'v1',
        compositionId: 'root',
        contentHash: reuseHash(content),
      },
      content,
      'Large portable resource',
    );
  }
  const admitted = createAnimationReactDocument(embedWithAsset(Math.floor(1.6 * 1024 * 1024)));
  expect(exportReactUi(admitted, animationReactResolution).files['composition.json']).toContain(
    'Large portable resource',
  );
  expect(() => createAnimationReactDocument(embedWithAsset(2 * 1024 * 1024))).not.toThrow();
  const large = createAnimation2();
  large.assets = [...content.assets, { ...content.assets[0], id: 'second' }];
  const embed = createPlayableAnimationEmbed(
    { artifactId: 'source', versionId: 'v1', compositionId: 'root', contentHash: reuseHash(large) },
    large,
    'Too large for registered React',
  );
  expect(() => createAnimationReactDocument(embed)).toThrow('3 MiB');
}, 30000);
