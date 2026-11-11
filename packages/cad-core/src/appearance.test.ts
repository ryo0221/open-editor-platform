import { geometryMaterialPreset } from '@editor-platform/geometry-core';
import { describe, expect, it } from 'vitest';
import {
  applyCadOperation,
  assertCadOperation,
  f02Plate,
  validateCad,
  validateCadAppearance,
  type CadDocument,
} from './index';

const codes = (doc: unknown) => validateCad(doc).map((d) => d.code);
const bodyId = (doc: CadDocument) => doc.bodies[0]!.id;

describe('body appearance and materials (#661)', () => {
  it('accepts a finish and a preset id beside colour and opacity', () => {
    const doc = f02Plate();
    const steel = geometryMaterialPreset('steel')!;
    doc.bodies[0]!.appearance = {
      color: steel.color,
      opacity: 1,
      roughness: steel.roughness,
      metalness: steel.metalness,
      material: 'steel',
    };
    expect(codes(doc)).toEqual([]);
  });

  it('refuses a finish out of 0–1, an unknown preset and unknown fields', () => {
    expect(validateCadAppearance({ color: '#ffffff', opacity: 1, roughness: 1.5 })[0]?.code).toBe(
      'appearance-roughness',
    );
    expect(validateCadAppearance({ color: '#ffffff', opacity: 1, metalness: -0.1 })[0]?.code).toBe(
      'appearance-metalness',
    );
    expect(
      validateCadAppearance({ color: '#ffffff', opacity: 1, material: 'unobtainium' })[0]?.code,
    ).toBe('appearance-material');
    expect(validateCadAppearance({ color: '#ffffff', opacity: 1, texture: 'x' })[0]?.code).toBe(
      'unknown-field',
    );
    expect(validateCadAppearance({ color: 'red', opacity: 1 })[0]?.code).toBe('appearance-color');
    // Colour and opacity alone, as before materials.
    expect(validateCadAppearance({ color: '#9aa4b1', opacity: 1 })).toEqual([]);
  });

  it('accepts a lamp’s light and a lens’s transmission, and refuses them out of range (CR6a, TS-1591)', () => {
    const doc = f02Plate();
    const lens = geometryMaterialPreset('lamp-lens')!;
    const red = geometryMaterialPreset('lamp-red')!;
    doc.bodies[0]!.appearance = {
      color: lens.color,
      opacity: 1,
      transmission: lens.transmission!,
      ior: lens.ior!,
      material: 'lamp-lens',
    };
    expect(codes(doc)).toEqual([]);
    doc.bodies[0]!.appearance = { color: red.color, opacity: 1, emission: { ...red.emission! } };
    expect(codes(doc)).toEqual([]);
    const code = (patch: object) =>
      validateCadAppearance({ color: '#ffffff', opacity: 1, ...patch }).map((d) => [
        d.code,
        d.path,
      ]);
    expect(code({ emission: { color: '#ff0000', strength: 51 } })).toEqual([
      ['appearance-emission', '$.emission'],
    ]);
    expect(code({ emission: { color: 'red', strength: 1 } })[0]?.[0]).toBe('appearance-emission');
    expect(code({ emission: { color: '#ff0000', strength: 1, x: 1 } })[0]?.[0]).toBe(
      'appearance-emission',
    );
    expect(code({ emission: null })[0]?.[0]).toBe('appearance-emission');
    expect(code({ transmission: 1.2 })).toEqual([['appearance-transmission', '$.transmission']]);
    expect(code({ ior: 0.9 })).toEqual([['appearance-ior', '$.ior']]);
    expect(code({ ior: 2.6 })[0]?.[0]).toBe('appearance-ior');
    expect(code({ transmission: 0, ior: 1, emission: { color: '#000000', strength: 0 } })).toEqual(
      [],
    );
  });

  it('setAppearance changes one body’s look and nothing else', () => {
    const doc = f02Plate();
    const id = bodyId(doc);
    const appearance = {
      color: '#c9a24b',
      opacity: 1,
      roughness: 0.3,
      metalness: 1,
      material: 'brass',
    };
    const next = applyCadOperation(doc, { type: 'setAppearance', bodyId: id, appearance });
    expect(next.bodies[0]!.appearance).toEqual(appearance);
    expect({ ...next, bodies: [] }).toEqual({ ...doc, bodies: [] });
    expect(doc.bodies[0]!.appearance).not.toEqual(appearance);
    expect(codes(next)).toEqual([]);
  });

  it('refuses an unchanged look, an invalid look and a missing body', () => {
    const doc = f02Plate();
    const id = bodyId(doc);
    expect(() =>
      applyCadOperation(doc, {
        type: 'setAppearance',
        bodyId: id,
        appearance: { ...doc.bodies[0]!.appearance },
      }),
    ).toThrow('appearance-unchanged');
    expect(() =>
      applyCadOperation(doc, {
        type: 'setAppearance',
        bodyId: id,
        appearance: { color: '#ffffff', opacity: 2 },
      }),
    ).toThrow('appearance-invalid:appearance-opacity');
    expect(() =>
      applyCadOperation(doc, {
        type: 'setAppearance',
        bodyId: 'nope',
        appearance: { color: '#ffffff', opacity: 1 },
      }),
    ).toThrow('target-missing');
  });

  it('gates the operation data', () => {
    expect(() =>
      assertCadOperation({
        type: 'setAppearance',
        bodyId: 'plate',
        appearance: { color: '#ffffff', opacity: 1 },
      }),
    ).not.toThrow();
    expect(() =>
      assertCadOperation({ type: 'setAppearance', bodyId: 'plate', appearance: '#ffffff' }),
    ).toThrow('operation-schema');
    expect(() =>
      assertCadOperation({
        type: 'setAppearance',
        bodyId: 'plate',
        appearance: { color: '#ffffff', opacity: 1 },
        extra: 1,
      }),
    ).toThrow('operation-schema');
  });
});

