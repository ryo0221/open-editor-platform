import type { Time, VideoContentV2 } from '@editor-platform/video-core';
export interface VisualFrameV2 {
  frame: VideoFrame;
  sourceId: string;
  clipId: string;
  sourceTime: Time;
  rawTime: Time;
  rotation: number;
  scale: number;
  release(): void;
}
export function createVisualV2(
  content: VideoContentV2,
  originals: Map<string, Blob>,
  caller: AbortSignal,
  selectRequests?: (
    at: Time,
  ) => { sourceId: string; clipId: string; sourceTime: Time; rawTime: Time }[],
): Promise<{
  releaseInactive(at: Time): void;
  framesAt(at: Time, signal: AbortSignal, single?: boolean): Promise<VisualFrameV2[]>;
  frameAt(at: Time, signal: AbortSignal): Promise<VisualFrameV2 | null>;
  dispose(): Promise<void>;
}>;
