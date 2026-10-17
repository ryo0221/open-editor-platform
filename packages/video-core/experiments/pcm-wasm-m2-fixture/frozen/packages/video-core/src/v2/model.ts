/** Explicit private v2 opt-in. Generic Artifact envelope remains version 1. */
import type { AudioClipV1, VideoContentV1 } from '../v1/model';
import type { VideoClip } from '../model';
import type { Time } from '../time';
export interface AudioFadeV2 {
  /** Fixed source-presentation anchors: trims/splits preserve this function. */
  start: Time;
  end: Time;
  in: Time;
  out: Time;
}
export interface AudioClipV2 extends AudioClipV1 {
  gain: number;
  fade: AudioFadeV2;
}
export type ClipV2 = VideoClip | AudioClipV2;
export interface VideoContentV2 extends Omit<VideoContentV1, 'schema' | 'sequence'> {
  schema: 'video-core-prototype-v2';
  sequence: Omit<VideoContentV1['sequence'], 'clips'> & { clips: ClipV2[] };
}
