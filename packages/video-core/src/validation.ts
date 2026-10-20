import type { AudioClip, AudioStream, MediaAssetRef, VideoContent } from './model';
import { add, subtract, compare, time } from './time';
import {
  assertContent,
  assertMediaAssetFields,
  integer,
  requireValue,
  validationResult,
  type ContentSchema,
} from './validation-core';
export function assertMediaAsset(value: unknown): asserts value is MediaAssetRef {
  assertMediaAssetFields(value);
}
const v0: ContentSchema<VideoContent['sequence']['clips'][number], AudioStream> = {
  schema: 'video-core-prototype-v0',
  audioStreamFields: [],
  checkAudioStream() {},
  audioClipFields: ['sampleIn', 'sampleOut'],
  checkAudioClip(c) {
    integer(c.sampleIn, 0);
    integer(c.sampleOut, 1);
  },
  checkAudioWindow(c: AudioClip, stream) {
    requireValue(
      c.sampleOut > c.sampleIn &&
        c.sampleOut <= stream.sampleCount &&
        compare(
          subtract(time(c.sampleOut, stream.sampleRate), time(c.sampleIn, stream.sampleRate)),
          c.duration,
        ) === 0,
      'Invalid audio sample window',
    );
    // Accepted source windows must have representable mapped endpoints, including
    // the exclusive end, before evaluation or editing can consume the content.
    add(stream.presentationOrigin, time(c.sampleIn, stream.sampleRate));
    add(stream.presentationOrigin, time(c.sampleOut, stream.sampleRate));
  },
};
/** Strict prototype-only boundary; unsupported fields are never silently lost. */
export function assertVideoContent(value: unknown): asserts value is VideoContent {
  assertContent<VideoContent, VideoContent['sequence']['clips'][number], AudioStream>(value, v0);
}
export function validateVideoContent(
  value: unknown,
): { valid: true } | { valid: false; reason: string } {
  return validationResult(assertVideoContent, value);
}
