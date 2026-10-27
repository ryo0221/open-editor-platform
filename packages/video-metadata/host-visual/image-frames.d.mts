import type { Time, VideoContentV3 } from '@editor-platform/video-core';
export function createImageFramesV3(
  content: VideoContentV3,
  originals: { sourceId: string; bytes: Blob }[],
  caller: AbortSignal,
): {
  releaseInactive(at: Time): void;
  frameAt(at: Time, caller: AbortSignal): Promise<{ frame: ImageBitmap; release(): void } | null>;
  dispose(): Promise<void>;
};
