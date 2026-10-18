import { describe, expect, it } from 'vitest';
import { createSavedGeoExportAuthority as reference } from '../../examples/reference-extension-host/geo-data-export';
import { createSavedGeoExportAuthority as independent } from '../../examples/independent-extension-host/geo-data-export';
import { sourceRecord } from './geo-source-fixture';

for (const [name, create] of [
  ['reference', reference],
  ['independent', independent],
] as const)
  describe(`${name} retained-version export authority`, () => {
    async function setup() {
      const record = await sourceRecord(1, null, 'lon,lat\n12,34'),
        scope = new AbortController(),
        request = new AbortController();
      let selected = 'v1',
        current = 'revision-1',
        allowed = true,
        pending = false,
        flushes = 0;
      const options = {
        artifactId: 'geo',
        signal: scope.signal,
        versionId: () => selected,
        flush() {
          flushes++;
          if (pending) throw Error('InvalidInput');
        },
        stamp() {
          if (!allowed) throw Error('NoGrant');
          return current + selected;
        },
        read: async (_id: string) => record,
      };
      const authority = create(options);
      return {
        record,
        scope,
        request,
        options,
        authority,
        select: (id: string) => {
          selected = id;
        },
        change: () => {
          current = 'revision-2';
        },
        revoke: () => {
          allowed = false;
        },
        pending: () => {
          pending = true;
        },
        flushes: () => flushes,
      };
    }
    it('captures an actually verified version and retained originals, separately from later caller mutations', async () => {
      const h = await setup(),
        capture = await h.authority.capture(h.request.signal);
      expect(capture.pin).toEqual({
        artifactId: 'geo',
        versionId: 'v1',
        contentHash: 'sha256:' + h.record.nativeVersion.contentHash,
      });
      expect(h.flushes()).toBe(1);
      expect(h.authority.authorize(capture)).toBe(true);
      h.record.closure[0].bytes = 'AA==';
      expect(h.authority.authorize(capture)).toBe(true); // independently owned exact original retained
      capture.content.layers[0].name = 'not the saved content';
      expect(h.authority.authorize(capture)).toBe(false);
    });
    it('refuses corrupted native/source bytes, missing closure and invalid hashes before issuing proof', async () => {
      for (const fault of ['native', 'original', 'closure', 'pin'] as const) {
        const h = await setup();
        if (fault === 'native') h.record.request.content.layers[0].name = 'tampered';
        if (fault === 'original') h.record.closure[0].bytes = 'AA==';
        if (fault === 'closure') h.record.closure.length = 0;
        if (fault === 'pin')
          h.record.request.content.sources[0].pin.contentHash = 'sha256:' + 'a'.repeat(64);
        await expect(h.authority.capture(h.request.signal)).rejects.toThrow();
      }
    });
    it('requires the selected immutable version and never substitutes the head or unsaved draft', async () => {
      const h = await setup();
      h.select('v2');
      await expect(h.authority.capture(h.request.signal)).rejects.toThrow(
        'GeoExportVersionChanged',
      );
      h.select('');
      await expect(h.authority.capture(h.request.signal)).rejects.toThrow('GeoNoSavedVersion');
    });
    it('invalid/composing input refuses capture without resetting the buffer', async () => {
      const h = await setup();
      h.pending();
      await expect(h.authority.capture(h.request.signal)).rejects.toThrow('InvalidInput');
      expect(h.flushes()).toBe(1);
      await expect(h.authority.capture(h.request.signal)).rejects.toThrow('InvalidInput');
    });
    it('revocation, version selection, revision changes, dispose and caller cancellation invalidate output', async () => {
      for (const fault of ['grant', 'selection', 'revision', 'dispose', 'scope'] as const) {
        const h = await setup(),
          capture = await h.authority.capture(h.request.signal);
        if (fault === 'grant') h.revoke();
        if (fault === 'selection') h.select('v2');
        if (fault === 'revision') h.change();
        if (fault === 'dispose') h.authority.dispose();
        if (fault === 'scope') h.scope.abort();
        expect(h.authority.authorize(capture)).toBe(false);
      }
      const h = await setup();
      h.request.abort();
      await expect(h.authority.capture(h.request.signal)).rejects.toThrow('GeoExportCancelled');
    });
    it('changed state or cancellation while reading a version cannot issue a late proof', async () => {
      for (const fault of ['input', 'cancel', 'scope'] as const) {
        const h = await setup();
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        h.options.read = async () => {
          await gate;
          return h.record;
        };
        const pending = h.authority.capture(h.request.signal);
        if (fault === 'input') h.change();
        if (fault === 'cancel') h.request.abort();
        if (fault === 'scope') h.scope.abort();
        release();
        await expect(pending).rejects.toThrow();
      }
    });
    it('a newer capture retires the previous proof and a late earlier load cannot replace it', async () => {
      const h = await setup();
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      h.options.read = async () => {
        await gate;
        return h.record;
      };
      const old = h.authority.capture(h.request.signal);
      h.options.read = async () => h.record;
      const fresh = await h.authority.capture(new AbortController().signal);
      release();
      await expect(old).rejects.toThrow('GeoExportCancelled');
      expect(h.authority.authorize(fresh)).toBe(true);
    });
  });
