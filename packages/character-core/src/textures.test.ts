import { describe, expect, it } from 'vitest';
import {
  applyCharacterOperation,
  characterCubePart,
  characterImageKind,
  characterMaterialImage,
  emptyCharacter,
  CharacterValidationError,
} from './index';

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 4, 5]);

describe('image textures on materials (C4c, TS-1239)', () => {
  const cube = characterCubePart(emptyCharacter());
  const doc = applyCharacterOperation(emptyCharacter(), cube.op);
  const material = doc.materials[0]!.id;

  it('reads PNG and JPEG by signature and refuses anything else', () => {
    expect(characterImageKind(png)).toBe('texture-png');
    expect(characterImageKind(jpeg)).toBe('texture-jpeg');
    expect(characterImageKind(new TextEncoder().encode('GIF89a'))).toBeUndefined();
    expect(() => characterMaterialImage(doc, material, 'color', new Uint8Array(4))).toThrow(
      'character-image-format',
    );
    const huge = new Uint8Array(16 * 1024 * 1024 + 1);
    huge.set(png);
    expect(() => characterMaterialImage(doc, material, 'color', huge)).toThrow(
      'character-image-size',
    );
  });

  it('sets a colour image, replaces it, and clears it, dropping refs nothing names', () => {
    const first = characterMaterialImage(doc, material, 'color', png);
    expect(first.ref.kind).toBe('texture-png');
    expect(first.ref.mediaType).toBe('image/png');
    expect(first.ref.byteLength).toBe(png.length);
    const a = applyCharacterOperation(doc, first.op);
    expect(a.materials[0]!.maps.color).toBe(first.ref.id);
    expect(a.assets.map((x) => x.id)).toContain(first.ref.id);
    // Replacing it drops the first image's ref; the mesh stays.
    const second = characterMaterialImage(a, material, 'color', jpeg);
    const b = applyCharacterOperation(a, second.op);
    expect(b.materials[0]!.maps.color).toBe(second.ref.id);
    expect(b.assets.map((x) => x.kind).sort()).toEqual(['mesh-epm', 'texture-jpeg']);
    // The same bytes again reuse the ref already there.
    const again = characterMaterialImage(b, material, 'color', jpeg);
    expect(applyCharacterOperation(b, again.op).assets).toHaveLength(2);
    // Cleared: no map, no image ref.
    const c = applyCharacterOperation(b, {
      type: 'setMaterialMap',
      id: material,
      role: 'color',
      asset: null,
    });
    expect(c.materials[0]!.maps).toEqual({});
    expect(c.assets.map((x) => x.kind)).toEqual(['mesh-epm']);
  });

  it('refuses a missing material and an asset that is not an image', () => {
    const { ref } = characterMaterialImage(doc, material, 'color', png);
    expect(() =>
      applyCharacterOperation(doc, {
        type: 'setMaterialMap',
        id: 'nope',
        role: 'color',
        asset: ref,
      }),
    ).toThrow(CharacterValidationError);
    expect(() =>
      applyCharacterOperation(doc, {
        type: 'setMaterialMap',
        id: material,
        role: 'color',
        asset: {
          ...ref,
          id: 'mesh-as-image',
          kind: 'mesh-epm',
          mediaType: 'model/x-editor-platform-mesh',
        },
      }),
    ).toThrow(CharacterValidationError);
  });
});
