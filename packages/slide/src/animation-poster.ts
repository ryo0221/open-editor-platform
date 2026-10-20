import { isDeepFrozen } from '@editor-platform/artifact-core';
import type { PlayableAnimationEmbed } from '@editor-platform/animation-core/v2';
import { playableAnimationPoster } from '@editor-platform/animation-player/v2';

const unavailable =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#f1f5f9"/><text x="24" y="180" font-family="sans-serif" font-size="24" fill="#334155">Animation preview unavailable</text></svg>',
  );
type PosterPreview = Readonly<
  { status: 'ready'; src: string } | { status: 'unavailable'; src: string; message: string }
>;
const posters = new WeakMap<PlayableAnimationEmbed, PosterPreview>();

/** Output refusal belongs to this object, not to the validity of its containing deck. */
export function slideAnimationPoster(embed: PlayableAnimationEmbed): PosterPreview {
  // Only platform-frozen native trees can retain a result across renders.
  // Mutable/imported values always pass the Player's validation again.
  const immutable = isDeepFrozen(embed);
  const cached = immutable ? posters.get(embed) : undefined;
  if (cached) return cached;
  let result: PosterPreview;
  try {
    result = {
      status: 'ready',
      src: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(playableAnimationPoster(embed)),
    };
  } catch (error) {
    result = {
      status: 'unavailable',
      src: unavailable,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  result = Object.freeze(result);
  if (immutable) posters.set(embed, result);
  return result;
}