describe('body textures (#662)', () => {
  const sha = (c: string) => `sha256:${c.repeat(64)}`;
  const png = {
    id: 'tex-color',
    kind: 'texture-png',
    sha256: sha('a'),
    byteLength: 1000,
    mediaType: 'image/png',
  } as const;
  const jpg = {
    id: 'tex-normal',
    kind: 'texture-jpeg',
    sha256: sha('b'),
    byteLength: 2000,
    mediaType: 'image/jpeg',
  } as const;
  const textured = {
    color: '#ffffff',
    opacity: 1,
    roughness: 1,
    metalness: 0,
    textures: {
      maps: { color: png.id, normal: jpg.id },
      sizeMm: [2000, 1000] as [number, number],
      rotationDeg: 0,
      normal: 'gl' as const,
      name: 'Bricks076C',
      source: 'https://ambientcg.com/view?id=Bricks076C',
      license: 'CC0',
    },
  };

  it('adds the images with the look, and drops them when no body names them', () => {
    const doc = f02Plate();
    const id = bodyId(doc);
    const op = {
      type: 'setAppearance' as const,
      bodyId: id,
      appearance: textured,
      assets: [png, jpg],
    };
    expect(() => assertCadOperation(op)).not.toThrow();
    const next = applyCadOperation(doc, op);
    expect(next.assets).toEqual([png, jpg]);
    expect(next.bodies[0]!.appearance).toEqual(textured);
    expect(codes(next)).toEqual([]);
    // A change of size keeps the images (already held, not named again).
    const bigger = applyCadOperation(next, {
      type: 'setAppearance',
      bodyId: id,
      appearance: { ...textured, textures: { ...textured.textures, sizeMm: [4000, 2000] } },
    });
    expect(bigger.assets).toEqual([png, jpg]);
    // Dropping the normal map drops its image; dropping the set drops both.
    const colourOnly = applyCadOperation(bigger, {
      type: 'setAppearance',
      bodyId: id,
      appearance: { ...textured, textures: { ...textured.textures, maps: { color: png.id } } },
    });
    expect(colourOnly.assets).toEqual([png]);
    const plain = applyCadOperation(colourOnly, {
      type: 'setAppearance',
      bodyId: id,
      appearance: { color: '#ffffff', opacity: 1 },
    });
    expect(plain.assets).toEqual([]);
    expect(codes(plain)).toEqual([]);
  });

  it('refuses maps without their image, a bad size, rotation, convention or source', () => {
    const doc = f02Plate();
    doc.bodies[0]!.appearance = textured;
    expect(codes(doc)).toContain('asset-missing');
    doc.assets = [png, jpg];
    expect(codes(doc)).toEqual([]);
    const bad = (patch: object) =>
      validateCadAppearance({ ...textured, textures: { ...textured.textures, ...patch } })[0]?.code;
    expect(bad({ maps: {} })).toBe('appearance-texture-maps');
    expect(bad({ maps: { height: png.id } })).toBe('appearance-texture-maps');
    expect(bad({ sizeMm: [0, 1000] })).toBe('appearance-texture-size');
    expect(bad({ rotationDeg: 400 })).toBe('appearance-texture-rotation');
    expect(bad({ normal: 'up' })).toBe('appearance-texture-normal');
    expect(bad({ source: 'javascript:alert(1)' })).toBe('appearance-texture-source');
    // A texture image the look does not name is not kept.
    const extra = f02Plate();
    extra.assets = [png];
    expect(codes(extra)).toContain('asset-unreferenced');
    // Only texture images come with an appearance.
    expect(() =>
      applyCadOperation(f02Plate(), {
        type: 'setAppearance',
        bodyId: bodyId(f02Plate()),
        appearance: textured,
        assets: [{ ...png, kind: 'normalized-brep', mediaType: 'model/x-occt-brep' }, jpg],
      }),
    ).toThrow(/asset-kind/);
  });
});
