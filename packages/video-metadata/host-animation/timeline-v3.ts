/** Shared native scene sampling for preview/export; no media decode or hidden latest lookup. */
import {
  add,
  assertVideoContentV3,
  compare,
  multiply,
  subtract,
  type VideoContentV3,
  type Time,
} from '@editor-platform/video-core';
import { prepareVideoAnimationPin } from './native-pin';
export function prepareAnimationTimelineV3(value: VideoContentV3) {
  assertVideoContentV3(value);
  const owned = structuredClone(value);
  const clips = owned.sequence.clips
    .filter((c) => c.kind === 'animation')
    .map((clip) => ({
      clip,
      pin: prepareVideoAnimationPin(clip.embed.source, clip.embed.snapshot),
    }));
  return Object.freeze({
    sample(at: Time, active?: ReadonlySet<string>) {
      // Media and Animation use half-open placement intervals. Boundary ownership is unambiguous.
      return clips
        .filter(({ clip }) => {
          const track = owned.sequence.tracks.find((t) => t.id === clip.trackId)!;
          return (
            track.enabled &&
            (active
              ? active.has(clip.id)
              : compare(at, clip.start) >= 0 && compare(at, add(clip.start, clip.duration)) < 0)
          );
        })
        .map(({ clip, pin }) => ({
          clipId: clip.id,
          trackId: clip.trackId,
          source: pin.source,
          scene: pin.sample(add(clip.sourceIn, multiply(subtract(at, clip.start), clip.rate))),
        }));
    },
  });
}
