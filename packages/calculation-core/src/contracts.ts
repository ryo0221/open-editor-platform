import { contentHash } from '@editor-platform/artifact-core';
import { CalculationError } from './decimal';
import { assertJson, identifier, record } from './json';
export interface SourcePin {
  artifactId: string;
  domain: 'data' | 'cad' | 'bim';
  versionId: string;
  contentHash: string;
}
export type SourceAccess = 'available' | 'missing' | 'forbidden' | 'offline';
export function assertPin(value: unknown): asserts value is SourcePin {
  const r = record(value, ['artifactId', 'domain', 'versionId', 'contentHash']);
  identifier(r.artifactId);
  identifier(r.versionId);
  if (
    !['data', 'cad', 'bim'].includes(String(r.domain)) ||
    typeof r.contentHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(r.contentHash)
  )
    throw new CalculationError('invalid-source-pin');
}
export const pinKey = (pin: SourcePin) =>
  JSON.stringify([pin.domain, pin.artifactId, pin.versionId, pin.contentHash]);
export async function inspectSavedSource(
  pin: SourcePin,
  content: unknown,
  validate: (value: unknown) => boolean,
): Promise<void> {
  assertPin(pin);
  assertJson(content);
  if (!validate(content)) throw new CalculationError('invalid-source');
  if ((await contentHash(content)) !== pin.contentHash)
    throw new CalculationError('source-hash-mismatch');
}
/** Captured at start and checked at completion by domain/Host code; no job runtime here. */
export interface CalculationTicket {
  requestId: string;
  revision: string;
  basisHash: string;
  generation: number;
}
export function assertTicket(
  expected: CalculationTicket,
  live: CalculationTicket,
  canEdit: boolean,
): void {
  if (!canEdit) throw new CalculationError('read-only');
  if (
    expected.requestId !== live.requestId ||
    expected.revision !== live.revision ||
    expected.basisHash !== live.basisHash ||
    expected.generation !== live.generation
  )
    throw new CalculationError('stale-result');
}
