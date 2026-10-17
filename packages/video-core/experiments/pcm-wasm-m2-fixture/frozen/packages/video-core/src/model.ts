import type { Time } from './time';
export interface MediaAssetRef {
  assetId: string;
  sha256: string;
  byteLength: number;
}
export interface VideoStream {
  id: string;
  kind: 'video';
  timebase: Time;
  startPts: number;
  endPts: number;
  /** Presentation time of raw PTS 0; metadata is preserved, not rebased away. */
  presentationOrigin: Time;
}
export interface AudioStream {
  id: string;
  kind: 'audio';
  sampleRate: number;
  sampleCount: number;
  presentationOrigin: Time;
}
export interface MediaSource {
  id: string;
  asset: MediaAssetRef;
  streams: (VideoStream | AudioStream)[];
}
export interface Track {
  id: string;
  kind: 'visual' | 'audio';
  locked: boolean;
  enabled: boolean;
}
interface ClipBase {
  id: string;
  trackId: string;
  sourceId: string;
  streamId: string;
  start: Time;
  duration: Time;
  linkGroupId?: string;
}
export interface VideoClip extends ClipBase {
  kind: 'video';
  sourceIn: Time;
  sourceOut: Time;
  rate: Time;
}
export interface AudioClip extends ClipBase {
  kind: 'audio';
  sampleIn: number;
  sampleOut: number;
}
export type Clip = VideoClip | AudioClip;
export interface VideoContent {
  schema: 'video-core-prototype-v0';
  sequence: { id: string; duration: Time; frameRate: Time; tracks: Track[]; clips: Clip[] };
  sources: MediaSource[];
}
/** Isolated proposal ONLY: not accepted in VideoContent until #74 closure/API review. */
export interface ProvisionalExactAnimationRef {
  artifactId: string;
  versionId: string;
  contentHash: string;
  compositionId: string;
}
