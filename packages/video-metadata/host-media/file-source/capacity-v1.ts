import { validateVideoContentV1, type VideoContentV1 } from '@editor-platform/video-core';
/** Private Host bound for full controlled delivery and save envelopes, not a Core limit. */
export function assertHostCapacityV1(content: VideoContentV1) {
  const long = '\u0000'.repeat(256);
  const scope = { artifactId: long, sessionId: long, generation: long };
  const revision = { kind: 'local-draft', sessionId: long, sequence: Number.MAX_SAFE_INTEGER };
  const capture = { scope, revision, contentHash: 'f'.repeat(64) };
  for (const value of [
    { operationId: long, capture, content },
    {
      state: 'open',
      snapshot: { scope, revision, content },
      canEdit: true,
      canSave: true,
      saving: false,
      lastOperation: { state: 'refused', code: long, message: long },
      lastSave: {
        state: 'committed',
        operationId: long,
        capture,
        receipt: { adapterReceiptId: long, durability: 'adapter-acknowledged' },
      },
    },
  ]) {
    let nodes = 0;
    const visit = (v: unknown, depth: number) => {
      if (++nodes > 4096 || depth > 24) throw Error('VideoHostControlledCapacity');
      if (v && typeof v === 'object') for (const child of Object.values(v)) visit(child, depth + 1);
    };
    visit(value, 0);
    if (new TextEncoder().encode(JSON.stringify(value)).length > 65536)
      throw Error('VideoHostControlledCapacity');
  }
}
export function validateHostV1(value: unknown): value is VideoContentV1 {
  if (!validateVideoContentV1(value).valid) return false;
  try {
    assertHostCapacityV1(value as VideoContentV1);
    return true;
  } catch {
    return false;
  }
}
