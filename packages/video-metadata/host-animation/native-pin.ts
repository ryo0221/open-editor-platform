/** Isolated native admission/sampling port; no Video schema, storage or Host mutation. */
import {
  animationCompositionInputs2,
  createPreparedAnimationEmbed2,
  evaluateAnimation2,
  prepareAnimation2,
  type AnimationEmbed2,
} from '@editor-platform/animation-core/v2';
import { multiply, time, type Time } from '@editor-platform/video-core';

type Source = AnimationEmbed2['source'];

/** The caller resolves an immutable version; this port verifies its exact content hash.
 * Host catalog/retention and permission checks remain required before actual adoption. */
export function prepareVideoAnimationPin(source: Source, snapshot: unknown) {
  const prepared = prepareAnimation2(snapshot);
  const embed = createPreparedAnimationEmbed2(source, prepared, 'Video Animation source');
  const content = embed.snapshot;
  const visited = new Set<string>();
  function visit(id: string) {
    if (visited.has(id)) return;
    visited.add(id);
    const composition = content.compositions.find((c) => c.id === id);
    if (!composition) throw new Error('Video Animation composition missing');
    for (const layer of composition.layers) {
      if (layer.type === 'text' || layer.type === 'image')
        throw new Error(`Video Animation subset excludes ${layer.type}`);
      if (layer.type === 'composition') {
        if (layer.source.type !== 'local')
          throw new Error('Video Animation subset excludes external composition');
        visit(layer.source.compositionId);
      }
    }
  }
  visit(embed.source.compositionId);
  if (animationCompositionInputs2(content, embed.source.compositionId).length)
    throw new Error('Video Animation subset excludes public inputs');
  return Object.freeze({
    source: embed.source,
    snapshot: content,
    /** Source-relative seconds, after the consumer's placement/rate mapping.
     * Exact integer ticks only; preview/export callers share this same sampler. */
    sample(sourceSeconds: Time) {
      const tick = multiply(sourceSeconds, time(content.ticksPerSecond));
      if (tick.timescale !== 1) throw new Error('Video Animation fractional tick');
      return evaluateAnimation2(prepared, embed.source.compositionId, tick.value);
    },
  });
}
