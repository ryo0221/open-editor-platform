import { describe, expect, it } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import {
  f02Plate,
  fixtureKernel,
  type CadAssetRef,
  type CadEvaluation,
  type CadKernelPort,
} from '@editor-platform/cad-core';
import { ViewTextureCache, viewTexturesOf } from '@editor-platform/geometry-view';
import { CadController, type CadAssetStore } from './controller';

const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill);

/** A Host store that keeps what it is given. */
function setup() {
  const kept = new Map<string, Uint8Array>();
  const staged: CadAssetRef[][] = [];
  const assets: CadAssetStore = {
    get: (sha) => kept.get(sha),
    stage: async (list) => {
      staged.push(list.map((a) => a.ref));
      for (const a of list) kept.set(a.ref.sha256, a.bytes);
    },
  };
  const kernel: CadKernelPort = {
    evaluate: async (request): Promise<CadEvaluation> => ({
      status: 'ok',
      contentHash: request.candidateHash,
      buildHash: fixtureKernel.buildHash,
      geometryDigest: 'd',
      bodies: Object.fromEntries(
        request.document.bodies.map((b) => [
          b.id,
          {
            kind: 'solid' as const,
            volumeMm3: 1,
            areaMm2: 1,
            bounds: [
              [0, 0, 0],
              [1, 1, 1],
            ] as [[number, number, number], [number, number, number]],
          },
        ]),
      ),
    }),
    cancel: () => {},
  };
  let ids = 0;
  const session = new EditorSession(f02Plate());
  const controller = new CadController({
    session,
    kernel,
    canEdit: () => true,
    permissionGeneration: () => 1,
    newId: (prefix) => `${prefix}-${++ids}`,
    assets,
  });
  return { controller, session, staged, kept };
}

describe('putting a texture set on a body (#662)', () => {
  it('keeps an Undo made while the images are stored (Codex)', async () => {
    const { controller, session, kept } = setup();
    await controller.refresh();
    const body = session.content.bodies[0]!;
    await controller.run({
      type: 'setAppearance',
      bodyId: body.id,
      appearance: { ...body.appearance, opacity: 0.5 },
    });
    expect(session.content.bodies[0]!.appearance.opacity).toBe(0.5);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // A slow Host store: the user presses Undo while it saves.
    const slow = controller as unknown as { options: { assets: CadAssetStore } };
    const store = slow.options.assets;
    slow.options.assets = {
      get: store.get,
      stage: async (list) => {
        await gate;
        await store.stage(list);
      },
    };
    const adopting = controller.adoptTextures(
      body.id,
      [{ role: 'color', bytes: bytes(30, 3), mediaType: 'image/jpeg' }],
      { name: 'Bricks', sizeMm: [500, 500], rotationDeg: 0, normal: 'gl' },
    );
    await controller.undo();
    expect(session.content.bodies[0]!.appearance.opacity).toBe(1);
    release();
    expect(await adopting).toBe(true);
    const look = session.content.bodies[0]!.appearance;
    // The texture is added to the look as it is after the Undo, not the one read before.
    expect(look.opacity).toBe(1);
    expect(look.textures?.name).toBe('Bricks');
    expect(kept.size).toBe(1);
  });

  it('stores the images first, then names them in one appearance edit', async () => {
    const { controller, session, staged } = setup();
    await controller.refresh();
    const bodyId = session.content.bodies[0]!.id;
    const color = bytes(30, 3);
    const rough = bytes(31, 4);
    const ok = await controller.adoptTextures(
      bodyId,
      [
        { role: 'color', bytes: color, mediaType: 'image/jpeg' },
        { role: 'roughness', bytes: rough, mediaType: 'image/png' },
      ],
      { name: 'Bricks', sizeMm: [2000, 1000], rotationDeg: 0, normal: 'gl', license: 'CC0' },
    );
    expect(ok).toBe(true);
    expect(staged).toHaveLength(1);
    const content = session.content;
    expect(content.assets.map((a) => [a.kind, a.byteLength])).toEqual([
      ['texture-jpeg', 30],
      ['texture-png', 31],
    ]);
    expect(staged[0]).toEqual(content.assets);
    const look = content.bodies[0]!.appearance;
    // The maps carry the look: white colour, roughness 1 (glTF factors).
    expect(look).toMatchObject({ color: '#ffffff', roughness: 1 });
    expect(look.textures).toEqual({
      maps: { color: content.assets[0]!.id, roughness: content.assets[1]!.id },
      sizeMm: [2000, 1000],
      rotationDeg: 0,
      normal: 'gl',
      name: 'Bricks',
      license: 'CC0',
    });
    expect(content.assets[0]!.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The same image again is the same asset: nothing new is named.
    expect(
      await controller.adoptTextures(
        bodyId,
        [{ role: 'color', bytes: color, mediaType: 'image/jpeg' }],
        { name: 'Bricks', sizeMm: [500, 500], rotationDeg: 0, normal: 'gl' },
      ),
    ).toBe(true);
    expect(session.content.assets).toEqual([content.assets[0]]);
    // An image of another type is refused before anything is stored.
    expect(
      await controller.adoptTextures(
        bodyId,
        [{ role: 'color', bytes: color, mediaType: 'image/webp' }],
        { name: 'x', sizeMm: [500, 500], rotationDeg: 0, normal: 'gl' },
      ),
    ).toBe(false);
    expect(controller.getSnapshot().diagnostic?.code).toBe('texture-media-type');
  });

  it('gives the view each map once its image is decoded', async () => {
    const { controller, session } = setup();
    await controller.refresh();
    const bodyId = session.content.bodies[0]!.id;
    // A JPEG header with its frame (2 × 2): the view checks the size before decoding.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 2, 0, 2, 3, 0, 0, 0]);
    await controller.adoptTextures(
      bodyId,
      [{ role: 'color', bytes: jpeg, mediaType: 'image/jpeg' }],
      { name: 'Bricks', sizeMm: [2000, 1000], rotationDeg: 90, normal: 'dx' },
    );
    let loads = 0;
    const cache = new ViewTextureCache(
      () => loads++,
      async () => ({ width: 2, height: 2 }),
    );
    const read = (sha: string) => controller.assetBytes(sha);
    const { appearance } = session.content.bodies[0]!;
    const first = viewTexturesOf(appearance.textures, session.content.assets, cache, read);
    expect(first).toMatchObject({ maps: {}, sizeMm: [2000, 1000], normal: 'dx' });
    expect(first!.rotationRad).toBeCloseTo(Math.PI / 2);
    await cache.settled();
    expect(loads).toBe(1);
    const ready = viewTexturesOf(appearance.textures, session.content.assets, cache, read);
    expect(ready!.maps.color?.image).toEqual({ width: 2, height: 2 });
    expect(viewTexturesOf(undefined, [], cache, read)).toBeUndefined();
  });
});
