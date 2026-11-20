import { describe, expect, it } from 'vitest';
import { imageImportLimits, imageImportRefusal } from './export';

describe('image import limits (#22)', () => {
  it('accepts images up to 64 MiB and refuses one byte more, naming the limit', () => {
    expect(imageImportLimits.bytes).toBe(64 * 1024 * 1024);
    expect(imageImportRefusal({ type: 'image/png', size: 40 * 1024 * 1024 })).toBeUndefined();
    expect(
      imageImportRefusal({ type: 'image/jpeg', size: imageImportLimits.bytes }),
    ).toBeUndefined();
    expect(imageImportRefusal({ type: 'image/png', size: imageImportLimits.bytes + 1 })).toBe(
      'Image exceeds 64 MiB (this one is 64.0 MiB)',
    );
    expect(imageImportRefusal({ type: 'image/svg+xml', size: 10 })).toMatch(
      /SVG imports require sanitizing/,
    );
  });
});
