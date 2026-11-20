import { describe, expect, it } from 'vitest';
import { assertCadOperation } from './commands';
import { compareCad } from './diff';
import { f02Plate } from './fixtures';
import type { CadAssetRef, CadDocument } from './model';
import { applyCadOperation, type CadOperation } from './operations';
import {
  cadUnderlayAxes,
  cadUnderlayBox,
  cadUnderlayUv,
  cadUnderlayViews,
  type CadUnderlay,
} from './underlays';
import { validateCad } from './validation';

const codes = (doc: unknown) => validateCad(doc).map((d) => d.code);
const run = (doc: CadDocument, op: CadOperation) => {
  assertCadOperation(op);
  return applyCadOperation(doc, op);
};
const asset: CadAssetRef = {
  id: 'asset-front',
  kind: 'texture-png',
  sha256: `sha256:${'a'.repeat(64)}`,
  byteLength: 1024,
  mediaType: 'image/png',
};
const underlay = (over: Partial<CadUnderlay> = {}): CadUnderlay => ({
  id: 'underlay-front',
  name: 'Front drawing',
  view: 'front',
  assetId: asset.id,
  pixels: [400, 200],
  mmPerPixel: 0.5,
  originMm: [-50, 80],
  opacity: 0.6,
  ...over,
});

describe('#15 underlays: drawings laid under views', () => {
  it('saves an underlay with its image asset, validates it and restores it', () => {
    const doc = run(f02Plate(), { type: 'setUnderlays', underlays: [underlay()], assets: [asset] });
    expect(doc.underlays).toEqual([underlay()]);
    expect(doc.assets).toContainEqual(asset);
    expect(codes(doc)).toEqual([]);
    // A JSON round trip (save and reopen) keeps it.
    const back = JSON.parse(JSON.stringify(doc)) as CadDocument;
    expect(codes(back)).toEqual([]);
    expect(back.underlays).toEqual(doc.underlays);
    expect(compareCad(f02Plate(), doc).map((c) => c.elementId)).toContain('underlays');
    // Removing the underlays drops the image asset too (nothing else reads it).
    const cleared = run(doc, { type: 'setUnderlays', underlays: [] });
    expect(cleared.underlays).toBeUndefined();
    expect(cleared.assets.some((a) => a.id === asset.id)).toBe(false);
    expect(() => run(cleared, { type: 'setUnderlays', underlays: [] })).toThrow(
      'underlays-unchanged',
    );
  });

  it('refuses a bad shape, an unknown view, a missing or non-image asset', () => {
    const base = run(f02Plate(), {
      type: 'setUnderlays',
      underlays: [underlay()],
      assets: [asset],
    });
    const withUnderlay = (u: Record<string, unknown>) =>
      ({ ...base, underlays: [{ ...underlay(), ...u }] }) as unknown as CadDocument;
    expect(codes(withUnderlay({ view: 'iso' }))).toContain('underlay-view');
    expect(codes(withUnderlay({ assetId: 'asset-nope' }))).toContain('asset-missing');
    expect(codes(withUnderlay({ pixels: [0, 10] }))).toContain('underlay-pixels');
    expect(codes(withUnderlay({ pixels: [20_000, 10] }))).toContain('underlay-pixels');
    expect(codes(withUnderlay({ mmPerPixel: 0 }))).toContain('underlay-scale');
    expect(codes(withUnderlay({ originMm: [0, 1e12] }))).toContain('underlay-origin');
    expect(codes(withUnderlay({ opacity: 0 }))).toContain('underlay-opacity');
    expect(codes(withUnderlay({ hidden: false }))).toContain('underlay-hidden');
    expect(codes(withUnderlay({ extra: 1 }))).not.toEqual([]);
    const two = { ...base, underlays: [underlay(), underlay()] } as CadDocument;
    expect(codes(two)).toContain('duplicate-id');
    expect(() =>
      run(f02Plate(), {
        type: 'setUnderlays',
        underlays: [underlay()],
        assets: [{ ...asset, kind: 'source-step', mediaType: 'model/step' }],
      }),
    ).toThrow();
  });

  it('places each view on the page as a drawing does, Z up', () => {
    for (const view of cadUnderlayViews) {
      const { u, v, toward } = cadUnderlayAxes(view);
      // Right-handed: right × up = toward the viewer.
      const cross = [
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
      ];
      expect(cross.map((x) => x + 0)).toEqual(toward.map((x) => x + 0));
    }
    expect(cadUnderlayUv('front', [10, 99, 20])).toEqual([10, 20]);
    expect(cadUnderlayUv('right', [99, 10, 20])).toEqual([10, 20]);
    expect(cadUnderlayUv('top', [10, 20, 99])).toEqual([10, 20]);
    expect(cadUnderlayBox(underlay())).toEqual([-50, -20, 150, 80]);
  });
});
