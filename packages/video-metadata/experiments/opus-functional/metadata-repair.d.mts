import type { Buffer } from 'node:buffer';
export function repairMetadata(
  bytes: Buffer,
  sourceFrames48k: number,
): { bytes: Buffer; decodedFrames: number; discardFrames: number };
