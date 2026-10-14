import { expect, it } from 'vitest';
import { exportColor } from '@editor-platform/export-core';

it('converts native CSS colors without browser defaults or silently substituting unsupported values', () => {
  expect(exportColor('tomato')).toEqual({ hex: 'FF6347', alpha: 1 });
  expect(exportColor('#aBc')).toEqual({ hex: 'AABBCC', alpha: 1 });
  expect(exportColor('#ffffff80')).toEqual({ hex: 'FFFFFF', alpha: 128 / 255 });
  expect(exportColor('rgba(100%, 0%, 0%, 0.5)')).toEqual({ hex: 'FF0000', alpha: 0.5 });
  expect(exportColor('transparent')?.alpha).toBe(0);
  for (const unsupported of ['var(--color)', 'url(secret)', 'red;stroke:black', 'inherit', '#badbadbad']) expect(exportColor(unsupported)).toBeUndefined();
});
