import { describe, expect, it } from 'vitest';
import { fmt, fmtGrouped, fmtQuantity } from './dimension-fields';

describe('quantities for reading (ST-85#2)', () => {
  it('groups digits and adds metres for large values, leaving fmt for inputs', () => {
    expect(fmt(69512502320)).toBe('69512502320');
    expect(fmtGrouped(1234567.8916)).toBe('1,234,567.892');
    expect(fmtQuantity(24607.3, 'mm³')).toBe('24,607.3 mm³');
    expect(fmtQuantity(69512502320, 'mm³')).toBe('69,512,502,320 mm³ (69.513 m³)');
    expect(fmtQuantity(297125640.304, 'mm²')).toBe('297,125,640.304 mm² (297.126 m²)');
    expect(fmtQuantity(9999, 'mm')).toBe('9,999 mm');
    expect(fmtQuantity(38000, 'mm')).toBe('38,000 mm (38 m)');
    expect(fmtQuantity(-1e-13, 'mm')).toBe('0 mm');
  });
});
