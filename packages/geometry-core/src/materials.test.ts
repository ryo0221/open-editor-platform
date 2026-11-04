import { describe, expect, it } from 'vitest';
import {
  geometryCategoryPreset,
  geometryDefaultFinish,
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

  it('keeps the finish the views drew before materials', () => {
    expect(geometryDefaultFinish).toEqual({ roughness: 0.55, metalness: 0.05 });
  });
});
