import type { VideoContentV1 } from './model';
import type { ClipRequest } from '../evaluate';
import { add, compare, multiply, subtract, time, type Time } from '../time';
import { assertVideoContentV1 } from './validation';
/** Stateless source requests, not decoded frames or a render/audio graph. */
export function evaluateSequenceV1(content: VideoContentV1, at: Time): ClipRequest[] {
  assertVideoContentV1(content);
  if (compare(at, time(0)) < 0 || compare(at, content.sequence.duration) >= 0) return [];
  return content.sequence.tracks
    .filter((t) => t.enabled)
    .flatMap((t) =>
      content.sequence.clips
        .filter(
          (c) =>
            c.trackId === t.id &&
            compare(c.start, at) <= 0 &&
            compare(at, add(c.start, c.duration)) < 0,
        )
        .map((c) => {
          const local = subtract(at, c.start);
          const sourceTime =
            c.kind === 'video' ? add(c.sourceIn, multiply(local, c.rate)) : add(c.sourceIn, local);
          return { clipId: c.id, sourceId: c.sourceId, streamId: c.streamId, sourceTime };
        }),
    );
}
