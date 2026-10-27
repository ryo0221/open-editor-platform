import { describe, expect, it } from 'vitest';
import { mermaidWidth } from './previews';

describe('mermaidWidth', () => {
  it('reads the width Mermaid writes in the viewBox', () => {
    expect(mermaidWidth('<svg width="100%" viewBox="-8 -8 2412.5 174" style="">')).toBe(2412.5);
    expect(mermaidWidth('<svg viewBox="0,0,1e3,20">')).toBe(1000);
  });
  it('has no width without a usable viewBox', () => {
    expect(mermaidWidth('<svg width="100%">')).toBeUndefined();
    expect(mermaidWidth('<svg viewBox="0 0 0 10">')).toBeUndefined();
  });
});
