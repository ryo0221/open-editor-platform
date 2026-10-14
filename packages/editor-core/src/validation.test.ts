import { describe, expect, it } from 'vitest';
import { validHierarchy, validVisualStyle } from './validation';

describe('native visual properties', () => {
  it('accepts sparse legacy styles and mixed runs, and rejects malformed nested styles', () => {
    expect(validVisualStyle({})).toBe(true);
    expect(
      validVisualStyle({
        runs: [{ text: '日本語', style: { bold: true, color: '#2563eb' } }],
        crop: { x: -120, y: 0, scale: 2 },
      }),
    ).toBe(true);
    for (const bad of [
      { typography: null },
      { runs: [{ text: 4 }] },
      { runs: [{ text: 'text', style: { fontSize: -1 } }] },
      { crop: { x: 0, y: 0, scale: 0 } },
      { opacity: 2 },
      { rotation: Infinity },
    ])
      expect(validVisualStyle(bad)).toBe(false);
  });
  it('accepts child-first storage while rejecting duplicates, missing parents and cycles', () => {
    expect(validHierarchy([{ id: 'child', parentId: 'root' }, { id: 'root' }])).toBe(true);
    expect(validHierarchy([{ id: 'root' }, { id: 'root' }])).toBe(false);
    expect(validHierarchy([{ id: 'child', parentId: 'gone' }])).toBe(false);
    expect(
      validHierarchy([
        { id: 'a', parentId: 'b' },
        { id: 'b', parentId: 'a' },
      ]),
    ).toBe(false);
  });
});
