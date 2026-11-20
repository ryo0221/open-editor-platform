import { describe, expect, it } from 'vitest';
import { imageImportLimits, imageImportRefusal } from './export';

describe('image import limits (#22)', () => {
  it('lets a design take images up to 64 MiB and keeps other editors at 16 MiB, naming the limit', () => {
    expect(imageImportLimits.design).toBe(64 * 1024 * 1024);
    expect(imageImportLimits.bytes).toBe(16 * 1024 * 1024);
    const design = imageImportLimits.design;
    expect(
      imageImportRefusal({ type: 'image/png', size: 40 * 1024 * 1024 }, design),
    ).toBeUndefined();
    expect(imageImportRefusal({ type: 'image/jpeg', size: design }, design)).toBeUndefined();
    expect(imageImportRefusal({ type: 'image/png', size: design + 1 }, design)).toBe(
      'Image exceeds 64 MiB (this one is 64.0 MiB)',
    );
    // A slide, board or document keeps both the draft and a version under the Host's 64 MiB record
    expect(imageImportRefusal({ type: 'image/png', size: 40 * 1024 * 1024 })).toBe(
      'Image exceeds 16 MiB (this one is 40.0 MiB)',
    );
    expect(imageImportRefusal({ type: 'image/svg+xml', size: 10 })).toMatch(
      /SVG imports require sanitizing/,
    );
  });
});
