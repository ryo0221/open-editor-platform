import { expect, it } from 'vitest';
import { writeEvidence } from './evidence';
import type { Pin } from './journal';
const pin: Pin = {
  operationId: 'A',
  sha256: 'a'.repeat(64),
  bytes: 40,
  capture: {
    scope: { artifactId: 'video', sessionId: 's', generation: 'g' },
    revision: { kind: 'local-draft', sessionId: 's', sequence: 1 },
    contentHash: 'b'.repeat(64),
  },
};
it('verified committed result carries exact original capture to existing coordinator evidence', () => {
  expect(writeEvidence({ state: 'saved', pin }, pin)).toEqual({
    state: 'committed',
    operationId: 'A',
    capture: pin.capture,
    adapterReceiptId: `verified-opfs-journal-v0:${pin.sha256}`,
  });
});
it('definitive no-write maps only the matching request', () => {
  expect(writeEvidence({ state: 'not-written', pin }, pin)).toMatchObject({
    state: 'no-write',
    guarantee: 'never-writes',
  });
  expect(writeEvidence({ state: 'not-written', pin }, { ...pin, operationId: 'B' })).toEqual({
    state: 'unknown',
  });
});
it.each(['ready', 'unknown', 'stale'] as const)(
  '%s never releases an unknown coordinator claim',
  (state) => {
    expect(writeEvidence({ state, pin }, pin)).toEqual({ state: 'unknown' });
  },
);
it('archive hash, length, capture session and revision mismatch refuse stale evidence', () => {
  for (const expected of [
    { ...pin, bytes: 41 },
    { ...pin, sha256: 'c'.repeat(64) },
    { ...pin, capture: { ...pin.capture, revision: { ...pin.capture.revision, sequence: 2 } } },
    {
      ...pin,
      capture: { ...pin.capture, scope: { ...pin.capture.scope, sessionId: 'new-session' } },
    },
  ])
    expect(writeEvidence({ state: 'saved', pin }, expected)).toEqual({ state: 'unknown' });
});
