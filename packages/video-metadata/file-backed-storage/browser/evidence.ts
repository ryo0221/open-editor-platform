/** Host-private translation only; never accept extension-provided Result objects as evidence. */
import { canonicalJson } from '@editor-platform/artifact-core';
import type { WriteEvidence } from '@editor-platform/extension-runtime/draft2';
import type { Pin, Result } from './journal';
export function writeEvidence(result: Result, expected: Pin): WriteEvidence {
  if (canonicalJson(result.pin) !== canonicalJson(expected)) return { state: 'unknown' };
  if (result.state === 'saved')
    return {
      state: 'committed',
      operationId: expected.operationId,
      capture: structuredClone(expected.capture),
      adapterReceiptId: `verified-opfs-journal-v0:${expected.sha256}`,
    };
  if (result.state === 'not-written')
    return {
      state: 'no-write',
      operationId: expected.operationId,
      capture: structuredClone(expected.capture),
      guarantee: 'never-writes',
    };
  return { state: 'unknown' };
}
