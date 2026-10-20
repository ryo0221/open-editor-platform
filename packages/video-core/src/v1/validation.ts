import type { AudioClipV1, AudioStreamV1, ClipV1, VideoContentV1 } from './model';
import { add, compare, multiply, subtract, time } from '../time';
import {
  assertContent,
  fields,
  rational,
  requireValue,
  validationResult,
  type ContentSchema,
} from '../validation-core';
// Integer sample points satisfy start <= origin+n/r < end. A positive
// interval alone can contain none; never defer this invariant to a decoder.
function ceilSamplePoint(t: AudioStreamV1['sampleOrigin'], stream: AudioStreamV1) {
  const { sampleOrigin, sampleRate } = stream;
  const n =
    (BigInt(t.value) * BigInt(sampleOrigin.timescale) -
      BigInt(sampleOrigin.value) * BigInt(t.timescale)) *
    BigInt(sampleRate);
  const d = BigInt(t.timescale) * BigInt(sampleOrigin.timescale);
  return n / d + (n % d > 0n ? 1n : 0n);
}
const v1: ContentSchema<ClipV1, AudioStreamV1> = {
  schema: 'video-core-prototype-v1',
  audioStreamFields: ['sampleOrigin', 'validity'],
  checkAudioStream(st) {
    rational(st.sampleOrigin);
    const valid = fields(st.validity, ['start', 'end']);
    rational(valid.start);
    rational(valid.end);
  },
  audioClipFields: ['sourceIn', 'sourceOut'],
  checkAudioClip(c) {
    rational(c.sourceIn);
    rational(c.sourceOut);
  },
  checkTypedAudioStream(stream) {
    const { validity, sampleOrigin, sampleRate, sampleCount } = stream;
    requireValue(
      compare(validity.start, validity.end) < 0 &&
        compare(validity.start, sampleOrigin) >= 0 &&
        compare(validity.end, add(sampleOrigin, time(sampleCount, sampleRate))) <= 0,
      'Invalid original audio validity',
    );
    requireValue(
      ceilSamplePoint(validity.start, stream) < ceilSamplePoint(validity.end, stream),
      'Original audio validity contains no sample points',
    );
    // Renderer coordinates remove the grid origin. Keep the existing Time
    // representability bound instead of admitting a source unusable downstream.
    multiply(subtract(validity.start, sampleOrigin), time(sampleRate));
    multiply(subtract(validity.end, sampleOrigin), time(sampleRate));
    add(stream.presentationOrigin, validity.start);
    add(stream.presentationOrigin, validity.end);
  },
  checkAudioWindow(c: AudioClipV1, stream) {
    const lo = add(stream.presentationOrigin, stream.validity.start);
    const hi = add(stream.presentationOrigin, stream.validity.end);
    requireValue(
      compare(c.sourceIn, lo) >= 0 &&
        compare(c.sourceOut, hi) <= 0 &&
        compare(subtract(c.sourceOut, c.sourceIn), c.duration) === 0,
      'Invalid audio presentation window',
    );
    for (const at of [c.sourceIn, c.sourceOut])
      multiply(
        subtract(subtract(at, stream.presentationOrigin), stream.sampleOrigin),
        time(stream.sampleRate),
      );
  },
};
/** Strict prototype-only boundary; unsupported fields are never silently lost. */
export function assertVideoContentV1(value: unknown): asserts value is VideoContentV1 {
  assertContent<VideoContentV1, ClipV1, AudioStreamV1>(value, v1);
}
export function validateVideoContentV1(
  value: unknown,
): { valid: true } | { valid: false; reason: string } {
  return validationResult(assertVideoContentV1, value);
}
