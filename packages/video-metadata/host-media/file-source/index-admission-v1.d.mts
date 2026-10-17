export function checkIndexV1(
  original: Blob,
  metadata: Blob,
  signal: AbortSignal,
): Promise<{ tracks: number; samples: number }>;
