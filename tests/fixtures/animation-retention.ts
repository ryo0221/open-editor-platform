import {
  createAnimation2,
  createAnimationLayer2,
  createPlayableAnimationEmbed,
} from '@editor-platform/animation-core/v2';
import { reuseHash } from '@editor-platform/reuse-core';
/** Small native source with legal consumer strings whose JSON escapes exceed Slide's budget. */
export function largeConsumerAnimationEmbed() {
  const content = createAnimation2(),
    root = content.compositions[0];
  for (let i = 0; i < 220; i++) {
    const layer = createAnimationLayer2('text', `text-${i}`, root.duration);
    if (layer.type !== 'text') throw Error('Fixture text');
    layer.text = 'A';
    root.layers.push(layer);
    content.publicInputs.push({
      id: `input-${i}`,
      name: `Caption ${i}`,
      kind: 'text',
      default: 'A',
      min: 0,
      max: 20000,
      target: { compositionId: root.id, layerId: layer.id, property: 'text' },
    });
  }
  const embed = createPlayableAnimationEmbed(
    {
      artifactId: 'consumer-budget',
      versionId: 'v1',
      compositionId: root.id,
      contentHash: reuseHash(content),
    },
    content,
    'Consumer budget',
  );
  if (embed.format !== 'animation-embed-2') throw Error('Fixture schema');
  return {
    ...embed,
    inputs: content.publicInputs.map((input) => ({ inputId: input.id, value: '\n'.repeat(20000) })),
  };
}
