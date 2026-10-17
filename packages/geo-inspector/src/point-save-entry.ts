/** Provisional source-free native saving; no new shared storage or history contract. */
import { assertGeo, type Budgets, type GeoDocument } from '@editor-platform/geo-core';
import { contentHash } from '@editor-platform/artifact-core';
import type { LocalReadSnapshot } from '@editor-platform/extension-contract/draft2';
import { geoPointEditorDefinition, type PointControllerFactory } from './point-edit/definition';
import { assertSourceFree } from './point-edit/model';
export { draftFor } from './point-edit/model';
export type { PointDraft } from './point-edit/model';
export { pointEditPort } from './point-edit/definition';
/** Same pinned protocol limits, including representative worst-case Host envelope fields.
 * This experimental profile bounds scope/receipt strings to 128 UTF-16 code units.
 * Six-byte escapes are used below so non-ASCII/control characters cannot undercount.
 */
export function assertGeoSaveCapacity(
  snapshot: LocalReadSnapshot<GeoDocument>,
  content = snapshot.content,
) {
  for (const value of Object.values(snapshot.scope))
    if (typeof value !== 'string' || value.length > 128) throw Error('GeoSaveScopeLimit');
  const long = '\u0000'.repeat(128);
  const revision = { kind: 'local-draft', sessionId: long, sequence: Number.MAX_SAFE_INTEGER };
  const scope = { artifactId: long, sessionId: long, generation: long };
  const capture = { scope, revision, contentHash: 'f'.repeat(64) };
  const outcomes = [
    {
      state: 'committed',
      operationId: long,
      capture,
      receipt: { adapterReceiptId: long, durability: 'adapter-acknowledged' },
    },
    { state: 'indeterminate', operationId: long, capture, reason: 'invalid-receipt' },
    {
      state: 'aborted-before-write',
      operationId: long,
      capture,
      proof: 'adapter-no-write-guarantee',
    },
  ];
  const bounded = (value: unknown) => {
    let nodes = 0;
    const visit = (v: unknown, depth: number) => {
      if (++nodes > 4096 || depth > 24) throw Error('GeoSaveCapacity');
      if (v && typeof v === 'object') for (const child of Object.values(v)) visit(child, depth + 1);
    };
    visit(value, 0);
    if (new TextEncoder().encode(JSON.stringify(value)).length > 65536)
      throw Error('GeoSaveCapacity');
  };
  bounded({ operationId: long, capture, content });
  for (const lastSave of outcomes)
    bounded({
      state: 'open',
      snapshot: { ...snapshot, scope, revision, content },
      canEdit: false,
      canSave: false,
      saving: false,
      lastOperation: { state: 'refused', code: long, message: long },
      lastSave,
    });
}
export function assertGeoSaveProfile(
  value: unknown,
  budgets: Budgets,
): asserts value is GeoDocument {
  assertGeo(value, budgets);
  assertSourceFree(value);
}
export async function checkedGeoReopen(value: unknown, expectedHash: string, budgets: Budgets) {
  assertGeoSaveProfile(value, budgets);
  if ((await contentHash(value)) !== expectedHash) throw Error('CaptureHashMismatch');
  return value;
}
export function geoPointSaveDefinition(
  packageHash: string,
  budgets: Budgets,
  factory: PointControllerFactory,
  observe?: Parameters<typeof geoPointEditorDefinition>[3],
) {
  const base = geoPointEditorDefinition(
    packageHash,
    budgets,
    factory,
    observe,
    assertGeoSaveCapacity,
  );
  return {
    ...base,
    manifest: {
      ...base.manifest,
      id: 'example.geo-point-save',
      permissions: ['artifact:read', 'artifact:edit', 'artifact:save'] as const,
      addons: {
        ...base.manifest.addons,
        save: { version: 'local-persistence@0-draft', requirement: 'optional' } as const,
      },
    },
    validate(value: unknown): value is GeoDocument {
      try {
        assertGeoSaveProfile(value, budgets);
        return true;
      } catch {
        return false;
      }
    },
    mount(container: HTMLElement, context: Parameters<NonNullable<typeof base.mount>>[1]) {
      assertGeoSaveCapacity(context.basic.read());
      base.mount!(container, context);
    },
  };
}
