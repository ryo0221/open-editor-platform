import { describe, expect, it } from 'vitest';
import {
  geometryCategoryPreset,
  geometryDefaultFinish,
  geometryLightProblems,
  geometryMaterialPreset,
  geometryMaterialPresets,
} from './index';

describe('material library (#661)', () => {
  it('has unique ids and looks in range', () => {
    const ids = geometryMaterialPresets.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of geometryMaterialPresets) {
      expect(p.id).toMatch(/^[a-z0-9-]+$/);
      expect(p.color).toMatch(/^#[0-9a-f]{6}$/);
      for (const v of [p.opacity, p.roughness, p.metalness]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
    expect(Object.isFrozen(geometryMaterialPresets[0])).toBe(true);
  });

  it('finds presets by id and by category', () => {
    expect(geometryMaterialPreset('steel')?.metalness).toBe(1);
    expect(geometryMaterialPreset('nope')).toBeUndefined();
    expect(geometryCategoryPreset('glass')?.opacity).toBeLessThan(1);
    expect(geometryCategoryPreset('concrete')?.id).toBe('concrete');
  });

  it('has the car parts’ looks, with their light in range (CR6a, TS-1591)', () => {
    for (const p of geometryMaterialPresets) expect(geometryLightProblems({ ...p })).toEqual([]);
    expect(geometryMaterialPreset('lamp-lens')).toMatchObject({ transmission: 1, ior: 1.49 });
    expect(geometryMaterialPreset('lamp-red')?.emission).toEqual({ color: '#ff2a1f', strength: 6 });
    expect(geometryMaterialPreset('chrome')).toMatchObject({ metalness: 1, roughness: 0.04 });
    for (const id of ['lamp-white', 'fabric', 'leather'])
      expect(geometryMaterialPreset(id)).toBeDefined();
    // The older presets give off no light and let none through.
    expect(Object.keys(geometryMaterialPreset('steel')!).sort()).toEqual([
      'category',
      'color',
      'id',
      'metalness',
      'name',
      'opacity',
      'roughness',
    ]);
    expect(Object.isFrozen(geometryMaterialPreset('lamp-red')!.emission)).toBe(true);
    // The first preset of a category stays the one a bim material without a preset draws.
    expect(geometryCategoryPreset('glass')?.id).toBe('glass');
    expect(geometryCategoryPreset('metal')?.id).toBe('steel');
  });

  it('keeps the finish the views drew before materials', () => {
    expect(geometryDefaultFinish).toEqual({ roughness: 0.55, metalness: 0.05 });
  });
});
