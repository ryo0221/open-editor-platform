import { inspectPlayableAnimationEmbed, type AnimationEmbed2 } from './embedding';
import { animationCommand2, createAnimationLayer2 } from './commands';
import { readAnimation2, sourceIdentity2 } from './validate';
import type { AnimationContent2, Layer2 } from './model';
import { animationSourceProvider2, referencedAnimationSources2 } from './source-retention';
function retained(content: AnimationContent2, embed: AnimationEmbed2) {
  const old = animationSourceProvider2(content, sourceIdentity2(embed.source));
  return old
    ? content.sources
    : [...content.sources, { ref: embed.source, content: embed.snapshot }];
}
/** Retained composition reuse has exact sources and no implicit per-instance input baking. */
export function insertExactAnimation(
  expected: AnimationContent2,
  compositionId: string,
  input: AnimationEmbed2,
  id: string,
  scope: { canEdit(): boolean },
) {
  const inspected = inspectPlayableAnimationEmbed(input);
  if (inspected.kind !== 'scene2') throw Error('Schema 2 source required');
  const embed = inspected.embed;
  if (embed.inputs.length)
    throw Error('Nested reusable sources currently use their published defaults');
  const content = readAnimation2(expected),
    c = content.compositions.find((c) => c.id === compositionId);
  if (!c) throw Error('Missing destination composition');
  const child = embed.snapshot.compositions.find((c) => c.id === embed.source.compositionId)!;
  const layer: Layer2 = {
    ...createAnimationLayer2('group', id, c.duration),
    type: 'composition',
    name: embed.label,
    transform: {
      x: 0,
      y: 0,
      anchorX: 0,
      anchorY: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      opacity: 1,
    },
    source: { type: 'exact', ref: embed.source },
    time: {
      sourceIn: 0,
      sourceOut: child.duration,
      rate: { numerator: 1, denominator: 1 },
      after: 'hold',
    },
  };
  return animationCommand2(
    expected,
    [
      { type: 'content.set', field: 'sources', value: retained(content, embed) },
      { type: 'layer.insert', compositionId, layer },
    ],
    scope,
    'Insert exact Animation source',
  );
}
export function adoptExactAnimation(
  expected: AnimationContent2,
  compositionId: string,
  layerId: string,
  input: AnimationEmbed2,
  scope: { canEdit(): boolean },
) {
  const inspected = inspectPlayableAnimationEmbed(input);
  if (inspected.kind !== 'scene2') throw Error('Schema 2 source required');
  const embed = inspected.embed;
  if (embed.inputs.length)
    throw Error('Nested reusable sources currently use their published defaults');
  const content = readAnimation2(expected),
    layer = content.compositions
      .find((c) => c.id === compositionId)
      ?.layers.find((l) => l.id === layerId);
  if (layer?.type !== 'composition' || layer.source.type !== 'exact')
    throw Error('Choose an exact source layer');
  const child = embed.snapshot.compositions.find((c) => c.id === embed.source.compositionId)!,
    out = Math.min(layer.time.sourceOut, child.duration);
  if (layer.time.sourceIn >= out) throw Error('Source trim is outside the reviewed version');
  content.sources = retained(content, embed);
  const time = { ...layer.time, sourceOut: out };
  layer.source = { type: 'exact', ref: embed.source };
  layer.time = time;
  return animationCommand2(
    expected,
    [
      { type: 'content.set', field: 'sources', value: referencedAnimationSources2(content) },
      {
        type: 'layer.patch',
        compositionId,
        id: layerId,
        patch: {
          source: { type: 'exact', ref: embed.source },
          time,
        },
      },
    ],
    scope,
    'Adopt exact Animation source',
  );
}
