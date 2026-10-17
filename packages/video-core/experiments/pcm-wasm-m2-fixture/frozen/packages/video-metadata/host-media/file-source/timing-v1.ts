/** Private preview/export timing adapter. Integer PCM addresses never replace validity. */
import {
  add,
  assertVideoContentV1,
  compare,
  frameTime,
  multiply,
  subtract,
  time,
  type AudioStreamV1,
  type Time,
  type VideoContentV1,
} from '../../../../core';
import { ceilTime, type Mapping } from '../../../video-core/experiments/pcm-renderer/render';
export function audioMappingV1(
  content: VideoContentV1,
  clipId: string,
): {
  mapping: Mapping;
  valid: { start: Time; end: Time };
  stream: AudioStreamV1;
} {
  assertVideoContentV1(content);
  const clip = content.sequence.clips.find((c) => c.id === clipId);
  if (clip?.kind !== 'audio') throw Error('Missing audio clip');
  const stream = content.sources
    .find((s) => s.id === clip.sourceId)!
    .streams.find((s) => s.id === clip.streamId)!;
  if (stream.kind !== 'audio') throw Error('Missing audio stream');
  // The existing renderer addresses n/r. Remove both origins exactly once.
  return structuredClone({
    stream,
    mapping: {
      start: clip.start,
      end: add(clip.start, clip.duration),
      sourceStart: subtract(
        subtract(clip.sourceIn, stream.presentationOrigin),
        stream.sampleOrigin,
      ),
      speed: time(1),
    },
    valid: {
      start: subtract(stream.validity.start, stream.sampleOrigin),
      end: subtract(stream.validity.end, stream.sampleOrigin),
    },
  });
}
/** Output point membership is k/R in [0,T); T is retained independently. */
export function outputSpanV1(end: Time, rate: number) {
  if (compare(end, time(0)) <= 0 || !Number.isSafeInteger(rate) || rate < 1 || rate > 384000)
    throw Error('Invalid output span');
  return { first: 0, end: ceilTime(multiply(end, time(rate))), presentationEnd: { ...end } };
}
/** The last presentation interval may be shorter than one CFR tick. */
export function videoIntervalV1(index: number, fps: Time, presentationEnd: Time) {
  const start = frameTime(index, fps),
    next = frameTime(index + 1, fps);
  if (compare(start, presentationEnd) >= 0) throw Error('Outside output presentation');
  const end = compare(next, presentationEnd) < 0 ? next : presentationEnd;
  return { start, end: { ...end }, duration: subtract(end, start) };
}
