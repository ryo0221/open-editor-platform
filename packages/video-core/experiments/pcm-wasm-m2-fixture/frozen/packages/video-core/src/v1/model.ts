/** Opt-in native v1. No implicit conversion of retained v0 records. */
import type { AudioClip, AudioStream, MediaSource, VideoClip, VideoContent } from '../model';
import type { Time } from '../time';
export interface AudioStreamV1 extends AudioStream {
  /** Raw media time of integer decoded sample address zero. */
  sampleOrigin: Time;
  /** Original half-open raw-media validity; independent of decoded grid extent. */
  validity: { start: Time; end: Time };
}
export interface AudioClipV1 extends Omit<AudioClip, 'sampleIn' | 'sampleOut'> {
  /** Source presentation coordinates: raw media time + stream.presentationOrigin. */
  sourceIn: Time;
  sourceOut: Time;
}
export type ClipV1 = VideoClip | AudioClipV1;
export interface MediaSourceV1 extends Omit<MediaSource, 'streams'> {
  streams: (Extract<MediaSource['streams'][number], { kind: 'video' }> | AudioStreamV1)[];
}
export interface VideoContentV1 extends Omit<VideoContent, 'schema' | 'sequence' | 'sources'> {
  schema: 'video-core-prototype-v1';
  sequence: Omit<VideoContent['sequence'], 'clips'> & { clips: ClipV1[] };
  sources: MediaSourceV1[];
}
