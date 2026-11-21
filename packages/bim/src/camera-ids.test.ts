import { describe, expect, it } from 'vitest';
import { f31BoxBuilding, validateBim, type BimDocument } from '@editor-platform/bim-core';
import { bimNewId } from './drafting';

describe('#19 camera IDs come from the whole document (Codex on #30)', () => {
  it('skips an entity that already holds camera-1, and new entities skip camera IDs', () => {
    const base = f31BoxBuilding();
    const doc: BimDocument = {
      ...base,
      levels: [{ ...base.levels[0]!, id: 'camera-1' }, ...base.levels.slice(1)],
    };
    const id = bimNewId(doc, 'camera');
    expect(id).toBe('camera-2');
    const withCamera: BimDocument = {
      ...doc,
      cameras: [
        {
          id,
          name: 'Entrance',
          position: [-12_000, -16_000, 9_000],
          target: [0, 0, 1_500],
          up: [0, 0, 1],
          fovDeg: 45,
        },
      ],
    };
    expect(validateBim(withCamera).filter((d) => d.code === 'duplicate-id')).toEqual([]);
    expect(bimNewId(withCamera, 'camera')).toBe('camera-3');
  });
});
