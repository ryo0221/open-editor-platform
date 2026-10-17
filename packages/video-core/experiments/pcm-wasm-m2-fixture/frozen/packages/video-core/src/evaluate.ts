import type { VideoContent } from './model';
import { add, compare, multiply, subtract, time, type Time } from './time';
import { assertVideoContent } from './validation';
export interface ClipRequest {
  clipId: string;
  sourceId: string;
  streamId: string;
  sourceTime: Time;
}
/** Stateless source requests, not decoded frames or a render/audio graph. */
export function evaluateSequence(content: VideoContent, at: Time): ClipRequest[] {
  assertVideoContent(content);
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
          const stream = content.sources
            .find((s) => s.id === c.sourceId)!
            .streams.find((s) => s.id === c.streamId)!;
          const local = subtract(at, c.start);
          const sourceTime =
            c.kind === 'video'
              ? add(c.sourceIn, multiply(local, c.rate))
              : add(
                  stream.presentationOrigin,
                  add(time(c.sampleIn, stream.kind === 'audio' ? stream.sampleRate : 1), local),
                );
          return { clipId: c.id, sourceId: c.sourceId, streamId: c.streamId, sourceTime };
        }),
    );
}
