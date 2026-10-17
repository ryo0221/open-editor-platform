import { expect, it } from 'vitest';
import { contentHash } from '@editor-platform/artifact-core';
import { assertGeo } from '@editor-platform/geo-core';
import { assertGeoSaveCapacity, checkedGeoReopen } from './point-save-entry';
import { editFixture } from '../test-host/edit-fixture';
const limits = { actions: 10, bytes: 65536, depth: 24, layers: 10, features: 100, vertices: 1000 };
const read = (content = editFixture()) => ({
  scope: { artifactId: 'geo', sessionId: 's', generation: 'g' },
  revision: { kind: 'local-draft' as const, sessionId: 's', sequence: 0 },
  content,
});
it('reserves full committed/old/indeterminate capture and receipt view plus WriteRequest', () => {
  const content = editFixture();
  assertGeoSaveCapacity(read(content));
  // Native bytes alone fit; full controlled/save envelopes intentionally do not.
  content.layers[0].name = 'x'.repeat(62000);
  expect(() => assertGeo(content, limits)).not.toThrow();
  expect(() => assertGeoSaveCapacity(read(content))).toThrow('GeoSaveCapacity');
});
it('capacity admission has a strict byte boundary without truncating native', () => {
  const content = editFixture();
  let lo = 0,
    hi = 65000;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    content.layers[0].name = 'x'.repeat(mid);
    try {
      assertGeoSaveCapacity(read(content));
      lo = mid;
    } catch {
      hi = mid;
    }
  }
  content.layers[0].name = 'x'.repeat(lo);
  expect(() => assertGeoSaveCapacity(read(content))).not.toThrow();
  content.layers[0].name += 'x';
  expect(() => assertGeoSaveCapacity(read(content))).toThrow('GeoSaveCapacity');
  expect(content.layers[0].name.length).toBe(lo + 1);
});
it('mixed source-free native roundtrip keeps null and LineString with actual hash', async () => {
  const content = editFixture();
  const reopened = await checkedGeoReopen(
    JSON.parse(JSON.stringify(content)),
    await contentHash(content),
    limits,
  );
  expect(reopened).toEqual(content);
  expect(reopened.layers[0].features.some((f) => f.geometry === null)).toBe(true);
  expect(reopened.layers[0].features.some((f) => f.geometry?.type === 'LineString')).toBe(true);
  await expect(checkedGeoReopen(content, 'f'.repeat(64), limits)).rejects.toThrow(
    'CaptureHashMismatch',
  );
});
it('shared request overflow releases the Geo retained capture and storage-key claim', async () => {
  const { saveHarness } = await import('../test-host/native-save-harness');
  const { command } = await import('@editor-platform/editor-core');
  const h = saveHarness(),
    original = h.binding.session.content;
  const initial = h.handle.context.basic.read(),
    empty = structuredClone(original);
  empty.layers[0].name = '';
  const bytes = new TextEncoder().encode(JSON.stringify({ ...initial, content: empty })).length;
  empty.layers[0].name = 'x'.repeat(65536 - bytes);
  h.binding.session.execute(command('large', 'large', () => empty));
  expect(new TextEncoder().encode(JSON.stringify(h.handle.context.basic.read())).length).toBe(
    65536,
  );
  await expect(h.save.save()).rejects.toThrow('DataLimit');
  expect(h.storage.holds).toBe(0);
  expect(h.storage.requests).toHaveLength(0);
  h.binding.session.execute(command('restore', 'restore', () => original));
  const saving = h.save.save(),
    request = await h.storage.nextRequest();
  h.storage.noWrite(request.operationId);
  await expect(saving).resolves.toMatchObject({ state: 'aborted-before-write' });
  h.handle.revoke('host-close');
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
  expect(await h.handle.drain({ deadlineMs: 0 })).toMatchObject({
    state: 'drained',
    failed: [],
    pending: [],
  });
});
