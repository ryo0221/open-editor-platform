import { f31BoxBuilding, validateBim, type BimDocument } from '@editor-platform/bim-core';
import { EditorSession } from '@editor-platform/editor-core';
import { describe, expect, it } from 'vitest';
import { BimController, type BimAssetStore } from './controller';
import type { BimKernel } from './evaluate';

/** A material takes a downloaded texture (#662): images stored first, then one edit. */
describe('bim material textures (#662)', () => {
  const silent: BimKernel = { run: () => new Promise(() => {}) };
  const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const set = {
    name: 'Bricks',
    sizeMm: [1000, 500] as [number, number],
    rotationDeg: 0,
    normal: 'gl' as const,
    license: 'CC0',
  };
  const store = (log: string[]): BimAssetStore & { kept: Map<string, Uint8Array> } => {
    const kept = new Map<string, Uint8Array>();
    return {
      kept,
      get: (sha) => kept.get(sha),
      async stage(assets) {
        for (const a of assets) {
          log.push(`stage ${a.ref.id}`);
          kept.set(a.ref.sha256, a.bytes);
        }
      },
    };
  };

  it('stores the images, then names them on the material in one edit', async () => {
    const session = new EditorSession<BimDocument>(f31BoxBuilding());
    const log: string[] = [];
    const textures = store(log);
    const c = new BimController({
      session,
      kernel: silent,
      canEdit: () => true,
      textures,
      onApplied: () => log.push('applied'),
    });
    expect(c.canTexture).toBe(true);
    const material = c.state.content.materials[0]!;
    const files = [
      { role: 'color' as const, bytes, mediaType: 'image/png' },
      { role: 'roughness' as const, bytes, mediaType: 'image/png' },
    ];
    expect(await c.adoptTextures(material.id, files, set)).toBeUndefined();
    expect(log).toEqual(['stage asset-1', 'applied']);
    const doc = session.content;
    expect(doc.assets).toHaveLength(1);
    const ref = doc.assets![0]!;
    expect(ref).toMatchObject({ kind: 'texture-png', mediaType: 'image/png', byteLength: 7 });
    const a = doc.materials.find((m) => m.id === material.id)!.appearance!;
    // One image for both maps; the values multiply them, so they start at white and 1.
    expect(a.textures).toEqual({ ...set, maps: { color: ref.id, roughness: ref.id } });
    expect(a).toMatchObject({ color: '#ffffff', roughness: 1 });
    expect(a.preset).toBeUndefined();
    expect(validateBim(doc)).toEqual([]);
    expect(c.assetBytes(ref.sha256)).toBe(bytes);
    // Adding the same image again reuses its ref.
    expect(await c.adoptTextures(material.id, files.slice(0, 1), set)).toBeUndefined();
    expect(session.content.assets).toEqual([ref]);
  });

  it('gives a new image an ID free in the whole document, also when two adds overlap (Codex)', async () => {
    const doc = f31BoxBuilding();
    // A material already named like the first texture would be.
    doc.materials.push({ ...doc.materials[0]!, id: 'asset-1', name: 'Taken' });
    const session = new EditorSession<BimDocument>(doc);
    const log: string[] = [];
    const c = new BimController({
      session,
      kernel: silent,
      canEdit: () => true,
      textures: store(log),
    });
    const [m1, m2] = [doc.materials[0]!.id, doc.materials[1]!.id];
    const other = new Uint8Array([137, 80, 78, 71, 9, 9]);
    // Both start from the same content, then commit one after the other.
    const [one, two] = await Promise.all([
      c.adoptTextures(m1, [{ role: 'color', bytes, mediaType: 'image/png' }], set),
      c.adoptTextures(m2, [{ role: 'color', bytes: other, mediaType: 'image/png' }], set),
    ]);
    expect([one, two]).toEqual([undefined, undefined]);
    const after = session.content;
    expect(validateBim(after)).toEqual([]);
    expect(after.assets!.map((a) => a.id)).toEqual(['asset-2', 'asset-3']);
    const mapOf = (id: string) =>
      after.materials.find((m) => m.id === id)!.appearance!.textures!.maps.color!;
    const shaOf = (id: string) => after.assets!.find((a) => a.id === id)!.sha256;
    // Each material names its own image.
    expect(shaOf(mapOf(m1))).not.toBe(shaOf(mapOf(m2)));
    expect(c.assetBytes(shaOf(mapOf(m2)))).toBe(other);
  });

  it('refuses without a store, authority, files or a known image type, and keeps the content', async () => {
    const session = new EditorSession<BimDocument>(f31BoxBuilding());
    const before = session.content;
    const files = [{ role: 'color' as const, bytes, mediaType: 'image/png' }];
    const bare = new BimController({ session, kernel: silent, canEdit: () => true });
    expect(bare.canTexture).toBe(false);
    const id = before.materials[0]!.id;
    expect(await bare.adoptTextures(id, files, set)).toBe('texture-unavailable');
    const log: string[] = [];
    let editable = false;
    const c = new BimController({
      session,
      kernel: silent,
      canEdit: () => editable,
      textures: store(log),
    });
    expect(await c.adoptTextures(id, files, set)).toBe('permission-denied');
    editable = true;
    expect(await c.adoptTextures(id, [], set)).toBe('texture-empty');
    expect(
      await c.adoptTextures(id, [{ role: 'color', bytes, mediaType: 'image/webp' }], set),
    ).toBe('texture-media-type');
    expect(await c.adoptTextures('missing', files, set)).toBe('target-missing');
    const failing = new BimController({
      session,
      kernel: silent,
      canEdit: () => true,
      textures: {
        get: () => undefined,
        stage: () => Promise.reject(new Error('full')),
      },
    });
    expect(await failing.adoptTextures(id, files, set)).toBe('texture-stage-failed');
    expect(failing.state.notice?.message).toBe('full');
    expect(log).toEqual([]);
    expect(session.content).toEqual(before);
  });
});
