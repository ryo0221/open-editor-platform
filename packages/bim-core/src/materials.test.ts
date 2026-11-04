import { describe, expect, it } from 'vitest';
import { applyBimOperation, bimSurfaceMaterialId, f31BoxBuilding, validateBim } from './index';

const codes = (doc: unknown) => validateBim(doc).map((d) => d.code);
const brick = { color: '#a4553d', opacity: 1, roughness: 0.85, metalness: 0, preset: 'brick' };

describe('material appearance (#661)', () => {
  it('accepts a material with or without an appearance', () => {
    const doc = f31BoxBuilding();
    expect(codes(doc)).toEqual([]);
    doc.materials[0]!.appearance = brick;
    expect(codes(doc)).toEqual([]);
  });

  it('refuses values out of 0–1, a bad colour, an unknown preset and unknown fields', () => {
    for (const appearance of [
      { ...brick, roughness: 2 },
      { ...brick, opacity: -1 },
      { ...brick, color: 'brick' },
      { ...brick, preset: 'adamantium' },
      { ...brick, texture: 'x' },
      { color: '#ffffff', opacity: 1 },
    ]) {
      const doc = structuredClone(f31BoxBuilding()) as unknown as {
        materials: { appearance?: unknown }[];
      };
      doc.materials[0]!.appearance = appearance;
      expect(codes(doc)).toContain('material-appearance');
    }
  });

  it('an update gives a material its look; another takes it away', () => {
    const doc = f31BoxBuilding();
    const m = doc.materials[0]!;
    const looked = applyBimOperation(doc, {
      type: 'update',
      collection: 'materials',
      entity: { ...m, appearance: brick },
    });
    expect(looked.materials[0]!.appearance).toEqual(brick);
    const plain = applyBimOperation(looked, { type: 'update', collection: 'materials', entity: m });
    expect(plain.materials[0]).toEqual(m);
  });

  it('names the material a type shows on its surfaces', () => {
    const doc = f31BoxBuilding();
    for (const t of doc.types) {
      const id = bimSurfaceMaterialId(t);
      if ('layers' in t) expect(id).toBe(t.layers[0]!.materialId);
      else if ('materialId' in t) expect(id).toBe(t.materialId);
      else expect(id).toBeUndefined();
    }
  });
});

describe('material textures (#662)', () => {
  const png = {
    id: 'tex-color',
    kind: 'texture-png',
    sha256: `sha256:${'a'.repeat(64)}`,
    byteLength: 1000,
    mediaType: 'image/png',
  } as const;
  const textured = {
    ...brick,
    color: '#ffffff',
    textures: {
      maps: { color: png.id },
      sizeMm: [1000, 1000] as [number, number],
      rotationDeg: 0,
      normal: 'gl' as const,
      name: 'Bricks',
      license: 'CC0',
    },
  };

  it('adds the images with a material’s look and drops them with it', () => {
    const doc = f31BoxBuilding();
    const m = doc.materials[0]!;
    const looked = applyBimOperation(doc, {
      type: 'update',
      collection: 'materials',
      entity: { ...m, appearance: textured },
      assets: [png],
    });
    expect(looked.assets).toEqual([png]);
    expect(codes(looked)).toEqual([]);
    const plain = applyBimOperation(looked, {
      type: 'update',
      collection: 'materials',
      entity: { ...m, appearance: brick },
    });
    expect(plain.assets).toBeUndefined();
    expect(codes(plain)).toEqual([]);
  });

  it('refuses a missing or unnamed image and a bad texture set', () => {
    const doc = f31BoxBuilding();
    doc.materials[0]!.appearance = textured;
    expect(codes(doc)).toContain('asset-missing');
    doc.assets = [png];
    expect(codes(doc)).toEqual([]);
    doc.assets.push({ ...png, id: 'tex-2', sha256: `sha256:${'b'.repeat(64)}` });
    expect(codes(doc)).toContain('asset-unreferenced');
    doc.assets.pop();
    doc.materials[0]!.appearance = {
      ...textured,
      textures: { ...textured.textures, sizeMm: [0, 1000] },
    };
    expect(codes(doc)).toContain('material-texture');
    const wrong = structuredClone(f31BoxBuilding()) as unknown as Record<string, unknown>;
    wrong.assets = [{ ...png, mediaType: 'image/jpeg' }];
    expect(codes(wrong)).toContain('asset-kind');
  });
});
