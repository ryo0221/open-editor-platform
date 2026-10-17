/** Private planning seam only; no new native fields, mix policy or codec admission. */
import {
  assertVideoContentV1,
  evaluateSequenceV1,
  isTime,
  subtract,
  type Time,
  type VideoContentV1,
} from '@editor-platform/video-core';
import { audioMappingV1, outputSpanV1 } from '../file-source/timing-v1';
import { sampleSpan } from '../../../video-core/experiments/pcm-renderer/render';
export function prepareSourceRequests(content: VideoContentV1) {
  assertVideoContentV1(content);
  const owned = structuredClone(content),
    outputRate = 48000;
  const sampleCount =
    owned.sequence.duration.value === 0 ? 0 : outputSpanV1(owned.sequence.duration, outputRate).end;
  const clips = new Map(owned.sequence.clips.map((clip) => [clip.id, clip]));
  const audio = owned.sequence.tracks
    .filter((track) => track.enabled)
    .flatMap((track) =>
      owned.sequence.clips
        .filter((clip) => clip.trackId === track.id && clip.kind === 'audio')
        .map((clip) => {
          const source = owned.sources.find((s) => s.id === clip.sourceId)!;
          const timing = audioMappingV1(owned, clip.id);
          return {
            clipId: clip.id,
            sourceId: source.id,
            streamId: clip.streamId,
            asset: source.asset,
            ...timing,
            span: sampleSpan(timing.mapping, outputRate),
          };
        }),
    );
  return {
    outputRate,
    sampleCount,
    videoAt(at: Time) {
      if (!isTime(at)) throw Error('Invalid sequence time');
      return evaluateSequenceV1(owned, at)
        .filter((request) => clips.get(request.clipId)!.kind === 'video')
        .map((request) => {
          const source = owned.sources.find((s) => s.id === request.sourceId)!;
          const stream = source.streams.find((s) => s.id === request.streamId)!;
          return structuredClone({
            ...request,
            asset: source.asset,
            rawTime: subtract(request.sourceTime, stream.presentationOrigin),
          });
        });
    },
    audioWindow(first: number, end: number) {
      if (
        !Number.isSafeInteger(first) ||
        !Number.isSafeInteger(end) ||
        first < 0 ||
        end <= first ||
        end > sampleCount ||
        end - first > 4096
      )
        throw Error('Invalid bounded audio output window');
      return audio.flatMap(({ span, ...request }) => {
        const a = Math.max(first, span.first),
          b = Math.min(end, span.end);
        return a < b ? [structuredClone({ ...request, first: a, end: b })] : [];
      });
    },
  };
}
